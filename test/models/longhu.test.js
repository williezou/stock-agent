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

test("龙虎榜接口失败时返回空列表而不是抛错", async () => {
    assert.deepEqual(await longhu.getLonghiBoardList(), []);
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
        BILLBOARD_DEAL_AMT: netAmount * 3
    };
}

test("龙虎榜只保留最新交易日、按代码合并上榜原因并限制30条", async () => {
    const rows = [
        boardRow("600010", "2026-10-27", "日涨幅偏离值达7%"),
        boardRow("600010", "2026-10-27", "日换手率达20%"),
        ...Array.from({ length: 40 }, (_, i) => boardRow(String(600100 + i), "2026-10-27", "连续三日涨幅偏离20%")),
        boardRow("600999", "2026-10-26", "前一交易日")
    ];
    const service = createLonghuService({
        httpClient: { async get() { return { data: { success: true, result: { data: rows } } }; } },
        requestWithRetry: fn => fn()
    });
    const list = await service.getLonghiBoardList();
    assert.equal(list.length, 30);
    assert.ok(!list.some(item => item.symbol === "600999"), "不混入前一交易日");
    assert.equal(new Set(list.map(item => item.boardDate)).size, 1);
    const merged = list.find(item => item.symbol === "600010");
    assert.equal(merged.reason, "日涨幅偏离值达7%；日换手率达20%");
    assert.deepEqual(
        Object.keys(merged).sort(),
        ["boardDate", "boardType", "changePct", "dealAmount", "name", "netAmount", "price", "reason", "symbol", "turnoverRate"]
    );
    assert.equal(merged.price, 12.34);
    assert.equal(merged.changePct, 9.98);
});
