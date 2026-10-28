const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFlowRows } = require("../../src/models/market/fund-flow");
const { FundFlowMonitor, detectSurges, takeBaseline } = require("../../src/services/fund-flow-monitor");
const { createMonitors, prepareDelivery } = require("../../src/controllers/fund-flow-controller");
const { generateFundFlowChart } = require("../../src/views/charts/fund-flow-chart");
const { formatFundFlowAlert, formatFundFlowCaption, formatFundFlowKeyboard } = require("../../src/views/fund-flow-view");

// 北京时间 = UTC + 8；2026-10-28 是周三
const at = hhmm => {
    const [hour, minute] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(2026, 9, 28, hour - 8, minute));
};
const row = (symbol, mainNet, amount = 1e9, extra = {}) => ({ symbol, name: `股${symbol}`, changePct: 1, amount, mainNet, mainRatio: 5, ...extra });
const ranking = (inflow, outflow) => ({ inflow, outflow, size: inflow.length });

test("解析资金流排行：字段映射，停牌股（字段为“-”）剔除", () => {
    const rows = parseFlowRows({ data: { diff: [
        { f12: "300308", f14: "中际旭创", f2: 619.73, f3: 7.41, f6: 13278635375.3, f62: 1608405824, f184: 12.11, f66: 1309660816, f72: 298745008 },
        { f12: "000001", f14: "停牌股", f2: "-", f3: "-", f6: "-", f62: "-", f184: "-", f66: "-", f72: "-" }
    ] } });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
        symbol: "300308", name: "中际旭创", price: 619.73, changePct: 7.41, amount: 13278635375.3,
        mainNet: 1608405824, mainRatio: 12.11, superNet: 1309660816, bigNet: 298745008
    });
});

test("时间段参数：解析“名称@HH:MM-HH:MM”，结束分钟包含在内，格式错误时报错", () => {
    assert.deepEqual(FundFlowMonitor.parseWindows("尾盘@14:30-15:00，开盘@9:30-10:00"), [
        { label: "尾盘", start: "14:30", end: "15:00" },
        { label: "开盘", start: "9:30", end: "10:00" }
    ]);
    assert.throws(() => FundFlowMonitor.parseWindows("尾盘14:30-15:00"), /格式/);
    assert.throws(() => new FundFlowMonitor({ label: "越界", start: "14:30", end: "25:00" }), /HH:MM/);
    assert.throws(() => new FundFlowMonitor({ label: "反了", start: "15:00", end: "14:30" }), /无效/);
    const [tail, open] = createMonitors({ windows: "尾盘@14:30-15:00,开盘@09:30-10:00", pollMinutes: 2, minAmount: 1, minRatio: 0 });
    assert.equal(tail.startText, "14:30");
    assert.equal(open.endText, "10:00");
    assert.equal(tail.pollMinutes, 2);
    assert.equal(tail.isActive(at("14:29")), false);
    assert.equal(tail.isActive(at("15:00")), true);
    assert.equal(tail.isActive(at("15:01")), false);
    assert.equal(tail.isActive(new Date(Date.UTC(2026, 9, 31, 6, 40))), false, "周六不运行");
});

test("异动判定：金额与占成交额比例两个门槛都要达到；起点不在榜内时按榜单边界估算", () => {
    const baseline = takeBaseline(ranking([row("A", 3e8), row("B", 1e8)], [row("C", -2e8), row("D", -5e7)]), 870);
    assert.equal(baseline.inflowFloor, 1e8);
    assert.equal(baseline.outflowCeil, -5e7);
    const surges = detectSurges(baseline, ranking(
        [row("A", 4e8, 1e9), row("E", 2e8, 1e9), row("B", 1.4e8, 1e10)],
        [row("C", -3e8, 1e9), row("F", -1.2e8, 1e9)]
    ), { minAmount: 5e7, minRatio: 0.02 });
    // A：+1亿 达标；E：未在起点榜单，按边界1亿估算 ≥+1亿；B：+4000万，未达金额门槛
    assert.deepEqual(surges.inflow.map(r => [r.symbol, r.delta, r.estimated]), [["A", 1e8, false], ["E", 1e8, true]]);
    assert.deepEqual(surges.outflow.map(r => [r.symbol, r.delta, r.estimated]), [["C", -1e8, false], ["F", -7e7, true]]);

    const strict = detectSurges(baseline, ranking([row("A", 4e8, 1e10)], []), { minAmount: 5e7, minRatio: 0.02 });
    assert.equal(strict.inflow.length, 0, "成交额100亿时需≥2亿");
});

