const test = require("node:test");
const assert = require("node:assert/strict");
const { createMarketSnapshotService, parseSinaList, parseSseList } = require("../../src/models/market/market-snapshot");
const { VolumeSpikeMonitor, detectSpikes } = require("../../src/services/volume-spike-monitor");
const { createVolumeSpikeMonitors } = require("../../src/controllers/volume-spike-controller");
const { generateVolumeSpikeChart } = require("../../src/views/charts/volume-spike-chart");
const { formatVolumeSpikeAlert, formatVolumeSpikeCaption } = require("../../src/views/volume-spike-view");

// 北京时间 = UTC + 8；2026-10-28 是周三
const at = hhmm => {
    const [hour, minute] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(2026, 9, 28, hour - 8, minute));
};
const stock = (symbol, changePct, amount, name = `股${symbol}`) => ({ symbol, name, price: 10, changePct, amount });

test("解析上交所与新浪行情：停牌（价格为0）与非6位代码剔除", () => {
    assert.deepEqual(parseSseList({ list: [["600000", "浦发银行", 9.85, 0.31, 637219509, 64727635], ["600001", "停牌", 0, 0, 0, 0]] }), [
        { symbol: "600000", name: "浦发银行", price: 9.85, changePct: 0.31, amount: 637219509 }
    ]);
    assert.deepEqual(parseSinaList(JSON.stringify([
        { code: "000001", name: "平安银行", trade: "11.310", changepercent: -1.395, amount: 1911547804 },
        { code: "000002", name: "停牌", trade: "0.000", changepercent: 0, amount: 0 }
    ])), [{ symbol: "000001", name: "平安银行", price: 11.31, changePct: -1.395, amount: 1911547804 }]);
    assert.deepEqual(parseSinaList("null"), []);
});

