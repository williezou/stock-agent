const test = require("node:test");
const assert = require("node:assert/strict");
const { createLonghuService } = require("../../src/models/market/longhu");
const { createEastmoneyLonghuSource } = require("../../src/models/market/sources/eastmoney-longhu");
const { createTonghuashunLonghuSource, parseThsLonghuReport } = require("../../src/models/market/sources/tonghuashun-longhu");

// 离线行情，覆盖各板块涨跌停边界
const MOCK_STOCKS = [
    { symbol: "600000", name: "主板涨停", price: 11, changePct: 10.0, volume: 100, change: 1, prevClose: 10 },
    { symbol: "600001", name: "主板跌停", price: 9, changePct: -10.0, volume: 100, change: -1, prevClose: 10 },
    { symbol: "300001", name: "创业涨停", price: 12, changePct: 20.0, volume: 100, change: 2, prevClose: 10 },
    { symbol: "688001", name: "科创跌停", price: 8, changePct: -20.0, volume: 100, change: -2, prevClose: 10 },
    { symbol: "830001", name: "北交涨停", price: 13, changePct: 30.0, volume: 100, change: 3, prevClose: 10 },
    { symbol: "600002", name: "ST退市", price: 9.5, changePct: -5.0, volume: 100, change: -0.5, prevClose: 10 },
    { symbol: "300002", name: "创业大涨", price: 11.5, changePct: 15.0, volume: 100, change: 1.5, prevClose: 10 },
    { symbol: "600003", name: "普通上涨", price: 10.3, changePct: 3.0, volume: 100, change: 0.3, prevClose: 10 },
    { symbol: "600004", name: "普通下跌", price: 9.7, changePct: -3.0, volume: 100, change: -0.3, prevClose: 10 }
];

const longhu = createLonghuService({
    httpClient: { async get() { throw new Error("离线测试不应联网"); } },
    requestWithRetry: fn => fn()
});

test("按板块幅度识别涨停，创业板15%不算涨停", async () => {
    const symbols = (await longhu.getContinuousRiseStocks(MOCK_STOCKS)).map(s => s.symbol);
    assert.deepEqual(symbols, ["830001", "300001", "600000"]);
});

test("按板块幅度识别跌停，ST按5%判断", async () => {
    const symbols = (await longhu.getContinuousDeclineStocks(MOCK_STOCKS)).map(s => s.symbol);
    assert.deepEqual(symbols, ["688001", "600001", "600002"]);
});

function boardRow(code, date, reason, netAmount = 1e7) {
    return {
        SECURITY_CODE: code,
        SECURITY_NAME_ABBR: `股票${code}`,
        TRADE_DATE: `${date} 00:00:00`,
        CLOSE_PRICE: "12.34",
        CHANGE_RATE: "9.98",
        TURNOVERRATE: "15.2",
        EXPLANATION: reason,
        BILLBOARD_NET_AMT: netAmount,
        BILLBOARD_DEAL_AMT: Math.abs(netAmount) * 3
    };
}

function eastmoneyReturning(data, calls = []) {
    return createEastmoneyLonghuSource({
        httpClient: { async get(url, options) { calls.push(options.params); return { data }; } },
        requestWithRetry: fn => fn()
    });
}

test("东方财富：按日期获取，合并同一股票的上榜原因且不截断", async () => {
    const rows = [
        boardRow("600010", "2026-10-27", "日涨幅偏离值达7%", 5e7),
        boardRow("600010", "2026-10-27", "日换手率达20%", 5e7),
        ...Array.from({ length: 40 }, (_, i) => boardRow(String(600100 + i), "2026-10-27", "连续三日涨幅偏离20%", i * 1e5)),
        boardRow("000001", "2026-10-27", "日跌幅偏离值达7%", -3e7)
    ];
    const calls = [];
    const board = await eastmoneyReturning({ success: true, result: { data: rows } }, calls).getBoardByDate("2026-10-27");
    assert.match(calls[0].filter, /TRADE_DATE<='2026-10-27'.*TRADE_DATE>='2026-10-27'/);
    assert.equal(board.length, 42);
    const merged = board.find(item => item.symbol === "600010");
    assert.equal(merged.reason, "日涨幅偏离值达7%；日换手率达20%");
    assert.deepEqual(
        Object.keys(merged).sort(),
        ["boardDate", "changePct", "dealAmount", "name", "netAmount", "price", "reason", "symbol", "turnoverRate"]
    );
    assert.equal(merged.price, 12.34);
    assert.equal(merged.boardDate, "2026-10-27");
});

