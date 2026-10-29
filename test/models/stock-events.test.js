const test = require("node:test");
const assert = require("node:assert/strict");
const { createStockEventService, mergeBlockTrades, previousWeekday, reportName } = require("../../src/models/market/stock-events");
const { eventText, eventsLine } = require("../../src/views/stock-events-view");
const { formatStockCaption } = require("../../src/views/daily-report-view");
const { closeMessage, closeFragment } = require("../../src/views/daily-page-view");
const { visibleLength } = require("../../src/lib/telegram-text");

const ROWS = {
    RPT_LIFT_STAGE: [{ SECURITY_CODE: "300308", FREE_DATE: "2026-11-03 00:00:00", FREE_SHARES_TYPE: "首发原股东限售股份", CURRENT_FREE_SHARES: 1217.0859, FREE_RATIO: 0.3758, LIFT_MARKET_CAP: 27165.36 }],
    RPT_PUBLIC_BS_APPOIN: [
        { SECURITY_CODE: "600519", REPORT_DATE: "2026-09-30 00:00:00", APPOINT_PUBLISH_DATE: "2026-10-31 00:00:00", ACTUAL_PUBLISH_DATE: null },
        { SECURITY_CODE: "300308", REPORT_DATE: "2026-09-30 00:00:00", APPOINT_PUBLISH_DATE: "2026-10-30 00:00:00", ACTUAL_PUBLISH_DATE: "2026-10-29 00:00:00" }
    ],
    RPT_PUBLIC_OP_NEWPREDICT: [{ SECURITY_CODE: "300308", NOTICE_DATE: "2026-10-29 00:00:00", REPORT_DATE: "2026-12-31 00:00:00", PREDICT_FINANCE: "净利润", PREDICT_TYPE: "预增", ADD_AMP_LOWER: 95.47, ADD_AMP_UPPER: 136.42 }],
    RPT_SHARE_HOLDER_INCREASE: [{ SECURITY_CODE: "300308", NOTICE_DATE: "2026-10-29 00:00:00", HOLDER_NAME: "山东中际投资控股有限公司", DIRECTION: "减持", CHANGE_NUM: -550, CHANGE_FREE_RATIO: 0.5 }],
    RPT_DATA_BLOCKTRADE: [
        { SECURITY_CODE: "600519", TRADE_DATE: "2026-10-28 00:00:00", DEAL_AMT: 3e8, PREMIUM_RATIO: -0.02 },
        { SECURITY_CODE: "600519", TRADE_DATE: "2026-10-28 00:00:00", DEAL_AMT: 1e8, PREMIUM_RATIO: 0.02 }
    ],
    RPTA_WEB_RZRQ_GGMX: [
        { SCODE: "600519", DATE: "2026-10-28 00:00:00", RZYE: 1.0e10, RZJME: 1e8 },
        { SCODE: "300308", DATE: "2026-10-28 00:00:00", RZYE: 2.0e9, RZJME: -1e8 }
    ]
};

function fakeService({ fail = [] } = {}) {
    const requests = [];
    const httpClient = {
        async get(url, { params }) {
            requests.push(params);
            if (fail.includes(params.reportName)) throw new Error("ECONNRESET");
            const rows = ROWS[params.reportName];
            return { data: rows ? { result: { data: rows }, success: true } : { result: null, success: false, code: 9201 } };
        }
    };
    return { requests, service: createStockEventService({ httpClient, requestWithRetry: fn => fn() }) };
}

test("上一交易日按工作日推算；报告期换成季报名称", () => {
    assert.equal(previousWeekday("2026-10-29"), "2026-10-28");
    assert.equal(previousWeekday("2026-11-02"), "2026-10-30", "周一的上一交易日是周五");
    assert.equal(reportName("2026-09-30 00:00:00"), "2026年三季报");
    assert.equal(reportName("2026-12-31"), "2026年年报");
});

test("一批股票每张报表只查一次：未来7天解禁、未来3天未披露的财报、上一交易日以来的预告与增减持、上一交易日的大宗与融资", async () => {
    const { requests, service } = fakeService();
    const events = await service.getEvents(["600519", "300308"], "2026-10-29");
    assert.equal(requests.length, 6);
    const lift = requests.find(params => params.reportName === "RPT_LIFT_STAGE");
    assert.equal(lift.filter, `(SECURITY_CODE in ("600519","300308"))(FREE_DATE>'2026-10-29')(FREE_DATE<='2026-11-05')`);
    assert.equal(requests.find(params => params.reportName === "RPT_DATA_BLOCKTRADE").filter, `(SECURITY_CODE in ("600519","300308"))(TRADE_DATE='2026-10-28')`);
    assert.equal(requests.find(params => params.reportName === "RPT_SHARE_HOLDER_INCREASE").filter, `(SECURITY_CODE in ("600519","300308"))(NOTICE_DATE>'2026-10-28')(NOTICE_DATE<='2026-10-29')`);

    assert.deepEqual(events.get("600519").map(event => event.type), ["report", "block"], "融资净买入1%未达3%门槛");
    assert.deepEqual(events.get("600519")[1], { type: "block", symbol: "600519", date: "2026-10-28", count: 2, amount: 4e8, premium: -0.01 });
    assert.deepEqual(events.get("300308").map(event => event.type), ["lift", "forecast", "holder", "margin"], "已披露的财报不再提醒");
    assert.equal(events.get("300308")[3].ratio, -1e8 / 2.1e9);
});

