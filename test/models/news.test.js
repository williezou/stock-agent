const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAnnouncementList, parseSearchNews } = require("../../src/models/market/news");

test("东财公告列表：标题、日期与公告详情页地址", () => {
    const items = parseAnnouncementList({
        data: { list: [{ art_code: "AN202610271831040470", title: "青岛食品:股票交易异常波动公告", title_ch: "青岛食品:股票交易异常波动公告", notice_date: "2026-10-28 00:00:00" }, { art_code: "x", title: "" }] }
    }, "001219");
    assert.deepEqual(items, [{
        title: "青岛食品:股票交易异常波动公告",
        date: "2026-10-28",
        url: "https://data.eastmoney.com/notices/detail/001219/AN202610271831040470.html"
    }]);
    assert.deepEqual(parseAnnouncementList({}, "001219"), []);
});

test("东财资讯搜索：解析JSONP，去掉标题里的高亮标签并解码实体", () => {
    const items = parseSearchNews('cb({"code":0,"result":{"cmsArticleWebOld":[{"date":"2026-10-29 11:44:25","title":"拟易主！<em>001219</em>，&quot;四连板&quot;","content":"<em>青岛食品</em>再度涨停","mediaName":"大众证券报","url":"http://finance.eastmoney.com/a/1.html"}]}})');
    assert.deepEqual(items, [{
        title: "拟易主！001219，\"四连板\"",
        time: "2026-10-29 11:44:25",
        url: "http://finance.eastmoney.com/a/1.html",
        content: "青岛食品再度涨停",
        source: "大众证券报"
    }]);
});
