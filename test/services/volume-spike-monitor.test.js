const test = require("node:test");
const assert = require("node:assert/strict");
const { createMarketSnapshotService, parseSinaList, parseSseList } = require("../../src/models/market/market-snapshot");
const { VolumeSpikeMonitor, detectSpikes } = require("../../src/services/volume-spike-monitor");
const { createVolumeSpikeMonitors } = require("../../src/controllers/volume-spike-controller");
const { generateVolumeSpikeChart } = require("../../src/views/charts/volume-spike-chart");
const { formatVolumeSpikeAlert, formatVolumeSpikeCaption, volumeSpikeKeyboard } = require("../../src/views/volume-spike-view");

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
            calls.messages.push({ chatId, content, text: formatVolumeSpikeAlert({ ...content, watchSymbols }) });
        },
        isBotBlocked: error => error?.response?.status === 403,
        async deactivateSubscriber() {},
        alertContext: { adminChatId: "admin", alerted: new Set(), notify: async (_chatId, text) => calls.alerts.push(text) },
        async loadState(date, label) { return store.has(`${date}:${label}`) ? JSON.parse(store.get(`${date}:${label}`)) : null; },
        async saveState(date, label, state) { store.set(`${date}:${label}`, JSON.stringify(state)); },
        async recordAlert(date, label, content) { calls.records.push({ date, label, content }); }
    };
    return { calls, deps, store, monitor: new VolumeSpikeMonitor({ label: "上午", start: "09:30", end: "11:30", lookbackMinutes: 5, pushMinutes: 15 }) };
}

test("监控流程：攒满回看时长后比较；发现的股票攒到15分钟时点汇总推送，同一股票不重复；重启后从库里恢复", async () => {
    const quiet = [stock("A", 1, 1e8), stock("B", -1, 1e8)];
    const upA = [stock("A", 4, 2e8), stock("B", -1, 1e8)];
    const bothMove = [stock("A", 5, 3e8), stock("B", -4, 2e8)];
    const { calls, deps, store, monitor } = setup({ snapshots: [quiet, quiet, quiet, quiet, quiet, upA, upA, quiet, quiet, quiet, bothMove] });
    for (const time of ["09:30", "09:31", "09:32", "09:33", "09:34"]) {
        assert.equal((await monitor.tick(at(time), deps)).action, "waiting", "回看快照不足5分钟时只收集");
    }
    assert.deepEqual(await monitor.tick(at("09:34"), deps), { action: "waiting" }, "同一分钟不重复拉取");
    assert.deepEqual(await monitor.tick(at("09:35"), deps), { action: "waiting", pending: 1 }, "发现A，攒着不推");
    assert.equal(calls.messages.length, 0);

    // 部署重启：待推送的A从库里恢复，到时点照样推
    const restarted = setup({ snapshots: [quiet, quiet, quiet, quiet, quiet, bothMove], store });
    for (const time of ["09:40", "09:41", "09:42", "09:43", "09:44"]) await restarted.monitor.tick(at(time), restarted.deps);
    const result = await restarted.monitor.tick(at("09:45"), restarted.deps);
    assert.equal(result.action, "processed");
    assert.equal(result.delivered, 2);
    const [first, second] = restarted.calls.messages;
    assert.deepEqual([first.content.since, first.content.time], ["09:30", "09:45"]);
    assert.match(first.text, /⚡ 上午量价异动｜09:30-09:45<\/b>\n\n<b>🔺 急涨放量<\/b> 1只\n<code>09:45<\/code> ⭐<a [^>]+>股A<\/a> <b>\+4\.00%<\/b> 成交2\.00亿 今日\+5\.00%\n/, "同一只股票保留变化最大的一次");
    assert.match(first.text, /🔻 急跌放量<\/b> 1只\n<code>09:45<\/code> <a [^>]+>股B<\/a> <b>-3\.00%<\/b>/);
    assert.doesNotMatch(second.text, /⭐/);
    assert.deepEqual(restarted.calls.records.map(r => r.label), ["量价:上午"], "推送记录存库，与资金异动区分");

    const again = setup({ snapshots: [quiet, quiet, quiet, quiet, quiet, bothMove], store });
    for (const time of ["09:55", "09:56", "09:57", "09:58", "09:59", "10:00"]) await again.monitor.tick(at(time), again.deps);
    assert.equal(again.calls.messages.length, 0, "已推送过的股票不再推送");
});