function setup({ snapshots, subscribers = [{ chat_id: "100" }, { chat_id: "200" }], sendError, fetchError } = {}) {
    const calls = { messages: [], alerts: [], deactivated: [], fetches: 0 };
    const deps = {
        fundFlow: {
            async getRanking() {
                if (fetchError) throw fetchError;
                return snapshots[Math.min(calls.fetches++, snapshots.length - 1)];
            }
        },
        async isTradingDay() { return { ok: true }; },
        async listSubscribers() { return subscribers; },
        async listWatchSymbols(chatId) { return new Set(chatId === "100" ? ["A"] : []); },
        prepare: content => async (chatId, watchSymbols) => {
            const error = sendError && sendError(chatId);
            if (error) throw error;
            calls.messages.push({ chatId, content, text: formatFundFlowCaption({ ...content, watchSymbols }) });
        },
        isBotBlocked: error => error?.response?.status === 403,
        async deactivateSubscriber(chatId) { calls.deactivated.push(chatId); },
        alertContext: { adminChatId: "admin", alerted: new Set(), notify: async (_chatId, text) => calls.alerts.push(text) }
    };
    return { calls, deps, monitor: new FundFlowMonitor({ label: "尾盘", start: "14:30", end: "15:00" }) };
}

test("监控流程：首轮建起点，之后推送异动；同一分钟不重复拉取，同一股票不重复推送", async () => {
    const base = ranking([row("A", 1e8), row("B", 5e7)], [row("C", -1e8)]);
    const surged = ranking([row("A", 3e8), row("B", 6e7)], [row("C", -1e8)]);
    const { calls, deps, monitor } = setup({ snapshots: [base, surged, surged] });

    assert.deepEqual(await monitor.tick(at("14:29"), deps), { action: "outside-window" });
    assert.deepEqual(await monitor.tick(at("14:30"), deps), { action: "waiting", baseline: "14:30" });
    assert.deepEqual(await monitor.tick(at("14:30"), deps), { action: "waiting" }, "同一分钟不再拉取");
    assert.equal(calls.fetches, 1);

    const result = await monitor.tick(at("14:31"), deps);
    assert.equal(result.action, "processed");
    assert.equal(result.delivered, 2);
    assert.equal(calls.messages.length, 2);
    const [first, second] = calls.messages;
    assert.deepEqual(first.content.inflow.map(r => r.symbol), ["A"], "B 只增加1000万，未达门槛");
    assert.equal(first.content.since, "14:30");
    assert.match(first.text, /尾盘资金异动｜14:31/);
    assert.match(first.text, /⭐ 自选股：股A <b>\+2\.00亿<\/b>/);
    assert.match(first.text, /非交易所官方口径/);
    assert.doesNotMatch(second.text, /⭐/);

    assert.deepEqual(await monitor.tick(at("14:32"), deps), { action: "waiting" }, "已推送过的股票不再推送");
});

test("监控流程：用户屏蔽机器人时停用订阅，其他用户照常接收", async () => {
    const blocked = Object.assign(new Error("forbidden"), { response: { status: 403 } });
    const { calls, deps, monitor } = setup({
        snapshots: [ranking([row("A", 0)], []), ranking([row("A", 2e8)], [])],
        sendError: chatId => (chatId === "200" ? blocked : null)
    });
    await monitor.tick(at("14:40"), deps);
    const result = await monitor.tick(at("14:41"), deps);
    assert.equal(result.delivered, 1);
    assert.equal(result.deactivated, 1);
    assert.deepEqual(calls.deactivated, ["200"]);
});

