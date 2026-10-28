const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReports, prioritize, selectReportDate } = require("../../src/services/daily-report");
const { analyzeKlines, buildTradePlan } = require("../../src/services/technical-analysis");
const { generateOverviewChart, generateStockChart } = require("../../src/views/charts/stock-charts");
const { formatDailyCloseDelivery } = require("../../src/views/daily-report-view");
const { safeHttpUrl } = require("../../src/views/format");

function rows(lastDate) {
    return Array.from({ length: 80 }, (_, index) => {
        const generatedDate = new Date(Date.UTC(2026, 6, 1 + index)).toISOString().slice(0, 10);
        const date = index === 79 ? lastDate : generatedDate;
        const close = 25 + index * 0.03;
        return {
            date,
            open: close - 0.1,
            close,
            high: close + 0.2,
            low: close - 0.2,
            volume: 200000 + index * 100,
            amount: close * (200000 + index * 100) * 100,
            changePct: 0.12,
            turnover: 2.3
        };
    });
}

test("正式运行只接受北京时间收盘后的当日日K", () => {
    const sets = [rows("2026-10-27"), rows("2026-10-27")];
    const beforeClose = new Date("2026-10-27T06:30:00.000Z");
    const afterClose = new Date("2026-10-27T07:30:00.000Z");
    assert.equal(selectReportDate(sets, { dryRun: false, now: beforeClose }).date, null);
    assert.equal(selectReportDate(sets, { dryRun: false, now: afterClose }).date, "2026-10-27");
});

test("非交易日没有当日日K时不推送", () => {
    const sets = [rows("2026-10-26"), rows("2026-10-26")];
    const afterClose = new Date("2026-10-27T07:30:00.000Z");
    assert.equal(selectReportDate(sets, { dryRun: false, now: afterClose }).date, null);
});

test("公告与新闻会优先保留关键词信息并过滤无意义短标题", () => {
    const result = prioritize([
        { title: "伊利股份" },
        { title: "三季报" },
        { title: "伊利股份完成新一轮回购" },
        { title: "伊利股份渠道更新情况" }
    ], ["三季报", "回购"]);
    assert.deepEqual(result.map(item => item.title), [
        "三季报",
        "伊利股份完成新一轮回购",
        "伊利股份渠道更新情况"
    ]);
});

test("只允许HTTP(S)新闻链接进入Telegram HTML", () => {
    assert.equal(safeHttpUrl("javascript:alert(1)"), "");
    assert.equal(safeHttpUrl("not a url"), "");
    assert.equal(safeHttpUrl("https://example.com/news?a=1&b=2"), "https://example.com/news?a=1&b=2");
});

test("图形化交付按每两只股票分页并生成有效PNG", () => {
    const metas = [
        { symbol: "600887", name: "伊利股份", exchangeCode: "600887.SH", quoteUrl: "https://example.com/yili" },
        { symbol: "002380", name: "科远智慧", exchangeCode: "002380.SZ", quoteUrl: "https://example.com/keyuan" },
        { symbol: "600519", name: "贵州茅台", exchangeCode: "600519.SH", quoteUrl: "https://example.com/maotai" }
    ];
    const reports = metas.map(meta => {
        const klines = rows("2026-10-27");
        const analysis = analyzeKlines(klines);
        return {
            meta,
            klines,
            analysis,
            plan: buildTradePlan(analysis),
            news: [{ title: "工业AI与机器人进展 <待核实>", url: "https://example.com/news?a=1&b=2" }],
            announcements: [{ title: "三季报公告", url: "https://example.com/report" }]
        };
    });
    const delivery = formatDailyCloseDelivery({ reports, date: "2026-10-27" });
    assert.equal(delivery.overviews.length, 2);
    assert.equal(delivery.overviews[0].reports.length, 2);
    assert.equal(delivery.overviews[1].reports.length, 1);
    assert.equal(delivery.stocks.length, 3);
    for (const item of delivery.overviews) {
        assert.match(item.caption, /A股每日收盘图览/);
        assert.doesNotMatch(item.caption, /[▁▂▃▄▅▆▇█]/);
        const overviewPng = generateOverviewChart(item.reports, "2026-10-27");
        assert.deepEqual([...overviewPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.ok(overviewPng.length > 5000);
    }
    for (const item of delivery.stocks) {
        const png = generateStockChart(item.report);
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.ok(png.length > 10000);
        assert.ok(item.caption.length <= 1024);
        assert.match(item.caption, /开\/高\/低/);
        assert.match(item.caption, /BOLL/);
        assert.match(item.caption, /K\/D\/J/);
        assert.match(item.caption, /&lt;待核实&gt;|三季报公告/);
    }
});

test("当日已存库的报告直接复用：所有股票都有存档时不拉取日K与新闻，按用户的顺序返回", async () => {
    const saved = new Map([
        ["600887", { meta: { symbol: "600887", name: "伊利股份" }, cached: true }],
        ["002380", { meta: { symbol: "002380", name: "科远智慧" }, cached: true }]
    ]);
    const lookups = [];
    const reportCache = {
        async getCachedReports(date, symbols) { lookups.push({ date, symbols }); return saved; },
        async saveCachedReport() { throw new Error("不应重新保存"); }
    };
    const klineCache = { async getCachedKlines() { throw new Error("不应拉取日K"); } };
    const result = await buildReports({
        targets: [{ symbol: "002380", name: "科远智慧" }, { symbol: "600887", name: "伊利股份" }],
        now: new Date("2026-10-28T08:00:00.000Z"), // 北京时间周三16:00
        allowPartial: true,
        klineCache,
        reportCache
    });
    assert.equal(result.skipped, false);
    assert.equal(result.date, "2026-10-28");
    assert.deepEqual(result.reports.map(report => report.meta.symbol), ["002380", "600887"]);
    assert.deepEqual(lookups, [{ date: "2026-10-28", symbols: ["002380", "600887"] }]);
    assert.deepEqual(result.unavailable, []);
});

test("只存日K完整的报告：备用源缺成交额/换手率的报告不存库，下次还能用主源重新生成", async () => {
    const { saveReports } = require("../../src/services/daily-report");
    const complete = rows("2026-10-28");
    const partial = rows("2026-10-28").map((row, index) => (index < 79 ? { ...row, turnover: NaN } : row));
    const saved = [];
    await saveReports({ async saveCachedReport(date, symbol) { saved.push([date, symbol]); } }, "2026-10-28", [
        { meta: { symbol: "600887" }, klines: complete },
        { meta: { symbol: "002380" }, klines: partial }
    ]);
    assert.deepEqual(saved, [["2026-10-28", "600887"]]);
});