test("监控流程：时点之间新发现的股票等下一个时点；时间段结束时把剩下的推掉；超过上限只推前几只", async () => {
    const quiet = [stock("A", 1, 1e8), stock("B", 1, 1e8), stock("C", 1, 1e8)];
    const moved = [stock("A", 4, 2e8), stock("B", 5, 2e8), stock("C", 6, 2e8)];
    const { calls, deps, monitor } = setup({ snapshots: [quiet, quiet, quiet, quiet, quiet, quiet, quiet, quiet, quiet, moved] });
    monitor.maxPerSide = 2;
    for (const time of ["11:09", "11:10", "11:11", "11:12", "11:13", "11:14", "11:15", "11:16", "11:17", "11:18"]) await monitor.tick(at(time), deps);
    assert.equal(calls.messages.length, 0, "11:15时点没有可推的，之后发现的等11:30");
    const result = await monitor.tick(at("11:30"), deps);
    assert.equal(result.action, "processed");
    const { content, text } = calls.messages[0];
    assert.deepEqual(content.up.map(row => row.symbol), ["C", "B"]);
    assert.equal(content.since, "11:15");
    assert.match(text, /股C.*\n.*股B/);
    assert.doesNotMatch(text, /股A/);
});

test("监控流程：个别分钟拉取失败时，用更早一点的快照回看；连续3次失败提醒管理员一次", async () => {
    const quiet = [stock("A", 1, 1e8)];
    const spiked = [stock("A", 4, 2e8)];
    const { calls, deps, monitor } = setup({ snapshots: [quiet, new Error("down"), quiet, quiet, quiet, quiet, spiked] });
    monitor.pushMinutes = 1;
    for (const time of ["09:30", "09:31", "09:32", "09:33", "09:34", "09:35"]) await monitor.tick(at(time), deps);
    const result = await monitor.tick(at("09:36"), deps);
    assert.equal(result.action, "processed", "09:31失败，回看用09:30的快照");
    assert.equal(calls.messages[0].content.up[0].minutes, 6);

    const down = setup({ snapshots: [new Error("socket hang up")] });
    for (const time of ["09:30", "09:31", "09:32", "09:33"]) await down.monitor.tick(at(time), down.deps);
    assert.equal(down.calls.alerts.length, 1);
    assert.match(down.calls.alerts[0], /上午量价异动.*连续3次/);
});

test("量价异动推送：文字版每行含触发时间、变化、成交额与当日涨跌幅，超过上限注明只列前几只；图片说明只有标题，股票在按钮里", () => {
    const content = {
        label: "上午", time: "10:15", since: "10:00", lookbackMinutes: 5, sources: { "上交所": 2300, "新浪": 2900 }, upTotal: 3, downTotal: 1,
        up: [{ ...stock("600000", 5.2, 3e8, "浦发银行"), windowChange: 2.6, windowAmount: 1.2e8, time: "10:05" }],
        down: [{ ...stock("000001", -4.1, 2e8, "平安银行"), windowChange: -2.2, windowAmount: 6.5e7, time: "10:12" }]
    };
    const text = formatVolumeSpikeAlert(content);
    assert.match(text, /🔺 急涨放量<\/b> 3只（列前1）\n<code>10:05<\/code> <a [^>]+>浦发银行<\/a> <b>\+2\.60%<\/b> 成交1\.20亿 今日\+5\.20%/);
    assert.match(text, /🔻 急跌放量<\/b> 1只\n<code>10:12<\/code> <a [^>]+>平安银行<\/a> <b>-2\.20%<\/b> 成交6500万 今日-4\.10%/);
    assert.match(text, /沪市上交所、深市新浪财经/);

    const caption = formatVolumeSpikeCaption(content);
    assert.match(caption, /^<b>⚡ 上午量价异动｜10:00-10:15<\/b>\n<i>点下方按钮打开东方财富。\/spike off 关闭提醒<\/i>$/);
    const keyboard = volumeSpikeKeyboard({ ...content, watchSymbols: new Set(["000001"]) });
    assert.deepEqual(keyboard.inline_keyboard.map(row => row.map(button => button.text)), [["📈浦发银行", "📉平安银行⭐"]]);
    assert.equal(generateVolumeSpikeChart(content).subarray(1, 4).toString(), "PNG");
});
