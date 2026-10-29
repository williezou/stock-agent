const test = require("node:test");
const assert = require("node:assert/strict");
const { QuoteApp } = require("../../src/views/quote-app");
const { StockLink, stockButtonLegend, stockButtonMarkup, stockLinkLegend } = require("../../src/views/stock-link");

test("名称本身链接东方财富手机版行情页，代码保持可复制", () => {
    assert.equal(
        new StockLink("002249", "大洋电机").html(),
        '<a href="https://mlink.eastmoney.com/h52n/nlink.html?type=localurl&amp;id=eastmoney%3A%2F%2Fpage%2Fstockpage%3Fcode%3D002249%26market%3D0">大洋电机</a> <code>002249</code>'
    );
});

test("沪市代码使用东方财富市场前缀1；可加粗、可省略代码、可追加标签", () => {
    const stock = StockLink.of({ symbol: "600519", name: "贵州茅台" });
    assert.equal(stock.url(), "https://mlink.eastmoney.com/h52n/nlink.html?type=localurl&id=eastmoney%3A%2F%2Fpage%2Fstockpage%3Fcode%3D600519%26market%3D1");
    const html = stock.html({ bold: true, code: false, extraLinks: [{ label: "📋", url: "https://t.me/bot?start=x" }] });
    assert.equal(html, '<a href="https://mlink.eastmoney.com/h52n/nlink.html?type=localurl&amp;id=eastmoney%3A%2F%2Fpage%2Fstockpage%3Fcode%3D600519%26market%3D1"><b>贵州茅台</b></a> <a href="https://t.me/bot?start=x">📋</a>');
    assert.equal(stock.appLinksLine(), `<a href="https://mlink.eastmoney.com/h52n/nlink.html?type=localurl&amp;id=eastmoney%3A%2F%2Fpage%2Fstockpage%3Fcode%3D600519%26market%3D1">东方财富</a>｜<a href="https://xueqiu.com/S/SH600519">雪球</a>｜<a href="${QuoteApp.get("cmschina").stockUrl("600519").replace(/&/g, "&amp;")}">招商证券</a>`);
});

test("只有代码时以代码开头；名称中的HTML字符会被转义", () => {
    assert.equal(new StockLink("000001").html(), "<code>000001</code>", "没有名称时只显示可复制的代码");
    assert.match(new StockLink("000001", "A&B<股>").html(), /^<a [^>]+>A&amp;B&lt;股&gt;<\/a> <code>/);
    assert.deepEqual(QuoteApp.all.map(app => app.label), ["东方财富", "雪球", "招商证券"]);
});

test("带App全称的按钮行，可追加按钮", () => {
    assert.deepEqual(new StockLink("002249").appButtonRow([{ text: "电脑版", url: "https://example.com" }]), [
        { text: "东方财富", url: "https://mlink.eastmoney.com/h52n/nlink.html?type=localurl&id=eastmoney%3A%2F%2Fpage%2Fstockpage%3Fcode%3D002249%26market%3D0" },
        { text: "雪球", url: "https://xueqiu.com/S/SZ002249" },
        { text: "招商证券", url: QuoteApp.get("cmschina").stockUrl("002249") },
        { text: "电脑版", url: "https://example.com" }
    ]);
});

test("text() 输出转义后的纯文本名称，无名称时为代码", () => {
    assert.equal(new StockLink("002249", "A&B").text(), "A&amp;B");
    assert.equal(new StockLink("002249").text(), "002249");
});

test("所选App：名称链接、按钮与说明都用该App，按钮行与链接行把它排在最前", () => {
    const xueqiu = QuoteApp.get("xueqiu");
    const stock = new StockLink("600519", "贵州茅台", xueqiu);
    assert.equal(stock.html({ code: false }), '<a href="https://xueqiu.com/S/SH600519">贵州茅台</a>');
    assert.deepEqual(stock.appButtonRow().map(button => button.text), ["雪球", "东方财富", "招商证券"]);
    assert.match(stock.appLinksLine(), /^<a href="https:\/\/xueqiu.com\/S\/SH600519">雪球<\/a>｜/);
    assert.equal(new StockLink("300308", "中际旭创", QuoteApp.get("cmschina")).url(), QuoteApp.get("cmschina").stockUrl("300308"));
    assert.equal(stockLinkLegend(xueqiu), "点股票名称打开雪球");
    assert.equal(stockButtonLegend(), "点下方按钮打开东方财富");
    const markup = stockButtonMarkup([{ mark: "📈", rows: [{ symbol: "600519", name: "贵 州 茅 台" }] }], { watchSymbols: new Set(["600519"]), app: xueqiu });
    assert.deepEqual(markup.inline_keyboard, [[{ text: "📈贵州茅台⭐", url: "https://xueqiu.com/S/SH600519" }]]);
});

