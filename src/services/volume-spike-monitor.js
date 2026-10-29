const { formatError } = require("../lib/http");
const { getChinaClock, isWeekdayWindow, minutesOfDay } = require("../models/market/trading-calendar");
const { alertAdmin } = require("./admin-alert");
const { FundFlowMonitor } = require("./fund-flow-monitor");

// 量价异动监控：某个时间段内每分钟取一次全市场快照，与 lookbackMinutes 分钟前的快照比较，
// 这段时间的成交额 ≥ minAmount 且涨跌幅变化 ≥ minChangePct（个百分点）即为急涨/急跌放量。
// 发现的股票先攒着，每 pushMinutes 分钟（从时间段开始对齐，时间段结束时也推一次）汇总推送，同一方向每天只推一次。
// 快照只保存在内存中（重启后等满回看时长再开始比较）；已推送与待推送的股票存库，重启后不重复、不漏推
const FETCH_FAILURE_ALERT = 3;

function formatMinutes(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// 当前快照与回看快照比较；回看快照里没有的股票（如上一轮该市场拉取失败）不参与比较
function detectSpikes(previous, current, { minAmount, minChangePct }) {
    const spikes = { up: [], down: [] };
    for (const row of current) {
        const before = previous.get(row.symbol);
        if (!before) continue;
        const windowAmount = row.amount - before.amount;
        const windowChange = row.changePct - before.changePct;
        if (windowAmount < minAmount || Math.abs(windowChange) < minChangePct) continue;
        (windowChange > 0 ? spikes.up : spikes.down).push({ ...row, windowAmount, windowChange });
    }
    spikes.up.sort((a, b) => b.windowChange - a.windowChange);
    spikes.down.sort((a, b) => a.windowChange - b.windowChange);
    return spikes;
}

class VolumeSpikeMonitor {
    constructor({ label, start, end, lookbackMinutes = 5, pushMinutes = 10, minAmount = 5e7, minChangePct = 2, maxPerSide = 8 }) {
        this.label = label;
        this.start = FundFlowMonitor.parseTime(start);
        this.end = FundFlowMonitor.parseTime(end);
        if (!label || this.start >= this.end) throw new Error(`量价异动时间段无效：${label}@${start}-${end}`);
        this.lookbackMinutes = lookbackMinutes;
        this.pushMinutes = pushMinutes;
        this.thresholds = { minAmount, minChangePct };
        this.maxPerSide = maxPerSide;
        this.state = VolumeSpikeMonitor.newState();
    }

    static newState(date = "") {
        return { date, lastMinute: null, snapshots: new Map(), alerted: new Set(), pending: new Map(), pushSlot: null, failures: 0, trading: null };
    }

    // 存库与资金异动共用表，以“量价:时间段”区分
    get storageLabel() {
        return `量价:${this.label}`;
    }

    // 结束分钟包含在内
    isActive(now = new Date()) {
        return isWeekdayWindow(now, this.start, this.end + 1);
    }

    async restore(deps, dateStr) {
        if (!deps.loadState) return;
        const saved = await deps.loadState(dateStr, this.storageLabel).catch(error => {
            console.error(`⚠️ 读取${this.label}量价异动状态失败：${formatError(error)}`);
            return null;
        });
        if (!saved) return;
        this.state.alerted = new Set(saved.alerted || []);
        this.state.pending = new Map(saved.pending || []);
    }

    async persist(deps) {
        if (!deps.saveState) return;
        await deps.saveState(this.state.date, this.storageLabel, { alerted: [...this.state.alerted], pending: [...this.state.pending] })
            .catch(error => console.error(`⚠️ 保存${this.label}量价异动状态失败：${formatError(error)}`));
    }

    // 回看快照：lookbackMinutes 分钟前（或更早一点，容忍个别分钟拉取失败）最近的一次
    lookbackSnapshot(minute) {
        const target = minute - this.lookbackMinutes;
        for (let m = target; m >= Math.max(this.start, target - 3); m--) {
            if (this.state.snapshots.has(m)) return { minute: m, rows: this.state.snapshots.get(m) };
        }
        return null;
    }

    // 推送时点：从时间段开始每 pushMinutes 分钟一个，返回所在时点的序号
    pushSlot(minute) {
        return Math.floor((minute - this.start) / this.pushMinutes);
    }

    // 新发现的股票攒进待推送；汇总期内同一只股票多次触发时保留变化最大的一次
    collect(spikes, minute, previousMinute) {
        let added = false;
        for (const [side, rows] of [["up", spikes.up], ["down", spikes.down]]) {
            for (const row of rows) {
                const key = `${side}:${row.symbol}`;
                if (this.state.alerted.has(key)) continue;
                const held = this.state.pending.get(key);
                if (held && Math.abs(held.windowChange) >= Math.abs(row.windowChange)) continue;
                this.state.pending.set(key, { ...row, time: formatMinutes(minute), minutes: minute - previousMinute });
                added = true;
            }
        }
        return added;
    }

    // deps：snapshot（getSnapshot）、isTradingDay、listSubscribers、listWatchSymbols、prepare、isBotBlocked、
    // deactivateSubscriber、alertContext；可选 loadState/saveState、recordAlert
    async tick(now, deps) {
        if (!this.isActive(now)) return { action: "outside-window" };
        const { dateStr } = getChinaClock(now);
        if (this.state.date !== dateStr) {
            this.state = VolumeSpikeMonitor.newState(dateStr);
            await this.restore(deps, dateStr);
        }
        const minute = minutesOfDay(now);
        if (minute === this.state.lastMinute) return { action: "waiting" };
        this.state.lastMinute = minute;
        // 当天第一次运行（含重启）以所在时点为起点，不立即补推
        if (this.state.pushSlot === null) this.state.pushSlot = this.pushSlot(minute);

        const subscribers = await deps.listSubscribers();
        if (!subscribers.length) return { action: "not-due" };
        if (!this.state.trading) {
            this.state.trading = await deps.isTradingDay(now).catch(() => ({ ok: true, verified: false }));
        }
        if (!this.state.trading.ok) return { action: "outside-window", reason: this.state.trading.reason };

        let snapshot;
        try {
            snapshot = await deps.snapshot.getSnapshot();
        } catch (error) {
            this.state.failures++;
            console.error(`⚠️ ${this.label}量价异动行情快照获取失败：${formatError(error)}`);
            if (this.state.failures === FETCH_FAILURE_ALERT) {
                await alertAdmin({ ...deps.alertContext, dateStr }, {
                    key: `${dateStr}:volume-spike-${this.label}`,
                    text: `⚠️ ${this.label}量价异动：全市场行情快照连续${FETCH_FAILURE_ALERT}次获取失败（${formatError(error)}）。`
                });
            }
            return { action: "fetch-failed" };
        }
        this.state.failures = 0;
        if (snapshot.errors.length) console.error(`⚠️ ${this.label}量价异动部分行情缺失：${snapshot.errors.join("；")}`);

        this.state.snapshots.set(minute, new Map(snapshot.rows.map(row => [row.symbol, row])));
        for (const kept of this.state.snapshots.keys()) {
            if (kept < minute - this.lookbackMinutes - 3) this.state.snapshots.delete(kept);
        }
        // 回看快照不够时只收集，但已攒下的照常按时点推送
        const previous = this.lookbackSnapshot(minute);
        const added = previous ? this.collect(detectSpikes(previous.rows, snapshot.rows, this.thresholds), minute, previous.minute) : false;
        const slot = this.pushSlot(minute);
        const due = slot > this.state.pushSlot || minute >= this.end;
        const sinceMinute = this.start + this.state.pushSlot * this.pushMinutes;
        // 到了时点即使没有可推的也算过了这个时点，之后发现的等下一个时点
        if (due) this.state.pushSlot = slot;
        if (!due || !this.state.pending.size) {
            if (added) await this.persist(deps);
            return { action: "waiting", pending: this.state.pending.size };
        }

        // 每个方向按变化幅度取前 maxPerSide 只推送；没排上的不记为已推送，之后再触发还能推
        const pending = [...this.state.pending.entries()];
        const pick = side => pending.filter(([key]) => key.startsWith(`${side}:`)).map(([, row]) => row)
            .sort((a, b) => Math.abs(b.windowChange) - Math.abs(a.windowChange));
        const allUp = pick("up");
        const allDown = pick("down");
        const up = allUp.slice(0, this.maxPerSide);
        const down = allDown.slice(0, this.maxPerSide);
        up.forEach(row => this.state.alerted.add(`up:${row.symbol}`));
        down.forEach(row => this.state.alerted.add(`down:${row.symbol}`));
        this.state.pending.clear();
        await this.persist(deps);

        const content = {
            label: this.label,
            time: formatMinutes(minute),
            since: formatMinutes(sinceMinute),
            lookbackMinutes: this.lookbackMinutes,
            sources: snapshot.sources,
            upTotal: allUp.length,
            downTotal: allDown.length,
            up,
            down
        };
        const send = deps.prepare(content);
        const totals = { delivered: 0, failed: 0, deactivated: 0 };
        for (const subscriber of subscribers) {
            const chatId = subscriber.chat_id;
            try {
                await send(chatId, await deps.listWatchSymbols(chatId), subscriber.quote_app);
                totals.delivered++;
            } catch (error) {
                if (deps.isBotBlocked(error)) {
                    await deps.deactivateSubscriber(chatId).catch(() => {});
                    totals.deactivated++;
                } else {
                    console.error(`⚠️ 向${chatId}推送${this.label}量价异动失败：${formatError(error)}`);
                    totals.failed++;
                }
            }
        }
        if (deps.recordAlert) {
            await deps.recordAlert(dateStr, this.storageLabel, { ...content, totals })
                .catch(error => console.error(`⚠️ 保存${this.label}量价异动推送记录失败：${formatError(error)}`));
        }
        return { action: "processed", window: this.label, up: up.length, down: down.length, ...totals };
    }
}

module.exports = { VolumeSpikeMonitor, detectSpikes };
