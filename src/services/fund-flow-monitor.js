const { formatError } = require("../lib/http");
const { getChinaClock, isWeekdayWindow, minutesOfDay } = require("../models/market/trading-calendar");
const { alertAdmin } = require("./admin-alert");

// 某个时间段内的主力资金异动监控。每个实例对应一个时间段（如尾盘14:30-15:00、开盘09:30-10:00），
// 各自保存当天的起点快照与已推送记录，互不影响：
// 时间段内按 pollMinutes 拉一次主力净流入排行两头，首次成功的快照作为起点；
// 之后某只股票较起点的主力净额变化 ≥ max(minAmount, minRatio × 当日成交额) 即推送，同一方向每天只推一次
const FETCH_FAILURE_ALERT = 3;
const WINDOW_PATTERN = /^(.+)@(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

function toMinutes(hour, minute) {
    return Number(hour) * 60 + Number(minute);
}

function formatMinutes(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// 起点快照：记下两头榜单内股票的主力净额；未上榜股票的起点值只知道范围——
// 不在净流入前列说明 ≤ 净流入榜末位，不在净流出前列说明 ≥ 净流出榜末位，以此估算其变化的下限
function takeBaseline(ranking, minute) {
    const flows = new Map();
    for (const row of [...ranking.inflow, ...ranking.outflow]) flows.set(row.symbol, row.mainNet);
    return {
        minute,
        flows,
        inflowFloor: ranking.inflow.at(-1)?.mainNet ?? 0,
        outflowCeil: ranking.outflow.at(-1)?.mainNet ?? 0
    };
}

// estimated=true 表示起点不在榜单内，delta 是按榜单边界估算的下限（实际变化只会更大）
function detectSurges(baseline, ranking, { minAmount, minRatio }) {
    function pick(rows, sign, bound) {
        return rows
            .map(row => {
                const known = baseline.flows.has(row.symbol);
                return { ...row, delta: row.mainNet - (known ? baseline.flows.get(row.symbol) : bound), estimated: !known };
            })
            .filter(row => sign * row.delta >= Math.max(minAmount, minRatio * row.amount))
            .sort((a, b) => sign * (b.delta - a.delta));
    }
    return {
        inflow: pick(ranking.inflow, 1, baseline.inflowFloor),
        outflow: pick(ranking.outflow, -1, baseline.outflowCeil)
    };
}

class FundFlowMonitor {
    // start/end 为北京时间“HH:MM”；结束分钟包含在内，保证能取到收盘那一刻的数据
    constructor({ label, start, end, pollMinutes = 1, minAmount = 5e7, minRatio = 0.02, maxPerSide = 8 }) {
        this.label = label;
        this.start = FundFlowMonitor.parseTime(start);
        this.end = FundFlowMonitor.parseTime(end);
        if (!label || this.start >= this.end) throw new Error(`资金异动时间段无效：${label}@${start}-${end}`);
        this.pollMinutes = pollMinutes;
        this.thresholds = { minAmount, minRatio };
        this.maxPerSide = maxPerSide;
        this.state = FundFlowMonitor.newState();
    }

    static newState(date = "") {
        return { date, lastSlot: null, trading: null, baseline: null, alerted: new Set(), failures: 0 };
    }

    static parseTime(text) {
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
        if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`时间格式应为HH:MM：${text}`);
        return toMinutes(match[1], match[2]);
    }

    // “尾盘@14:30-15:00,开盘@09:30-10:00” → 多个时间段的构造参数
    static parseWindows(text) {
        return String(text || "").split(/[,，]/).map(item => item.trim()).filter(Boolean).map(item => {
            const match = WINDOW_PATTERN.exec(item);
            if (!match) throw new Error(`资金异动时间段格式应为“名称@HH:MM-HH:MM”：${item}`);
            return { label: match[1].trim(), start: `${match[2]}:${match[3]}`, end: `${match[4]}:${match[5]}` };
        });
    }

    get startText() { return formatMinutes(this.start); }
    get endText() { return formatMinutes(this.end); }

    isActive(now = new Date()) {
        return isWeekdayWindow(now, this.start, this.end + 1);
    }

    // deps：fundFlow（getRanking）、isTradingDay、listSubscribers、listWatchSymbols、
    // prepare（由推送内容生成 send(chatId, watchSymbols)，图片只生成一次供所有订阅者共用）、
    // isBotBlocked、deactivateSubscriber、alertContext（管理员告警）
    async tick(now, deps) {
        if (!this.isActive(now)) return { action: "outside-window" };
        const { dateStr } = getChinaClock(now);
        if (this.state.date !== dateStr) this.state = FundFlowMonitor.newState(dateStr);
        const minute = minutesOfDay(now);
        const slot = Math.floor((minute - this.start) / this.pollMinutes);
        if (slot === this.state.lastSlot) return { action: "waiting" };
        this.state.lastSlot = slot;

        const subscribers = await deps.listSubscribers();
        if (!subscribers.length) return { action: "not-due" };
        // 每天只判断一次交易日；节假日接口失败时按交易日处理
        if (!this.state.trading) {
            this.state.trading = await deps.isTradingDay(now).catch(() => ({ ok: true, verified: false }));
        }
        if (!this.state.trading.ok) return { action: "outside-window", reason: this.state.trading.reason };

        let ranking;
        try {
            ranking = await deps.fundFlow.getRanking();
        } catch (error) {
            this.state.failures++;
            console.error(`⚠️ ${this.label}资金流排行获取失败：${formatError(error)}`);
            if (this.state.failures === FETCH_FAILURE_ALERT) {
                await alertAdmin({ ...deps.alertContext, dateStr }, {
                    key: `${dateStr}:fund-flow-${this.label}`,
                    text: `⚠️ ${this.label}资金异动：东方财富资金流排行连续${FETCH_FAILURE_ALERT}次获取失败（${formatError(error)}）。`
                });
            }
            return { action: "fetch-failed" };
        }
        this.state.failures = 0;
        if (!this.state.baseline) {
            this.state.baseline = takeBaseline(ranking, minute);
            return { action: "waiting", baseline: formatMinutes(minute) };
        }

        const surges = detectSurges(this.state.baseline, ranking, this.thresholds);
        const fresh = (rows, side) => rows.filter(row => !this.state.alerted.has(`${side}:${row.symbol}`)).slice(0, this.maxPerSide);
        const inflow = fresh(surges.inflow, "in");
        const outflow = fresh(surges.outflow, "out");
        if (!inflow.length && !outflow.length) return { action: "waiting" };
        inflow.forEach(row => this.state.alerted.add(`in:${row.symbol}`));
        outflow.forEach(row => this.state.alerted.add(`out:${row.symbol}`));

        const content = {
            label: this.label,
            time: formatMinutes(minute),
            since: formatMinutes(this.state.baseline.minute),
            inflow,
            outflow
        };
        const send = deps.prepare(content);
        const totals = { delivered: 0, failed: 0, deactivated: 0 };
        for (const subscriber of subscribers) {
            const chatId = subscriber.chat_id;
            try {
                await send(chatId, await deps.listWatchSymbols(chatId));
                totals.delivered++;
            } catch (error) {
                if (deps.isBotBlocked(error)) {
                    await deps.deactivateSubscriber(chatId).catch(() => {});
                    totals.deactivated++;
                } else {
                    console.error(`⚠️ 向${chatId}推送${this.label}资金异动失败：${formatError(error)}`);
                    totals.failed++;
                }
            }
        }
        return { action: "processed", window: this.label, inflow: inflow.length, outflow: outflow.length, ...totals };
    }
}

module.exports = { FundFlowMonitor, detectSurges, takeBaseline };
