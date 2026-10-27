const test = require("node:test");
const assert = require("node:assert/strict");
const { formatScanDelivery, formatScanSummary, rankActionable } = require("../../src/views/scan-view");
const { pickByStyle } = require("../../src/services/screening");

const STYLES = ["intraday", "short", "swing", "mid"];

function item(symbol, score) {
    return { symbol, name: `股票${symbol}`, score, gap: "1.00%", news: [], announcements: [] };
}

function report(symbol, style, recommendation, rewardRisk = 2) {
    return {
        style,
        meta: { symbol, name: `股票${symbol}`, exchangeCode: `${symbol}.SH`, quoteUrl: "" },
        klines: [],
        analysis: {
            latest: { close: 10, changePct: 1.5, open: 10, high: 10, low: 10, amount: 1e8, turnover: 3 },
            ma: {},
            volumeRatio: 1.4,
            support: 9.5,
            resistance: 11,
            weightedClose20: 10
        },
        plan: {
            recommendation,
            reason: "测试理由",
            entryLow: 9.4,
            entryHigh: 9.6,
            breakoutTrigger: 11,
            stop: 8.9,
            target: 11,
            rewardRisk,
            overheated: false
        },
        news: [],
        announcements: []
    };
}

test("每只股票只出现在一个分类，且优先归入得分最高的分类", () => {
    const picks = pickByStyle({
        intraday: [item("600001", 9), item("600002", 8), item("600003", 7)],
        short: [item("600001", 10), item("600004", 6)],
        swing: [item("600002", 5)],
        mid: [item("600002", 4)]
    }, STYLES, 2);
    const symbols = STYLES.flatMap(style => picks[style].map(pick => pick.symbol));
    assert.equal(new Set(symbols).size, symbols.length);
    assert.deepEqual(picks.short.map(pick => pick.symbol), ["600001", "600004"]);
    assert.deepEqual(picks.intraday.map(pick => pick.symbol), ["600002", "600003"]);
    assert.deepEqual(picks.swing, []);
    assert.deepEqual(picks.mid, []);
});

test("可操作标的按信号强度和盈亏比排序", () => {
    const ranked = rankActionable([
        report("600001", "short", "观望"),
        report("600002", "short", "等待企稳后试仓", 3),
        report("600003", "mid", "条件性试仓", 1.5),
        report("600004", "mid", "等待企稳后试仓", 4)
    ]);
    assert.deepEqual(ranked.map(r => r.meta.symbol), ["600003", "600004", "600002"]);
});

test("扫描结论包含操作建议，市场热点排除已入选股票", () => {
    const picksByStyle = {
        intraday: [{ item: item("600001", 9), report: report("600001", "intraday", "条件性试仓") }],
        short: [{ item: item("600002", 9), report: null }],
        swing: [],
        mid: [{ item: item("600003", 9), report: report("600003", "mid", "观望") }]
    };
    const text = formatScanSummary({
        now: "2026-10-27 16:00",
        picksByStyle,
        longhiData: {
            riseStocks: [{ symbol: "600001", name: "股票600001", changePct: 10 }, { symbol: "600009", name: "热门股", changePct: 10 }],
            declineStocks: []
        }
    });
    assert.match(text, /今日结论/);
    assert.match(text, /可操作1只/);
    assert.match(text, /条件性试仓/);
    assert.match(text, /其余1只暂以观望为主/);
    assert.match(text, /K线数据不足/);
    assert.match(text, /波段<\/b>\n无符合条件标的/);
    assert.match(text, /涨停：热门股/);
    assert.doesNotMatch(text.split("市场热点")[1], /股票600001/);
    assert.match(text, /不构成投资建议/);
});

test("每个分类一张总览图，个股图只发给可操作标的", () => {
    const picksByStyle = {
        intraday: [
            { item: item("600001", 9), report: report("600001", "intraday", "条件性试仓") },
            { item: item("600002", 8), report: report("600002", "intraday", "观望") }
        ],
        short: [],
        swing: [{ item: item("600003", 9), report: report("600003", "swing", "等待企稳后试仓") }],
        mid: []
    };
    const delivery = formatScanDelivery({ picksByStyle, date: "2026-10-27" });
    assert.deepEqual(delivery.overviews.map(o => [o.style, o.reports.length]), [["intraday", 2], ["swing", 1]]);
    assert.deepEqual(delivery.stocks.map(s => s.report.meta.symbol), ["600001", "600003"]);
});

test("超长催化链接降级为纯文本标题而不是抛错", () => {
    const { formatStockCaption } = require("../../src/views/daily-report-view");
    const longReport = report("600001", "short", "条件性试仓");
    longReport.analysis.macd = {};
    longReport.analysis.kdj = {};
    longReport.analysis.bollinger = {};
    longReport.news = [{ title: "重大合同公告", url: `https://example.com/a?${"x=1&".repeat(200)}` }];
    const caption = formatStockCaption(longReport, "2026-10-27");
    assert.ok(caption.length <= 1024);
    assert.match(caption, /📰 重大合同公告/);
    assert.doesNotMatch(caption, /example\.com/);
});

test("扫描结论超长时整段舍弃次要内容，不截断HTML标签", () => {
    const longName = "长".repeat(120);
    const picksByStyle = Object.fromEntries(["intraday", "short", "swing", "mid"].map((style, s) => [
        style,
        [0, 1].map(i => {
            const r = report(`60${s}00${i}`, style, "条件性试仓");
            r.plan.reason = "理".repeat(400);
            return { item: item(`60${s}00${i}`, 1), report: r };
        })
    ]));
    const hot = Array.from({ length: 30 }, (_, i) => ({ symbol: `00${i}`, name: longName, changePct: 10 }));
    const text = formatScanSummary({ now: "2026-10-27", picksByStyle, longhiData: { riseStocks: hot, declineStocks: [] } });
    assert.ok(text.length <= 4096);
    assert.match(text, /决策。<\/i>$/);
    assert.doesNotMatch(text, /市场热点/);
});

test("涨跌停榜单触顶时显示为下限", () => {
    const text = formatScanSummary({
        now: "2026-10-27",
        picksByStyle: {},
        longhiData: { riseStocks: [{ symbol: "1", name: "a", changePct: 10 }], declineStocks: [], riseCapped: true }
    });
    assert.match(text, /涨停≥1家／跌停0家/);
});
