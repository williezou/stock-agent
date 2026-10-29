const test = require("node:test");
const assert = require("node:assert/strict");
const { createFundFlowService, parseFlowRows, parseSinaFlowRows } = require("../../src/models/market/fund-flow");
const { FundFlowMonitor, detectSurges, takeBaseline } = require("../../src/services/fund-flow-monitor");
const { createMonitors, prepareDelivery } = require("../../src/controllers/fund-flow-controller");
const { generateFundFlowChart } = require("../../src/views/charts/fund-flow-chart");
const { formatFundFlowAlert, formatFundFlowCaption, fundFlowKeyboard } = require("../../src/views/fund-flow-view");

// 北京时间 = UTC + 8；2026-10-28 是周三
const at = hhmm => {
    const [hour, minute] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(2026, 9, 28, hour - 8, minute));
};
const row = (symbol, mainNet, amount = 1e9, extra = {}) => ({ symbol, name: `股${symbol}`, changePct: 1, amount, mainNet, mainRatio: 5, ...extra });
const ranking = (inflow, outflow, source = "东方财富") => ({ source, inflow, outflow, size: inflow.length });

test("解析资金流排行：字段映射，停牌股（字段为“-”）剔除", () => {
    const rows = parseFlowRows({ data: { diff: [
        { f12: "300308", f14: "中际旭创", f2: 619.73, f3: 7.41, f6: 13278635375.3, f62: 1608405824, f184: 12.11, f66: 1309660816, f72: 298745008 },
        { f12: "000001", f14: "停牌股", f2: "-", f3: "-", f6: "-", f62: "-", f184: "-", f66: "-", f72: "-" }
    ] } });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
        symbol: "300308", name: "中际旭创", price: 619.73, changePct: 7.41, amount: 13278635375.3,
        mainNet: 1608405824, mainRatio: 12.11
    });
});

test("解析新浪资金流向：去掉市场前缀，涨跌幅与主力占比由小数换算为%，null视为空", () => {
    const rows = parseSinaFlowRows(JSON.stringify([
        { symbol: "sz300308", name: "中际旭创", trade: "636.3000", changeratio: "0.102773", amount: "23572610782.0000", r0_net: "3388592392.5500", r0_ratio: "0.143751" }
    ]));
    assert.equal(rows[0].symbol, "300308");
    assert.equal(rows[0].mainNet, 3388592392.55);
    assert.ok(Math.abs(rows[0].changePct - 10.2773) < 1e-9);
    assert.ok(Math.abs(rows[0].mainRatio - 14.3751) < 1e-9);
    assert.deepEqual(parseSinaFlowRows("null"), []);
    assert.throws(() => parseSinaFlowRows({ error: 1 }), /无法解析/);
});

