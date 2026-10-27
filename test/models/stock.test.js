const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTarget, normalizeSymbol } = require("../../src/models/stock");

test("支持常见沪深股票代码写法", () => {
    assert.equal(normalizeSymbol("600519"), "600519");
    assert.equal(normalizeSymbol("SH600519"), "600519");
    assert.equal(normalizeSymbol("002380.SZ"), "002380");
    assert.equal(normalizeSymbol("688001"), "688001");
    assert.equal(normalizeSymbol("800001"), null);
});

test("动态股票配置包含交易所、行情链接和默认关键词", () => {
    const target = buildTarget("600519", "贵州茅台");
    assert.equal(target.exchangeCode, "600519.SH");
    assert.match(target.quoteUrl, /sh600519/);
    assert.ok(target.keywords.includes("贵州茅台"));
});

test("工作日时间窗口判断", () => {
    const { isWeekdayWindow, minutesOfDay } = require("../../src/models/market/trading-calendar");
    const tuesday1730 = new Date("2026-10-27T09:30:00.000Z");
    assert.equal(minutesOfDay(tuesday1730), 17 * 60 + 30);
    assert.equal(isWeekdayWindow(tuesday1730, 17 * 60 + 30, 18 * 60), true);
    assert.equal(isWeekdayWindow(tuesday1730, 15 * 60, 17 * 60 + 30), false, "结束时刻不含");
    assert.equal(isWeekdayWindow(new Date("2026-11-01T09:30:00.000Z"), 0, 24 * 60), false, "周日");
});
