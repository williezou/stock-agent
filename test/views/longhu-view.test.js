const test = require("node:test");
const assert = require("node:assert/strict");
const { compactReason, formatLonghuMessage } = require("../../src/views/longhu-view");

function item(symbol, netAmount, changePct = 5, reason = "日涨幅偏离值达7%") {
    return { symbol, name: `股票${symbol}`, changePct, netAmount, reason };
}

test("龙虎榜消息包含分市场统计、净买入/净卖出排行与关闭提示", () => {
    const board = [
        ...Array.from({ length: 12 }, (_, i) => item(String(600100 + i), (12 - i) * 1e7)),
        item("000001", -2e8, -9.9, "日跌幅偏离值达7%"),
        item("300001", -5e7, -3),
        item("830001", 1e6)
    ];
    const text = formatLonghuMessage({ date: "2026-10-27", board });
    assert.match(text, /龙虎榜｜2026-10-27/);
    assert.match(text, /上榜15只（沪12 深2 北1）/);
    assert.match(text, /净买入前10/);
    assert.match(text, /净卖出前2/);
    assert.match(text, /1\. <code>000001<\/code> 股票000001 -9\.90%｜净额 -2\.00亿元/);
    assert.match(text, /\/longhu off/);
    assert.ok(text.indexOf("600100") < text.indexOf("600101"));
    assert.doesNotMatch(text, /600111/, "第12名不在净买入前10");
});

test("超长上榜原因会被截断并转义", () => {
    const text = formatLonghuMessage({ date: "2026-10-27", board: [item("600000", 1e7, 1, "<异常>".repeat(20))] });
    assert.match(text, /&lt;异常&gt;/);
    assert.match(text, /…/);
});

test("上榜原因压缩为简短说法并去重", () => {
    assert.equal(compactReason("连续三个交易日内，涨幅偏离值累计达到20%的证券"), "3日涨幅偏离20%");
    assert.equal(compactReason("非ST、*ST和S证券连续三个交易日内收盘价格跌幅偏离值累计达到20%的证券"), "3日跌幅偏离20%");
    assert.equal(compactReason("日涨幅偏离值达到7%的前5只证券；有价格涨跌幅限制的日换手率达到20%的前五只证券"), "日涨幅偏离7%、换手率20%");
    assert.equal(compactReason("日涨幅达到15%的前5只证券"), "日涨幅15%");
    assert.equal(compactReason("日涨幅偏离值达到7%的前5只证券；日涨幅偏离值达到7%的前5只证券"), "日涨幅偏离7%");
    assert.equal(compactReason("有价格涨跌幅限制的连续3个交易日内收盘价格涨幅偏离值累计达到30%的证券"), "3日涨幅偏离30%");
    assert.equal(compactReason("有价格涨跌幅限制的日收盘价格跌幅偏离值达到7%的前五只证券"), "日跌幅偏离7%");
    assert.equal(compactReason("有价格涨跌幅限制的日价格振幅达到15%的前五只证券"), "振幅15%");
    assert.equal(compactReason("日振幅值达到15%的前5只证券"), "振幅15%");
    assert.equal(compactReason("当日换手率达到20%的前5只股票"), "换手率20%");
    assert.equal(compactReason("有价格涨跌幅限制的日收盘价格跌幅达到15%的前五只证券"), "日跌幅15%");
    assert.equal(compactReason("退市整理期"), "退市整理");
    assert.equal(compactReason("北交所股票连续3个交易日内日收盘价涨跌幅偏离值累计达到+40%(-40%)"), "3日涨跌幅偏离40%");
    assert.equal(compactReason("当日收盘价跌幅达到-20%的前5只股票"), "日跌幅20%");
    assert.equal(compactReason("有价格涨跌幅限制的连续10个交易日内收盘价格跌幅偏离值累计达到-50%的证券"), "10日跌幅偏离50%");
    assert.equal(compactReason("严重异常期间日收盘价格涨幅偏离值累计达到100%的证券"), "严重异常涨幅偏离100%");
    // 同花顺措辞
    assert.equal(compactReason("日涨幅偏离值达7%的证券;日振幅值达15%的证券;日换手率达20%的证券"), "日涨幅偏离7%、振幅15%、换手率20%");
    assert.equal(compactReason("连续三个交易日内,涨幅偏离值累计达20%的证券"), "3日涨幅偏离20%");
    assert.equal(compactReason("连续3个交易日内收盘价格跌幅较基准指数偏离值累计达到-30%的证券"), "3日跌幅偏离30%");
    assert.equal(compactReason("有价格涨跌幅限制的日价格振幅达到30%的证券;有价格涨跌幅限制的日收盘价格涨幅达到20%的证券"), "振幅30%、日涨幅20%");
    assert.equal(compactReason("其他异常波动"), "其他异常波动");
});