test("雪球代码按交易所加前缀：沪市SH、深市SZ、北交所BJ", () => {
    const xueqiu = QuoteApp.get("xueqiu");
    assert.equal(xueqiu.stockUrl("600519"), "https://xueqiu.com/S/SH600519");
    assert.equal(xueqiu.stockUrl("000001"), "https://xueqiu.com/S/SZ000001");
    assert.equal(xueqiu.stockUrl("300308"), "https://xueqiu.com/S/SZ300308");
    assert.equal(xueqiu.stockUrl("920099"), "https://xueqiu.com/S/BJ920099");
    assert.equal(xueqiu.stockUrl("830799"), "https://xueqiu.com/S/BJ830799");
});

test("QuoteApp：未设置或已下线的平台退回东方财富；/app 参数可用中文名、key或别名", () => {
    assert.equal(QuoteApp.get(undefined), QuoteApp.DEFAULT);
    assert.equal(QuoteApp.get("futu"), QuoteApp.DEFAULT);
    assert.equal(QuoteApp.forSubscriber({ quote_app: "xueqiu" }).label, "雪球");
    assert.equal(QuoteApp.forSubscriber(null).key, "eastmoney");
    assert.equal(QuoteApp.find("雪球").key, "xueqiu");
    assert.equal(QuoteApp.find(" XQ ").key, "xueqiu");
    assert.equal(QuoteApp.find("同花顺"), null);
    assert.equal(QuoteApp.get("tonghuashun"), QuoteApp.DEFAULT, "以前选过同花顺的用户退回东方财富");
    assert.equal(QuoteApp.find("xueqiu").key, "xueqiu");
    assert.equal(QuoteApp.find("富途"), null);
});

test("QuoteApp.memo：共用内容每个App只生成一次", () => {
    const calls = [];
    const render = QuoteApp.memo(app => { calls.push(app.key); return `text-${app.key}`; });
    assert.equal(render(QuoteApp.get("xueqiu")), "text-xueqiu");
    assert.equal(render(QuoteApp.get("xueqiu")), "text-xueqiu");
    assert.equal(render(undefined), "text-eastmoney");
    assert.deepEqual(calls, ["xueqiu", "eastmoney"]);
});

test("招商证券：与App分享截图二维码的地址一致（沪市1、深市0），北交所2", () => {
    const cms = QuoteApp.get("cmschina");
    assert.equal(cms.stockUrl("600999"), "https://weixin.newone.com.cn/app/share/index.html?path=stock/quote%2Fstock%3FjsonParam%3D%257B%2522stock%2522%253A%255B%257B%2522ZQSETCODE%2522%253A%25221%2522%252C%2522ZQCODE%2522%253A%2522600999%2522%257D%255D%252C%2522index%2522%253A0%257D");
    const jsonParam = url => JSON.parse(decodeURIComponent(decodeURIComponent(new URL(url).search.slice("?path=stock/".length)).split("jsonParam=")[1]));
    assert.equal(cms.stockUrl("000001"), "https://weixin.newone.com.cn/app/share/index.html?path=stock/quote%2Fstock%3FjsonParam%3D%257B%2522stock%2522%253A%255B%257B%2522ZQSETCODE%2522%253A%25220%2522%252C%2522ZQCODE%2522%253A%2522000001%2522%257D%255D%252C%2522index%2522%253A0%257D");
    assert.deepEqual(jsonParam(cms.stockUrl("920099")).stock, [{ ZQSETCODE: "2", ZQCODE: "920099" }]);
    assert.equal(QuoteApp.find("招商").key, "cmschina");
});