test("东方财富：返回数据为空（未发布）时得到空列表，业务失败时抛错", async () => {
    assert.deepEqual(await eastmoneyReturning({ result: null, success: false, message: "返回数据为空", code: 9201 }).getBoardByDate("2026-10-28"), []);
    await assert.rejects(eastmoneyReturning({ success: false, message: "系统繁忙", code: 500 }).getBoardByDate("2026-10-27"), /系统繁忙/);
});

test("东方财富：明细多页时逐页拉全", async () => {
    const calls = [];
    const pages = {
        1: [boardRow("600001", "2026-10-27", "日涨幅偏离值达7%", 3e7)],
        2: [boardRow("000002", "2026-10-27", "日跌幅偏离值达7%", -9e7)]
    };
    const source = createEastmoneyLonghuSource({
        httpClient: {
            async get(url, options) {
                calls.push(options.params.pageNumber);
                return { data: { success: true, result: { pages: 2, data: pages[options.params.pageNumber] } } };
            }
        },
        requestWithRetry: fn => fn()
    });
    const board = await source.getBoardByDate("2026-10-27");
    assert.deepEqual(calls, [1, 2]);
    assert.deepEqual(board.map(item => item.symbol), ["600001", "000002"]);
});

// 与同花顺龙虎榜日报页面结构一致的精简片段
const THS_HTML = `<html><body>
<td><span><a href="javascript: void(0);" stockcode="002249">大洋电机</a>
<i class="c-rise">10.00%</i></span></td>
<td><span><a href="javascript: void(0);" stockcode="000678">襄阳轴承</a>
<i class="c-rise">10.03%</i></span></td>
<div class="stockcont" stockcode="002249" rid='002249_3' style="display:none;">
<p>大洋电机(002249)明细：日涨幅偏离值达7%的证券</p>
<div class="cell-cont cjmx"><p style="padding: 7px 0;">
成交额：4.70亿元&nbsp;
合计买入：<span class="c-rise">3.85</span>亿元&nbsp;
合计卖出：<span class="c-fall">8428.21</span>万元&nbsp;
净额：<span class="c-rise">3.01</span>亿元
</p><table><thead><tr><th>净额/万</th></tr></thead><tbody><tr><td>5696.79</td></tr></tbody></table></div></div>
<div class="stockcont" stockcode="000678" rid='000678_1' style="display:none;">
<p>襄阳轴承(000678)明细：日涨幅偏离值达7%的证券</p>
<p>成交额：2.94亿元&nbsp;合计买入：<span class="c-rise">9165.20</span>万元&nbsp;合计卖出：<span class="c-fall">2.03</span>亿元&nbsp;净额：<span class="c-fall">-1.11</span>亿元</p></div>
<div class="stockcont" stockcode="000678" rid='000678_2' style="display:none;">
<p>襄阳轴承(000678)明细：连续三个交易日内，涨幅偏离值累计达20%的证券</p>
<p>成交额：3.50亿元&nbsp;净额：<span class="c-fall">-5000.00</span>万元</p></div>
<div class="stockcont" stockcode="118077" rid='118077_61' style="display:none;">
<p>莱特转债(118077)明细：日涨幅偏离值达30%的证券</p><p>成交额：1.00亿元&nbsp;净额：<span class="c-rise">0.10</span>亿元</p></div>
</body></html>`;