test("监控流程：排行连续3次获取失败时提醒管理员一次", async () => {
    const { calls, deps, monitor } = setup({ fetchError: new Error("socket hang up") });
    for (const time of ["14:30", "14:31", "14:32", "14:33"]) {
        assert.equal((await monitor.tick(at(time), deps)).action, "fetch-failed");
    }
    assert.equal(calls.alerts.length, 1);
    assert.match(calls.alerts[0], /尾盘资金异动.*连续3次/);
});

test("监控流程：跨天后重新建立起点", async () => {
    const { deps, monitor } = setup({ snapshots: [ranking([row("A", 0)], [])] });
    await monitor.tick(at("14:30"), deps);
    const nextDay = new Date(at("14:30").getTime() + 24 * 3600 * 1000);
    assert.deepEqual(await monitor.tick(nextDay, deps), { action: "waiting", baseline: "14:30" });
});

const CONTENT = {
    label: "尾盘",
    time: "14:45",
    since: "14:30",
    inflow: [{ ...row("300308", 1.75e9, 1.3e10, { name: "中际旭创", changePct: 8.27 }), delta: 8.75e8, estimated: false }],
    outflow: [{ ...row("000858", -6.2e8, 3.5e9, { name: "五粮液", changePct: -6.04 }), delta: -7.951e7, estimated: true }]
};

test("推送视图：图片说明列出命中的自选股，按钮流入在前、自选股加⭐，文字版区间变化在前", () => {
    const watchSymbols = new Set(["000858"]);
    const caption = formatFundFlowCaption({ ...CONTENT, watchSymbols });
    assert.match(caption, /<b>🚨 尾盘资金异动｜14:45<\/b>\n较14:30：主力加速流入1只、加速流出1只/);
    assert.match(caption, /⭐ 自选股：五粮液 <b>≤-7951万<\/b>/);
    assert.deepEqual(formatFundFlowKeyboard({ ...CONTENT, watchSymbols }).inline_keyboard, [
        [{ text: "🔺中际旭创", url: "https://wap.eastmoney.com/quote/stock/0.300308.html" }],
        [{ text: "⭐五粮液", url: "https://wap.eastmoney.com/quote/stock/0.000858.html" }]
    ]);
    const text = formatFundFlowAlert({ ...CONTENT, watchSymbols });
    assert.match(text, /1\. <b>\+8\.75亿<\/b> 中际旭创/);
    assert.match(text, /1\. <b>≤-7951万<\/b> ⭐五粮液/);
});

test("资金异动图表生成有效PNG", () => {
    const png = generateFundFlowChart(CONTENT);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
});

test("推送发送：图片只上传一次，后续引用file_id；图表失败时改发文字", async () => {
    const photos = [];
    const send = prepareDelivery(CONTENT, {
        render: () => Buffer.from("png"),
        async sendPhoto(chatId, photo, caption, filename, options) {
            photos.push({ chatId, photo, filename, keyboard: options.replyMarkup });
            return { photo: [{ file_id: "small" }, { file_id: "large" }] };
        },
        async sendMessage() { throw new Error("不应发文字"); }
    });
    await send("100", new Set());
    await send("200", new Set(["300308"]));
    assert.ok(Buffer.isBuffer(photos[0].photo));
    assert.equal(photos[0].filename, "fund-flow-1445.png");
    assert.equal(photos[1].photo, "large");
    assert.equal(photos[1].keyboard.inline_keyboard[0][0].text, "⭐中际旭创");

    const texts = [];
    const fallback = prepareDelivery(CONTENT, {
        render: () => { throw new Error("no font"); },
        async sendPhoto() { throw new Error("不应发图"); },
        async sendMessage(chatId, text) { texts.push(text); }
    });
    await fallback("100", new Set());
    assert.match(texts[0], /主力加速流入/);
});
