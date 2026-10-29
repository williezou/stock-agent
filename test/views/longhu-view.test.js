const test = require("node:test");
const assert = require("node:assert/strict");
const { compactReason, formatLonghuCaption, formatLonghuMessage } = require("../../src/views/longhu-view");
const { visibleLength } = require("../../src/lib/telegram-text");

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
    assert.match(text, /1\. <a href="https:\/\/mlink\.eastmoney\.com\/h52n\/nlink\.html\?type=localurl&amp;id=eastmoney%3A%2F%2Fpage%2Fstockpage%3Fcode%3D000001%26market%3D0">股票000001<\/a> <a href="https:\/\/data\.eastmoney\.com\/stock\/lhb,2026-10-27,000001\.html">📋<\/a> <code>000001<\/code> -9\.90%｜净额 -2\.00亿元/);
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

test("图片说明只含概况；股票按钮每行3个，净卖出另起一行；席位图按钮带App全称", () => {
    const { formatLonghuKeyboard, formatSeatKeyboard, parseLonghuCallbackData } = require("../../src/views/longhu-view");
    const board = [
        ...Array.from({ length: 12 }, (_, i) => item(String(600100 + i), (12 - i) * 1e7)),
        item("000001", -2e8, -9.9)
    ];
    const caption = formatLonghuCaption({ date: "2026-10-27", board });
    assert.match(caption, /上榜13只/);
    assert.doesNotMatch(caption, /<a /);
    const rows = formatLonghuKeyboard({ date: "2026-10-27", board }).inline_keyboard;
    assert.deepEqual(rows.map(row => row.length), [3, 3, 3, 1, 1], "净买入10只=3+3+3+1，净卖出另起一行");
    assert.deepEqual(rows[0][0], { text: "股票600100", callback_data: "lhb:600100:20261027" });
    assert.equal(rows[4][0].text, "股票000001");
    assert.ok(rows.flat().every(button => Buffer.byteLength(button.callback_data) <= 64), "回调数据不超过64字节");
    assert.deepEqual(parseLonghuCallbackData("lhb:600100:20261027"), { symbol: "600100", date: "2026-10-27" });
    assert.equal(parseLonghuCallbackData("delete:600100"), null);
    assert.deepEqual(formatSeatKeyboard({ date: "2026-10-27", symbol: "002249" }).inline_keyboard[0].map(button => button.text), ["东方财富", "雪球", "招商证券", "电脑版"]);
});

test("可见长度不计HTML标签与链接地址，实体按一个字计", () => {
    assert.equal(visibleLength('<b>龙虎榜</b> <a href="https://example.com/very/long">名称</a> &lt;x&gt;'), 10);
});

test("Telegram返回的消息中取最大尺寸图片的file_id", () => {
    const { largestPhotoFileId } = require("../../src/gateways/telegram");
    assert.equal(largestPhotoFileId({ photo: [{ file_id: "s" }, { file_id: "m" }, { file_id: "l" }] }), "l");
    assert.equal(largestPhotoFileId(undefined), null);
});

test("深层链接参数可往返解析，非法参数返回null", () => {
    const { longhuStartPayload, parseLonghuStartPayload } = require("../../src/views/longhu-view");
    assert.equal(longhuStartPayload("002249", "2026-10-27"), "lhb_002249_20261027");
    assert.deepEqual(parseLonghuStartPayload("lhb_002249_20261027"), { symbol: "002249", date: "2026-10-27" });
    assert.equal(parseLonghuStartPayload("friends"), null, "邀请码不会被误认为席位查询");
    assert.equal(parseLonghuStartPayload("lhb_2249_20261027"), null);
});

test("席位明细：营业部名称精简、金额紧凑、附手机版行情链接", () => {
    const { formatSeatDetail, shortSeatName } = require("../../src/views/longhu-view");
    assert.equal(shortSeatName("国泰海通证券股份有限公司武汉紫阳东路证券营业部"), "国泰海通证券武汉紫阳东路");
    assert.equal(shortSeatName("机构专用"), "机构专用");
    const text = formatSeatDetail({
        date: "2026-10-27",
        detail: {
            symbol: "002249", name: "大洋电机", changePct: 10,
            groups: [{
                reason: "日涨幅偏离值达7%的证券", dealAmount: 4.7e8, buyTotal: 3.85e8, sellTotal: 8.43e7, netAmount: 3.01e8,
                buyers: [{ name: "国泰海通证券股份有限公司武汉紫阳东路证券营业部", buy: 122318000, sell: 39100, net: 122278900 }],
                sellers: [{ name: "深股通专用", buy: 56923900, sell: 29342900, net: 27581000 }]
            }]
        }
    });
    assert.match(text, /<a href="[^"]+"><b>大洋电机<\/b><\/a> <code>002249<\/code> \+10\.00%/);
    assert.match(text, /📌 <b>日涨幅偏离7%<\/b>/);
    assert.match(text, /1\. 国泰海通证券武汉紫阳东路\n　买1\.22亿 卖4万 净\+1\.22亿/);
    assert.match(text, /href="https:\/\/mlink\.eastmoney\.com\/h52n\/nlink\.html\?type=localurl&amp;id=eastmoney%3A%2F%2Fpage%2Fstockpage%3Fcode%3D002249%26market%3D0">东方财富/);
    assert.match(text, /href="https:\/\/xueqiu\.com\/S\/SZ002249">雪球/);
    assert.match(text, /lhb,2026-10-27,002249\.html">电脑版龙虎榜详情/);
});

test("席位表格生成有效PNG，多个上榜原因时图更高", () => {
    const { generateSeatChart } = require("../../src/views/charts/seat-chart");
    const seats = Array.from({ length: 5 }, (_, i) => ({ name: `某某证券股份有限公司第${i}证券营业部`, buy: 5e7, sell: 1e7, net: 4e7 }));
    const group = { reason: "日涨幅偏离值达7%的证券", dealAmount: 4.7e8, buyTotal: 3.85e8, sellTotal: 8.4e7, netAmount: 3.01e8, buyers: seats, sellers: seats };
    const one = generateSeatChart({ date: "2026-10-27", detail: { symbol: "002249", name: "大洋电机", changePct: 10, groups: [group] } });
    const two = generateSeatChart({ date: "2026-10-27", detail: { symbol: "002249", name: "大洋电机", changePct: 10, groups: [group, group] } });
    assert.deepEqual([...one.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(two.readUInt32BE(20) > one.readUInt32BE(20), "PNG高度随分组增加");
});