test("某张报表失败只少这一类事件；查不到数据（9201）不算失败", async () => {
    const { service } = fakeService({ fail: ["RPT_LIFT_STAGE"] });
    const events = await service.getEvents(["300308"], "2026-10-29");
    assert.deepEqual(events.get("300308").map(event => event.type), ["forecast", "holder", "margin"]);
    assert.deepEqual(await createStockEventService({ httpClient: { async get() { return { data: { result: null, success: false, code: 9201 } }; } }, requestWithRetry: fn => fn() }).getEvents(["1"], "2026-10-29"), new Map());
    assert.deepEqual(await fakeService().service.getEvents([], "2026-10-29"), new Map());
    assert.deepEqual(mergeBlockTrades([]), []);
});

test("事件写法：解禁、披露、预告、增减持、大宗、融资各一句，合成一行", () => {
    assert.equal(eventText({ type: "lift", date: "2026-11-03", shares: 1217.0859, floatRatio: 0.3758, marketCap: 2.7165e8 }), "🔓11-03解禁1217万股（占流通37.6%，约2.72亿）");
    assert.equal(eventText({ type: "report", date: "2026-10-31", name: "2026年三季报" }), "📅10-31披露2026年三季报");
    assert.equal(eventText({ type: "forecast", date: "2026-10-29", name: "2026年年报", finance: "净利润", predictType: "预增", lower: 95.47, upper: 136.42 }), "📈10-29发布2026年年报预告：预增，净利润同比+95%～+136%");
    assert.equal(eventText({ type: "holder", date: "2026-10-29", holder: "某控股公司", direction: "减持", shares: 550, floatRatio: 0.5 }), "👤10-29某控股公司减持550万股（占流通0.5%）");
    assert.equal(eventText({ type: "block", date: "2026-10-28", count: 2, amount: 4e8, premium: -0.01 }), "💼10-28大宗交易2笔4.00亿，折价1.0%");
    assert.equal(eventText({ type: "margin", date: "2026-10-28", net: -1e8, balance: 2e9, ratio: -0.0476 }), "💳10-28融资净偿还1.00亿（余额-4.8%）");
    assert.equal(eventsLine([]), "");
    assert.equal(eventsLine([{ type: "report", date: "2026-10-31", name: "2026年<三季报>" }]), "⚠️ 📅10-31披露2026年&lt;三季报&gt;");
});

function report(events, newsTitle = "公告") {
    const value = 10;
    return {
        meta: { symbol: "600519", name: "贵州茅台", exchangeCode: "600519.SH" },
        analysis: {
            latest: { close: value, changePct: 1, open: value, high: value, low: value, amount: 1e8, turnover: 1 },
            ma: { ma5: value, ma10: value, ma20: value, ma60: value }, macd: { dif: 0, dea: 0, histogram: 0 }, rsi: 50, kdj: { k: 50, d: 50, j: 50 },
            bollinger: { lower: value, middle: value, upper: value }, support: value, resistance: value, weightedClose20: value, volumeRatio: 1
        },
        plan: { recommendation: "观望", entryLow: value, entryHigh: value, breakoutTrigger: value, stop: value, target: value, rewardRisk: 2 },
        announcements: [{ title: newsTitle, date: "2026-10-29", url: "https://data.eastmoney.com/notices/1.html" }],
        events
    };
}

test("收盘报告：事件行放在催化前；说明超长时最后才去掉事件行", () => {
    const events = [{ type: "report", date: "2026-10-31", name: "2026年三季报" }, { type: "block", date: "2026-10-28", count: 1, amount: 4e8, premium: 0.01 }];
    const caption = formatStockCaption(report(events), "2026-10-29");
    assert.match(caption, /⚠️ 📅10-31披露2026年三季报；💼10-28大宗交易4\.00亿，溢价1\.0%\n📰 /);
    assert.doesNotMatch(formatStockCaption(report([]), "2026-10-29"), /⚠️/);

    const many = Array.from({ length: 12 }, (_, index) => ({ type: "holder", date: "2026-10-29", holder: `某某投资管理合伙企业（有限合伙）${index}号`, direction: "减持", shares: 100, floatRatio: 0.1 }));
    const long = formatStockCaption(report(many, "很长的公告标题".repeat(4)), "2026-10-29");
    assert.ok(visibleLength(long) <= 1024);
    assert.match(long, /📰 /, "催化保留");
});

test("网页卡片显示事件行；收盘概况里有事件的股票标 ⚠️", () => {
    const events = [{ type: "report", date: "2026-10-31", name: "2026年三季报" }];
    assert.match(closeFragment({ reports: [report(events)], chartUrls: new Map() }), /<div class="event">⚠️ 📅10-31披露2026年三季报<\/div>/);
    assert.match(closeMessage({ reports: [report(events)], date: "2026-10-29" }), /<b>观望<\/b> ⚠️\n/);
    assert.doesNotMatch(closeMessage({ reports: [report([])], date: "2026-10-29" }), /<\/b> ⚠️/);
});
