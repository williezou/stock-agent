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
