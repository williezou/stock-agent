const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateSeats, createHotMoneyService } = require("../../src/models/market/hot-money");
const { runHotMoneyTick } = require("../../src/controllers/hot-money-controller");
const { generateHotMoneyChart } = require("../../src/views/charts/hot-money-chart");
const { formatHotMoneyCaption, formatHotMoneyText, statsText } = require("../../src/views/hot-money-view");
const { visibleLength } = require("../../src/lib/telegram-text");

const at = hhmm => {
    const [hour, minute] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(2026, 9, 28, hour - 8, minute));
};
const seatRow = (code, name, symbol, tradeId, explanation, buy, sell) => ({
    OPERATEDEPT_CODE: code, OPERATEDEPT_NAME: name, SECURITY_CODE: symbol, TRADE_ID: tradeId,
    EXPLANATION: explanation, CHANGE_RATE: 10, BUY: buy, SELL: sell, NET: buy - sell
});
const DAY = "日涨幅偏离值达到7%的前5只证券";
const MULTI = "连续三个交易日内，涨幅偏离值累计达到20%的证券";

test("按营业部汇总：排除机构与沪深股通；多日累计原因与单日原因并存时只算单日；买入榜与卖出榜的同一席位只算一次", () => {
    const rows = [
        // 股票A：单日原因与3日累计原因并存，3日累计的金额更大，不应计入
        seatRow("1", "国泰君安证券股份有限公司上海江苏路证券营业部", "000001", "t1", DAY, 1e8, 0),
        seatRow("1", "国泰君安证券股份有限公司上海江苏路证券营业部", "000001", "t2", MULTI, 3e8, 0),
        seatRow("1", "国泰君安证券股份有限公司上海江苏路证券营业部", "000001", "t1", DAY, 1e8, 0), // 卖出榜里同一条
        // 股票B：只有3日累计原因，使用它
        seatRow("1", "国泰君安证券股份有限公司上海江苏路证券营业部", "600000", "t3", MULTI, 5e7, 1e7),
        seatRow("2", "机构专用", "000001", "t1", DAY, 9e8, 0),
        seatRow("3", "深股通专用", "000001", "t1", DAY, 9e8, 0),
        seatRow("4", "华鑫证券有限责任公司上海分公司", "000001", "t1", DAY, 0, 6e7)
    ];
    const seats = aggregateSeats(rows, new Map([["000001", "平安银行"], ["600000", "浦发银行"]]));
    assert.deepEqual(seats.map(seat => [seat.code, seat.net]), [["1", 1.4e8], ["4", -6e7]]);
    assert.deepEqual(seats[0].stocks.map(stock => [stock.name, stock.net]), [["平安银行", 1e8], ["浦发银行", 4e7]]);
});

test("营业部统计按代码批量查询（近一年、上榜后3日）", async () => {
    const queries = [];
    const service = createHotMoneyService({
        httpClient: {
            async get(url, { params }) {
                queries.push(params);
                return { data: { success: true, result: { pages: 1, data: [{ OPERATEDEPT_CODE: 1, TOTAL_BUYER_SALESTIMES_3DAY: 85, RISE_PROBABILITY_3DAY: 62.4, AVERAGE_INCREASE_3DAY: 3.14 }] } } };
            }
        },
        requestWithRetry: fn => fn()
    });
    const stats = await service.getSeatStats(["1", "2"]);
    assert.deepEqual(stats.get("1"), { times: 85, riseProbability: 62.4, averageIncrease: 3.14 });
    assert.equal(queries[0].reportName, "RPT_RATEDEPT_RETURNT_RANKING");
    assert.equal(queries[0].filter, '(STATISTICSCYCLE="04")(OPERATEDEPT_CODE in ("1","2"))');
});

const CONTENT = {
    date: "2026-10-28",
    totalSeats: 120,
    seats: [
        { code: "1", name: "国泰君安证券股份有限公司上海江苏路证券营业部", net: 1.23e8, stats: { times: 85, riseProbability: 62.4, averageIncrease: 3.14 },
            stocks: [{ symbol: "300308", name: "中际旭创", net: 8e7 }, { symbol: "603986", name: "兆易创新", net: 4.3e7 }, { symbol: "000001", name: "平安银行", net: -1e7 }] },
        { code: "2", name: "华鑫证券有限责任公司上海分公司", net: 5e7, stats: { times: 5, riseProbability: 80, averageIncrease: 6 },
            stocks: [{ symbol: "600000", name: "浦发银行", net: 5e7 }] },
        { code: "3", name: "东方财富证券股份有限公司拉萨团结路第二证券营业部", net: 3e7, stats: null, stocks: [{ symbol: "600001", name: "邯郸钢铁", net: 3e7 }] }
    ]
};
CONTENT.highWinSeats = [
    { code: "9", name: "中信证券股份有限公司杭州延安路证券营业部", net: 2e7, stats: { times: 40, riseProbability: 71.2, averageIncrease: 4.5 },
        stocks: [{ symbol: "002380", name: "科远智慧", net: 2e7 }] },
    CONTENT.seats[0]
];