test("全市场快照：沪市取上交所一次请求，深市按新浪总数分页拉取；一边失败时只返回另一边并给出原因", async () => {
    const urls = [];
    const client = sinaDown => ({
        async get(url, { params }) {
            urls.push(`${url.split("/").pop()}${params.page ? `#${params.page}` : ""}`);
            if (url.includes("sse.com.cn")) return { data: { list: [["600000", "浦发银行", 9.85, 0.31, 6e8]] } };
            if (sinaDown) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
            if (url.includes("getHQNodeStockCount")) return { data: "\"150\"" };
            return { data: [{ code: `00000${params.page}`, name: "深股", trade: "10", changepercent: 1, amount: 1e8 }] };
        }
    });
    const ok = await createMarketSnapshotService({ httpClient: client(false), requestWithRetry: fn => fn() }).getSnapshot();
    assert.deepEqual(ok.sources, { "上交所": 1, "新浪": 2 });
    assert.deepEqual(ok.errors, []);
    assert.ok(urls.includes("Market_Center.getHQNodeData#1") && urls.includes("Market_Center.getHQNodeData#2"), "150只分2页");

    const partial = await createMarketSnapshotService({ httpClient: client(true), requestWithRetry: fn => fn() }).getSnapshot();
    assert.deepEqual(partial.sources, { "上交所": 1 });
    assert.match(partial.errors[0], /^新浪：/);
});

test("判定：回看时段内成交额与涨跌幅变化同时达到门槛；回看快照里没有的股票不比较", () => {
    const previous = new Map([["A", stock("A", 1, 1e8)], ["B", stock("B", 1, 1e8)], ["C", stock("C", 3, 2e8)], ["D", stock("D", 0, 1e8)]]);
    const spikes = detectSpikes(previous, [
        stock("A", 3.5, 1.6e8), // +2.5个百分点，成交6000万 → 急涨
        stock("B", 3.5, 1.3e8), // 成交3000万，未达门槛
        stock("C", 0.5, 3e8), // -2.5个百分点，成交1亿 → 急跌
        stock("D", 1.5, 3e8), // 成交2亿但只涨1.5个百分点
        stock("E", 9, 9e8) // 回看快照里没有
    ], { minAmount: 5e7, minChangePct: 2 });
    assert.deepEqual(spikes.up.map(row => [row.symbol, row.windowChange, row.windowAmount]), [["A", 2.5, 6e7]]);
    assert.deepEqual(spikes.down.map(row => [row.symbol, row.windowChange]), [["C", -2.5]]);
});

test("时间段参数：默认避开午休与深市收盘集合竞价", () => {
    const [am, pm] = createVolumeSpikeMonitors({ windows: "上午@09:30-11:30,下午@13:00-14:57", lookbackMinutes: 5, minAmount: 1, minChangePct: 1 });
    assert.equal(am.isActive(at("09:29")), false);
    assert.equal(am.isActive(at("11:30")), true);
    assert.equal(am.isActive(at("12:00")), false);
    assert.equal(pm.isActive(at("14:57")), true);
    assert.equal(pm.isActive(at("14:58")), false);
});

function setup({ snapshots, store = new Map(), sendError } = {}) {
    const calls = { messages: [], alerts: [], fetches: 0, records: [] };
    const deps = {
        snapshot: {
            async getSnapshot() {
                const rows = snapshots[Math.min(calls.fetches++, snapshots.length - 1)];
                if (rows instanceof Error) throw rows;
                return { rows, sources: { "上交所": rows.length }, errors: [] };
            }
        },
        async isTradingDay() { return { ok: true }; },
        async listSubscribers() { return [{ chat_id: "100" }, { chat_id: "200" }]; },
        async listWatchSymbols(chatId) { return new Set(chatId === "100" ? ["A"] : []); },
        prepare: content => async (chatId, watchSymbols) => {
            const error = sendError && sendError(chatId);
            if (error) throw error;
            calls.messages.push({ chatId, content, text: formatVolumeSpikeCaption({ ...content, watchSymbols }) });
        },
        isBotBlocked: error => error?.response?.status === 403,
        async deactivateSubscriber() {},
        alertContext: { adminChatId: "admin", alerted: new Set(), notify: async (_chatId, text) => calls.alerts.push(text) },
        async loadState(date, label) { return store.has(`${date}:${label}`) ? JSON.parse(store.get(`${date}:${label}`)) : null; },
        async saveState(date, label, state) { store.set(`${date}:${label}`, JSON.stringify(state)); },
        async recordAlert(date, label, content) { calls.records.push({ date, label, content }); }
    };
    return { calls, deps, store, monitor: new VolumeSpikeMonitor({ label: "上午", start: "09:30", end: "11:30", lookbackMinutes: 5 }) };
}

test("监控流程：攒满回看时长后比较；推送急涨/急跌放量，同一股票不重复；重启后从库里恢复已推送股票", async () => {
    const quiet = [stock("A", 1, 1e8), stock("B", -1, 1e8)];
    const spiked = [stock("A", 4, 2e8), stock("B", -4, 2e8)];
    const { calls, deps, store, monitor } = setup({ snapshots: [quiet, quiet, quiet, quiet, quiet, spiked, spiked] });
    for (const time of ["09:30", "09:31", "09:32", "09:33", "09:34"]) {
        assert.equal((await monitor.tick(at(time), deps)).action, "waiting", "回看快照不足5分钟时只收集");
    }
    assert.deepEqual(await monitor.tick(at("09:34"), deps), { action: "waiting" }, "同一分钟不重复拉取");
    const result = await monitor.tick(at("09:35"), deps);
    assert.equal(result.action, "processed");
    assert.equal(result.delivered, 2);
    const [first, second] = calls.messages;
    assert.equal(first.content.since, "09:30");
    assert.match(first.text, /⚡ 上午量价异动｜09:35<\/b>\n近5分钟：急涨放量1只、急跌放量1只/);
    assert.match(first.text, /🔺 急涨放量<\/b>\n⭐<a [^>]+>股A<\/a> <b>\+3\.00%<\/b> 成交1\.00亿/);
    assert.match(first.text, /🔻 急跌放量<\/b>\n<a [^>]+>股B<\/a> <b>-3\.00%<\/b>/);
    assert.match(first.text, /沪市：上交所行情/);
    assert.doesNotMatch(second.text, /⭐/);
    assert.deepEqual(calls.records.map(r => r.label), ["量价:上午"], "推送记录存库，与资金异动区分");

    assert.deepEqual(await monitor.tick(at("09:36"), deps), { action: "waiting" }, "已推送过的股票不再推送");

    // 部署重启：快照要重新攒，但已推送的股票从库里恢复
    const restarted = setup({ snapshots: [quiet, quiet, quiet, quiet, quiet, spiked], store });
    for (const time of ["09:40", "09:41", "09:42", "09:43", "09:44"]) await restarted.monitor.tick(at(time), restarted.deps);
    assert.deepEqual(await restarted.monitor.tick(at("09:45"), restarted.deps), { action: "waiting" });
    assert.equal(restarted.calls.messages.length, 0, "重启后不重复推送");
});

test("监控流程：个别分钟拉取失败时，用更早一点的快照回看；连续3次失败提醒管理员一次", async () => {
    const quiet = [stock("A", 1, 1e8)];
    const spiked = [stock("A", 4, 2e8)];
    const { calls, deps, monitor } = setup({ snapshots: [quiet, new Error("down"), quiet, quiet, quiet, quiet, spiked] });
    for (const time of ["09:30", "09:31", "09:32", "09:33", "09:34", "09:35"]) await monitor.tick(at(time), deps);
    const result = await monitor.tick(at("09:36"), deps);
    assert.equal(result.action, "processed", "09:31失败，回看用09:30的快照");
    assert.equal(calls.messages[0].content.since, "09:30");
    assert.equal(calls.messages[0].content.minutes, 6);

    const down = setup({ snapshots: [new Error("socket hang up")] });
    for (const time of ["09:30", "09:31", "09:32", "09:33"]) await down.monitor.tick(at(time), down.deps);
    assert.equal(down.calls.alerts.length, 1);
    assert.match(down.calls.alerts[0], /上午量价异动.*连续3次/);
});

test("量价异动推送：文字版附当日涨跌幅，图表生成有效PNG并注明数据来源", () => {
    const content = {
        label: "上午", time: "10:05", since: "10:00", minutes: 5, sources: { "上交所": 2300, "新浪": 2900 },
        up: [{ ...stock("600000", 5.2, 3e8, "浦发银行"), windowChange: 2.6, windowAmount: 1.2e8 }],
        down: [{ ...stock("000001", -4.1, 2e8, "平 安 银 行"), windowChange: -2.2, windowAmount: 6.5e7 }]
    };
    const text = formatVolumeSpikeAlert(content);
    assert.match(text, /浦发银行<\/a> <b>\+2\.60%<\/b> 成交1\.20亿（现\+5\.20%）/);
    assert.match(text, /平安银行<\/a> <b>-2\.20%<\/b> 成交6500万（现-4\.10%）/, "名称去掉补齐空格");
    assert.match(text, /沪市：上交所行情，深市：新浪财经行情/);
    assert.equal(generateVolumeSpikeChart(content).subarray(1, 4).toString(), "PNG");
});
