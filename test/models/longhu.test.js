const test = require("node:test");
const assert = require("node:assert/strict");
const { createLonghuService } = require("../../src/models/market/longhu");

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

function serviceReturning(data, calls = []) {
    return createLonghuService({
        httpClient: { async get(url, options) { calls.push(options.params); return { data }; } },
        requestWithRetry: fn => fn()
    });
}

test("按日期获取龙虎榜：合并同一股票的上榜原因，按净买入额排序且不截断", async () => {
    const rows = [
        boardRow("600010", "2026-10-27", "日涨幅偏离值达7%", 5e7),
        boardRow("600010", "2026-10-27", "日换手率达20%", 5e7),
        ...Array.from({ length: 40 }, (_, i) => boardRow(String(600100 + i), "2026-10-27", "连续三日涨幅偏离20%", i * 1e5)),
        boardRow("000001", "2026-10-27", "日跌幅偏离值达7%", -3e7)
    ];
    const calls = [];
    const board = await serviceReturning({ success: true, result: { data: rows } }, calls).getBoardByDate("2026-10-27");
    assert.match(calls[0].filter, /TRADE_DATE<='2026-10-27'.*TRADE_DATE>='2026-10-27'/);
    assert.equal(board.length, 42);
    assert.equal(board[0].symbol, "600010");
    assert.equal(board[0].reason, "日涨幅偏离值达7%；日换手率达20%");
    assert.equal(board.at(-1).symbol, "000001");
    assert.deepEqual(
        Object.keys(board[0]).sort(),
        ["boardDate", "changePct", "dealAmount", "name", "netAmount", "price", "reason", "symbol", "turnoverRate"]
    );
    assert.equal(board[0].price, 12.34);
    assert.equal(board[0].boardDate, "2026-10-27");
});

test("龙虎榜尚未发布（返回数据为空）时得到空列表", async () => {
    const board = await serviceReturning({ result: null, success: false, message: "返回数据为空", code: 9201 }).getBoardByDate("2026-10-28");
    assert.deepEqual(board, []);
});

test("龙虎榜接口失败时抛错，便于调度区分“未发布”与“取数失败”", async () => {
    await assert.rejects(longhu.getBoardByDate("2026-10-27"), /离线测试不应联网/);
    await assert.rejects(
        serviceReturning({ success: false, message: "系统繁忙", code: 500 }).getBoardByDate("2026-10-27"),
        /系统繁忙/
    );
});

test("龙虎榜明细多页时逐页拉全", async () => {
    const calls = [];
    const pages = {
        1: [boardRow("600001", "2026-10-27", "日涨幅偏离值达7%", 3e7)],
        2: [boardRow("000002", "2026-10-27", "日跌幅偏离值达7%", -9e7)]
    };
    const service = createLonghuService({
        httpClient: {
            async get(url, options) {
                calls.push(options.params.pageNumber);
                return { data: { success: true, result: { pages: 2, data: pages[options.params.pageNumber] } } };
            }
        },
        requestWithRetry: fn => fn()
    });
    const board = await service.getBoardByDate("2026-10-27");
    assert.deepEqual(calls, [1, 2]);
    assert.deepEqual(board.map(item => item.symbol), ["600001", "000002"]);
});