test("游资动向视图：每家两行（名次 营业部 净买入／胜率 · 股票）；高胜率在前；🏆只给胜率≥60%且上榜≥20次；只列买入的股票；名称可跳转App", () => {
    const caption = formatHotMoneyCaption(CONTENT);
    assert.match(caption, /^<b>🐯 今日游资动向｜10-28<\/b>\n\n<b>🏆 高胜率游资出手<\/b>\n🥇 <b>中信证券杭州延安路<\/b>  \+2000万\n　胜率71%（40次） · <a [^>]+>科远智慧<\/a>\n🥈 <b>国泰君安证券上海江苏路<\/b>/, "高胜率游资在前，不论净买入排第几");
    assert.match(caption, /<b>💰 游资净买入 Top3<\/b>（120家上榜）\n🥇 <b>🏆国泰君安证券上海江苏路<\/b>  \+1\.23亿\n　胜率62%（85次） · <a [^>]+>中际旭创<\/a>、<a [^>]+>兆易创新<\/a>\n/);
    assert.doesNotMatch(caption, /平安银行/, "净卖出的股票不列出");
    assert.match(caption, /🥈 <b>华鑫证券上海分公司<\/b>/, "样本只有5次，不标🏆");
    assert.match(caption, /🥉 <b>东方财富证券拉萨团结路第二<\/b>  \+3000万\n　暂无近一年统计 · /);
    assert.match(formatHotMoneyCaption({ ...CONTENT, highWinSeats: [] }), /<\/b>\n今日没有高胜率游资净买入\n/);
    assert.equal(statsText({ times: 10, riseProbability: NaN }), "暂无近一年统计");

    const longSeat = i => ({ ...CONTENT.seats[0], code: String(i), name: `某某证券股份有限公司某某市某某路第${i}证券营业部` });
    const many = { ...CONTENT, seats: Array.from({ length: 10 }, (_, i) => longSeat(i)), highWinSeats: Array.from({ length: 8 }, (_, i) => longSeat(i + 10)) };
    const manyCaption = formatHotMoneyCaption(many);
    assert.ok(visibleLength(manyCaption) <= 1024, "两段都满时自动缩减，仍在上限内");
    assert.match(manyCaption, /4\. <b>/, "第4名起用数字");
    assert.match(formatHotMoneyText(many), /兆易创新/, "文字版不受图片说明长度限制");
    assert.equal(generateHotMoneyChart(CONTENT).subarray(1, 4).toString(), "PNG");
});

function setup({ longhuDone = true, seats = CONTENT.seats } = {}) {
    const calls = { photos: [], completed: [], builds: 0 };
    const store = {
        async listDueSubscribers(job, date, max, options) {
            assert.equal(job, "hot-money");
            assert.deepEqual(options, { audience: "longhu" });
            return [{ chat_id: "100" }, { chat_id: "200", quote_app: "xueqiu" }].filter(s => !calls.completed.some(c => c.chatId === s.chat_id));
        },
        async hasCompletedRun(job) { assert.equal(job, "longhu"); return longhuDone; },
        async claimDeliveryRun() { return 1; },
        async completeDeliveryRun(_job, chatId, _date, status) { calls.completed.push({ chatId, status }); },
        async failDeliveryRun() {},
        async deactivateSubscriber() {}
    };
    const services = {
        cache: { date: "", content: null },
        longhu: { async getBoardByDate() { calls.builds++; return []; } },
        hotMoney: {
            async getSeatTrades() { return []; },
            async getSeatStats() { return new Map(); }
        },
        renderChart: () => Buffer.from("png"),
        async sendPhoto(chatId, photo, caption) { calls.photos.push({ chatId, uploaded: Buffer.isBuffer(photo), caption }); return { photo: [{ file_id: "f" }] }; },
        async sendMessage() {},
        adminChatId: "admin",
        alerted: new Set()
    };
    if (seats) services.cache = { date: "2026-10-28", content: { ...CONTENT, seats, highWinSeats: seats.length ? CONTENT.highWinSeats : [] } };
    return { calls, services, store };
}