test("资金流排行：东方财富失败时改用新浪；prefer 指定的来源优先", async () => {
    const calls = [];
    const source = (name, fail) => ({
        name,
        async fetchSide(descending) {
            calls.push(`${name}:${descending ? "in" : "out"}`);
            if (fail) throw new Error("socket hang up");
            return [row(descending ? "A" : "B", descending ? 1 : -1)];
        }
    });
    const service = createFundFlowService({ sources: [source("东方财富", true), source("新浪")] });
    const first = await service.getRanking();
    assert.equal(first.source, "新浪");
    assert.deepEqual(calls, ["东方财富:in", "新浪:in", "新浪:out"]);

    calls.length = 0;
    await service.getRanking({ prefer: "新浪" });
    assert.deepEqual(calls, ["新浪:in", "新浪:out"], "起点来自新浪时不再先试东方财富");

    const down = createFundFlowService({ sources: [source("东方财富", true), source("新浪", true)] });
    await assert.rejects(down.getRanking(), /东方财富：socket hang up；新浪：socket hang up/);
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
            async getRanking(options) {
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
            calls.messages.push({ chatId, content, text: formatFundFlowAlert({ ...content, watchSymbols }) });
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
    assert.deepEqual(await monitor.tick(at("14:30"), deps), { action: "waiting", baseline: "14:30", source: "东方财富" });
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
    assert.match(first.text, /⭐<a [^>]+>股A<\/a> <b>\+2\.00亿<\/b>/);
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

test("监控流程：数据来源切换时以新来源重新建立起点，不跨来源比较；推送注明来源", async () => {
    const { calls, deps, monitor } = setup({ snapshots: [
        ranking([row("A", 0)], []),
        ranking([row("A", 5e8)], [], "新浪"),
        ranking([row("A", 8e8)], [], "新浪")
    ] });
    const prefers = [];
    const getRanking = deps.fundFlow.getRanking;
    deps.fundFlow.getRanking = options => { prefers.push(options.prefer); return getRanking(options); };
    await monitor.tick(at("14:30"), deps);
    assert.deepEqual(await monitor.tick(at("14:31"), deps), { action: "waiting", baseline: "14:31", source: "新浪", switchedFrom: "东方财富" });
    assert.equal(calls.messages.length, 0, "跨来源的差值不推送");
    assert.equal((await monitor.tick(at("14:32"), deps)).action, "processed");
    assert.deepEqual(prefers, [undefined, "东方财富", "新浪"]);
    assert.equal(calls.messages[0].content.source, "新浪");
    assert.match(calls.messages[0].text, /主力净流入为新浪按大单估算/);
});

test("监控状态存库：重启后恢复起点与已推送股票，不重新建起点、不重复推送；推送记录存库", async () => {
    const saved = new Map();
    const records = [];
    const persistence = {
        async loadState(date, label) { return saved.has(`${date}:${label}`) ? JSON.parse(saved.get(`${date}:${label}`)) : null; },
        async saveState(date, label, state) { saved.set(`${date}:${label}`, JSON.stringify(state)); },
        async recordAlert(date, label, content) { records.push({ date, label, content }); }
    };
    const surged = ranking([row("A", 3e8)], []);
    const first = setup({ snapshots: [ranking([row("A", 1e8)], [])] });
    await first.monitor.tick(at("14:30"), { ...first.deps, ...persistence });

    // 部署重启：新的实例，从库里恢复14:30的起点
    const second = setup({ snapshots: [surged] });
    const result = await second.monitor.tick(at("14:35"), { ...second.deps, ...persistence });
    assert.equal(result.action, "processed", "恢复起点后直接比较，不重新建起点");
    assert.equal(second.calls.messages[0].content.since, "14:30");
    assert.deepEqual(records.map(r => [r.date, r.label, r.content.inflow.map(x => x.symbol), r.content.totals.delivered]), [["2026-10-28", "尾盘", ["A"], 2]]);

    // 再次重启：已推送过的A不会重复推送
    const third = setup({ snapshots: [surged] });
    assert.deepEqual(await third.monitor.tick(at("14:36"), { ...third.deps, ...persistence }), { action: "waiting" });
    assert.equal(third.calls.messages.length, 0);
});

test("监控流程：跨天后重新建立起点", async () => {
    const { deps, monitor } = setup({ snapshots: [ranking([row("A", 0)], [])] });
    await monitor.tick(at("14:30"), deps);
    const nextDay = new Date(at("14:30").getTime() + 24 * 3600 * 1000);
    assert.deepEqual(await monitor.tick(nextDay, deps), { action: "waiting", baseline: "14:30", source: "东方财富" });
});

const CONTENT = {
    // 东方财富名称带补齐空格
    label: "尾盘",
    time: "14:45",
    since: "14:30",
    inflow: [{ ...row("300308", 1.75e9, 1.3e10, { name: "中际旭创", changePct: 8.27 }), delta: 8.75e8, estimated: false }],
    outflow: [{ ...row("000858", -6.2e8, 3.5e9, { name: "五 粮 液", changePct: -6.04 }), delta: -7.951e7, estimated: true }]
};

test("推送视图：图片说明只有标题与概况，股票在按钮里（自选股加⭐、名称去空格、涨跌用走势图标记）；文字版附涨跌幅", () => {
    const watchSymbols = new Set(["000858"]);
    const caption = formatFundFlowCaption({ ...CONTENT, watchSymbols });
    assert.match(caption, /^<b>🚨 尾盘资金异动｜14:45<\/b>\n较14:30：主力加速流入1只、加速流出1只\n<i>点下方按钮/);
    assert.doesNotMatch(caption, /<a /);
    assert.match(caption, /非交易所官方口径/);
    assert.deepEqual(fundFlowKeyboard({ ...CONTENT, watchSymbols }).inline_keyboard.flat().map(button => button.text), ["📈中际旭创", "📉五粮液⭐"]);
    assert.match(fundFlowKeyboard({ ...CONTENT, watchSymbols }).inline_keyboard[0][0].url, /stockpage%3Fcode%3D300308%26market%3D0/);
    const text = formatFundFlowAlert({ ...CONTENT, watchSymbols });
    assert.match(text, /<b>🔺 主力加速流入<\/b>\n<a href="https:\/\/mlink\.eastmoney\.com\/h52n\/nlink\.html\?type=localurl&amp;id=eastmoney%3A%2F%2Fpage%2Fstockpage%3Fcode%3D300308%26market%3D0">中际旭创<\/a> <b>\+8\.75亿<\/b> \+8\.27%\n/);
    assert.match(text, /⭐<a [^>]+>五粮液<\/a> <b>≤-7951万<\/b> -6\.04%/);
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
            photos.push({ chatId, photo, filename, caption, options });
            return { photo: [{ file_id: "small" }, { file_id: "large" }] };
        },
        async sendMessage() { throw new Error("不应发文字"); }
    });
    await send("100", new Set());
    await send("200", new Set(["300308"]), "xueqiu");
    assert.ok(Buffer.isBuffer(photos[0].photo));
    assert.equal(photos[0].filename, "fund-flow-1445.png");
    assert.equal(photos[1].photo, "large");
    assert.deepEqual(photos[0].options.replyMarkup.inline_keyboard.flat().map(button => button.text), ["📈中际旭创", "📉五粮液"]);
    assert.deepEqual(photos[1].options.replyMarkup.inline_keyboard.flat().map(button => button.text), ["📈中际旭创⭐", "📉五粮液"], "按钮按各自自选股标⭐");
    assert.match(photos[0].options.replyMarkup.inline_keyboard[0][0].url, /mlink\.eastmoney\.com/, "没选过App时打开东方财富");
    assert.equal(photos[1].options.replyMarkup.inline_keyboard[0][0].url, "https://xueqiu.com/S/SZ300308", "按钮打开各自选择的App");
    assert.match(photos[1].caption, /点下方按钮打开雪球/);

    const texts = [];
    const fallback = prepareDelivery(CONTENT, {
        render: () => { throw new Error("no font"); },
        async sendPhoto() { throw new Error("不应发图"); },
        async sendMessage(chatId, text) { texts.push(text); }
    });
    await fallback("100", new Set(), "tonghuashun");
    assert.match(texts[0], /主力加速流入/);
    assert.match(texts[0], /m\.10jqka\.com\.cn\/stockpage\/hs_300308/);
    assert.match(texts[0], /点股票名称打开同花顺/);
});