test("同花顺：解析明细块，金额换算为元，多次上榜合并原因并保留净买入最大的一条", () => {
    const board = parseThsLonghuReport(THS_HTML, "2026-10-27");
    assert.equal(board.length, 2, "可转债等非股票品种被过滤");
    const [dayang, xiangyang] = board;
    assert.deepEqual(
        { symbol: dayang.symbol, name: dayang.name, changePct: dayang.changePct, netAmount: dayang.netAmount, dealAmount: dayang.dealAmount, boardDate: dayang.boardDate },
        { symbol: "002249", name: "大洋电机", changePct: 10, netAmount: 3.01e8, dealAmount: 4.7e8, boardDate: "2026-10-27" }
    );
    assert.equal(xiangyang.reason, "日涨幅偏离值达7%的证券；连续三个交易日内，涨幅偏离值累计达20%的证券");
    assert.equal(xiangyang.netAmount, -5e7, "-0.5亿大于-1.11亿");
    assert.equal(xiangyang.dealAmount, 3.5e8);
});

test("同花顺：同一股票首条明细缺净额时，后续明细的负净额仍能生效", () => {
    const html = `<div class="stockcont" stockcode="000001"><p>平安银行(000001)明细：日跌幅偏离值达7%的证券</p><p>成交额：1.00亿元</p></div>
<div class="stockcont" stockcode="000001"><p>平安银行(000001)明细：日换手率达20%的证券</p><p>成交额：2.00亿元&nbsp;净额：<span class="c-fall">-1.11</span>亿元</p></div>`;
    const [item] = parseThsLonghuReport(html, "2026-10-27");
    assert.equal(item.netAmount, -1.11e8);
    assert.equal(item.dealAmount, 2e8);
});

function thsSourceReturning(html) {
    return createTonghuashunLonghuSource({
        httpClient: {
            async get() {
                return { data: Buffer.from(html, "utf8"), headers: { "content-type": "text/html; charset=utf-8" } };
            }
        },
        requestWithRetry: fn => fn()
    });
}

test("同花顺：未发布或非交易日返回“没有符合条件的数据”，得到空列表；无法识别的页面抛错以切换备用源", async () => {
    assert.deepEqual(await thsSourceReturning('<div class="ggmx">没有符合条件的数据</div>').getBoardByDate("2026-10-28"), []);
    await assert.rejects(thsSourceReturning("<html><body>访问过于频繁</body></html>").getBoardByDate("2026-10-27"), /无法识别/);
});

function fakeSource(name, result) {
    const source = {
        name,
        calls: 0,
        async getBoardByDate() {
            source.calls++;
            if (result instanceof Error) throw result;
            return result;
        }
    };
    return source;
}

const board = (...rows) => rows.map(([symbol, netAmount]) => ({ symbol, netAmount }));

test("主备切换：同花顺有数据时只用同花顺，并按净买入额排序", async () => {
    const ths = fakeSource("同花顺", board(["000001", -1], ["600000", 5]));
    const em = fakeSource("东方财富", board(["999999", 1]));
    const result = await createLonghuService({ boardSources: [ths, em] }).getBoardByDate("2026-10-27");
    assert.deepEqual(result.map(item => item.symbol), ["600000", "000001"]);
    assert.equal(em.calls, 0);
});

test("主备切换：同花顺失败时改用东方财富；同花顺为空时向东方财富确认一次", async () => {
    const em = fakeSource("东方财富", board(["600000", 5]));
    const failed = await createLonghuService({ boardSources: [fakeSource("同花顺", new Error("403")), em] }).getBoardByDate("2026-10-27");
    assert.deepEqual(failed.map(item => item.symbol), ["600000"]);
    assert.equal(em.calls, 1);

    const em2 = fakeSource("东方财富", board(["600001", 5]));
    const empty = await createLonghuService({ boardSources: [fakeSource("同花顺", []), em2] }).getBoardByDate("2026-10-27");
    assert.deepEqual(empty.map(item => item.symbol), ["600001"], "同花顺解析为空但东方财富有数据");
});

test("主备切换：同花顺为空且东方财富失败时按未发布处理；两个源都失败时抛错", async () => {
    const notPublished = await createLonghuService({
        boardSources: [fakeSource("同花顺", []), fakeSource("东方财富", new Error("ECONNRESET"))]
    }).getBoardByDate("2026-10-28");
    assert.deepEqual(notPublished, []);

    await assert.rejects(
        createLonghuService({ boardSources: [fakeSource("同花顺", new Error("403")), fakeSource("东方财富", new Error("ECONNRESET"))] }).getBoardByDate("2026-10-27"),
        /ECONNRESET/
    );
});