test("游资动向调度：等龙虎榜推送成功后再推；图片只上传一次；没有游资净买入时记为跳过", async () => {
    const waiting = setup({ longhuDone: false });
    assert.deepEqual(await runHotMoneyTick(waiting.store, at("18:00"), waiting.services), { action: "waiting" });
    assert.equal(await runHotMoneyTick(waiting.store, at("17:29"), waiting.services).then(r => r.action), "outside-window");

    const { calls, services, store } = setup();
    const result = await runHotMoneyTick(store, at("18:01"), services);
    assert.equal(result.action, "processed");
    assert.equal(result.delivered, 2);
    assert.deepEqual(calls.photos.map(p => [p.chatId, p.uploaded]), [["100", true], ["200", false]]);
    assert.match(calls.photos[0].caption, /今日游资动向/);
    assert.match(calls.photos[0].caption, /mlink\.eastmoney\.com/);
    assert.match(calls.photos[1].caption, /xueqiu\.com\/S\//, "图片说明里的股票链接按各自选择的App");
    assert.doesNotMatch(calls.photos[1].caption, /mlink\.eastmoney\.com/);
    assert.deepEqual(calls.completed.map(c => c.status), ["done", "done"]);

    const empty = setup({ seats: [] });
    const skipped = await runHotMoneyTick(empty.store, at("18:01"), empty.services);
    assert.equal(skipped.skipped, 2);
    assert.deepEqual(empty.calls.completed.map(c => c.status), ["skipped", "skipped"]);
    assert.equal(empty.calls.photos.length, 0);
});

test("生成内容：高胜率游资不受净买入排名限制（排在第11名之后也能入选），按胜率排序；统计查询覆盖所有净买入营业部", async () => {
    const { buildContent } = require("../../src/controllers/hot-money-controller");
    const rows = Array.from({ length: 12 }, (_, i) => seatRow(String(i + 1), `某证券第${i + 1}营业部`, "000001", "t1", DAY, (12 - i) * 1e7, 0));
    let queried = [];
    const content = await buildContent("2026-10-28", {
        longhu: { async getBoardByDate() { return [{ symbol: "000001", name: "平安银行" }]; } },
        hotMoney: {
            async getSeatTrades() { return rows; },
            async getSeatStats(codes) {
                queried = codes;
                return new Map([
                    ["12", { times: 30, riseProbability: 75, averageIncrease: 5 }], // 净买入最少，但胜率最高
                    ["2", { times: 50, riseProbability: 65, averageIncrease: 2 }],
                    ["3", { times: 5, riseProbability: 90, averageIncrease: 9 }] // 样本不足
                ]);
            }
        }
    });
    assert.equal(queried.length, 12);
    assert.equal(content.seats.length, 10);
    assert.deepEqual(content.highWinSeats.map(seat => seat.code), ["12", "2"]);
});

test("每日总结网页：游资写入网页（只写一次），每人推一条“龙虎榜与游资动向已更新”加网页按钮；没有游资净买入也推；写入失败时照常推图", async () => {
    const { calls, services, store } = setup();
    const page = { hotMoney: 0, indexes: [] };
    const messages = [];
    store.getSubscriber = async chatId => ({ chat_id: chatId, longhu_enabled: true });
    services.sendMessage = async (chatId, text, options) => { messages.push({ chatId, text, options }); };
    services.dailyPage = {
        async publishHotMoney({ date, content }) { page.hotMoney++; assert.equal(date, "2026-10-28"); assert.equal(content.seats.length, 3); },
        async publishIndex(subscriber, date) { page.indexes.push(subscriber.chat_id); return `https://pages.test/p/${subscriber.chat_id}/${date}`; }
    };
    const result = await runHotMoneyTick(store, at("18:01"), services);
    assert.equal(result.delivered, 2);
    assert.equal(page.hotMoney, 1);
    assert.deepEqual(page.indexes, ["100", "200"]);
    assert.deepEqual(calls.photos, [], "不再单独推图");
    assert.match(messages[0].text, /🐉 龙虎榜与游资动向已更新｜2026-10-28[^]*净买入第一：🏆国泰君安证券上海江苏路 \+1\.23亿/);
    assert.equal(messages[1].options.replyMarkup.inline_keyboard[0][0].url, "https://pages.test/p/200/2026-10-28");

    const empty = setup({ seats: [] });
    const emptyMessages = [];
    empty.store.getSubscriber = async chatId => ({ chat_id: chatId });
    empty.services.sendMessage = async (chatId, text) => { emptyMessages.push(text); };
    empty.services.dailyPage = { async publishHotMoney() {}, async publishIndex() { return "https://pages.test/p"; } };
    assert.equal((await runHotMoneyTick(empty.store, at("18:01"), empty.services)).delivered, 2);
    assert.doesNotMatch(emptyMessages[0], /净买入第一/);

    const broken = setup();
    broken.services.dailyPage = { async publishHotMoney() { throw new Error("storage down"); } };
    assert.equal((await runHotMoneyTick(broken.store, at("18:01"), broken.services)).delivered, 2);
    assert.deepEqual(broken.calls.photos.map(p => p.chatId), ["100", "200"]);
});
