const test = require("node:test");
const assert = require("node:assert/strict");
const { StockLink } = require("../../src/views/stock-link");

test("名称本身链接东方财富手机版行情页，代码保持可复制", () => {
    assert.equal(
        new StockLink("002249", "大洋电机").html(),
        '<a href="https://wap.eastmoney.com/quote/stock/0.002249.html">大洋电机</a> <code>002249</code>'
    );
});

test("沪市代码使用东方财富市场前缀1；可加粗、可省略代码、可追加标签", () => {
    const stock = StockLink.of({ symbol: "600519", name: "贵州茅台" });
    assert.equal(stock.appUrl("eastmoney"), "https://wap.eastmoney.com/quote/stock/1.600519.html");
    assert.equal(stock.appUrl("tonghuashun"), "https://m.10jqka.com.cn/stockpage/hs_600519/");
    const html = stock.html({ bold: true, code: false, extraLinks: [{ label: "📋", url: "https://t.me/bot?start=x" }] });
    assert.equal(html, '<a href="https://wap.eastmoney.com/quote/stock/1.600519.html"><b>贵州茅台</b></a> <a href="https://t.me/bot?start=x">📋</a>');
    assert.equal(stock.appLinksLine(), '<a href="https://wap.eastmoney.com/quote/stock/1.600519.html">东方财富</a>｜<a href="https://m.10jqka.com.cn/stockpage/hs_600519/">同花顺</a>');
    assert.throws(() => stock.appUrl("xueqiu"), /未知的App/);
});

test("只有代码时以代码开头；名称中的HTML字符会被转义", () => {
    assert.equal(new StockLink("000001").html(), "<code>000001</code>", "没有名称时只显示可复制的代码");
    assert.match(new StockLink("000001", "A&B<股>").html(), /^<a [^>]+>A&amp;B&lt;股&gt;<\/a> <code>/);
    assert.deepEqual(StockLink.apps.map(app => app.label), ["东方财富", "同花顺"]);
});

test("带App全称的按钮行，可追加按钮", () => {
    assert.deepEqual(new StockLink("002249").appButtonRow([{ text: "电脑版", url: "https://example.com" }]), [
        { text: "东方财富", url: "https://wap.eastmoney.com/quote/stock/0.002249.html" },
        { text: "同花顺", url: "https://m.10jqka.com.cn/stockpage/hs_002249/" },
        { text: "电脑版", url: "https://example.com" }
    ]);
});

test("text() 输出转义后的纯文本名称，无名称时为代码", () => {
    assert.equal(new StockLink("002249", "A&B").text(), "A&amp;B");
    assert.equal(new StockLink("002249").text(), "002249");
});
