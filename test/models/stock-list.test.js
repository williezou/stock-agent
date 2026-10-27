const test = require("node:test");
const assert = require("node:assert/strict");
const { createSinaListSource, createStockListService } = require("../../src/models/market/stock-list");

function fakeSource(name, { fail = false, rowsFor } = {}) {
    const calls = [];
    return {
        name,
        calls,
        async fetchPage(query) {
            calls.push(query);
            if (fail) throw new Error(`${name} down`);
            return rowsFor(query);
        }
    };
}

// 每页代码互不重复：第p页为 600000+(p-1)*100 起的n只
const page = (n, changePct = 1, p = 1) => Array.from({ length: n }, (_, i) => ({ symbol: String(600000 + (p - 1) * 100 + i), changePct }));

test("主源失败后切换备用源，并在本次运行中不再请求主源", async () => {
    const primary = fakeSource("东方财富", { fail: true });
    const fallback = fakeSource("新浪", { rowsFor: q => page(100, 1, q.page) });
    const service = createStockListService({ sources: [primary, fallback] });
    const pool = await service.getLiquidPool();
    assert.equal(pool.length, 200, "选股池拉取两页");
    assert.equal(primary.calls.length, 1);
    assert.deepEqual(fallback.calls.map(q => [q.page, q.sortBy, q.descending]), [[1, "turnover", true], [2, "turnover", true]]);
});

test("涨跌停榜单翻页直到越过涨跌停区间", async () => {
    const source = fakeSource("东方财富", { rowsFor: q => page(100, q.page === 1 ? 10 : 3, q.page) });
    const { gainers, losers } = await createStockListService({ sources: [source, source] }).getMovers();
    assert.equal(gainers.rows.length, 200);
    assert.equal(gainers.capped, false);
    assert.equal(losers.rows.length, 200);
});

test("新浪行情列表解析：成交量由股换算为手", async () => {
    const source = createSinaListSource({
        httpClient: {
            async get(url, options) {
                assert.equal(options.params.sort, "amount");
                assert.equal(options.params.asc, 0);
                return { data: '[{"code":"600519","name":"贵州茅台","trade":"1355.900","pricechange":5.92,"changepercent":0.439,"settlement":"1349.980","volume":3866914}]' };
            }
        },
        requestWithRetry: fn => fn()
    });
    const [row] = await source.fetchPage({ page: 1, sortBy: "turnover", descending: true });
    assert.deepEqual(row, {
        symbol: "600519", name: "贵州茅台", price: 1355.9, changePct: 0.439, change: 5.92,
        volume: 38669.14, prevClose: 1349.98, listingDate: ""
    });
});

test("中途切换数据源导致的跨页重复股票会被去重", async () => {
    let call = 0;
    const primary = fakeSource("东方财富", {
        rowsFor: () => {
            if (call++ > 0) throw new Error("第二页失败");
            return page(100, 10);
        }
    });
    // 新浪第2页与东方财富第1页末尾有10只重叠
    const fallback = fakeSource("新浪", {
        rowsFor: q => Array.from({ length: 100 }, (_, i) => ({ symbol: String(600090 + i), changePct: q.sortBy === "changePct" ? 3 : 1 }))
    });
    const service = createStockListService({ sources: [primary, fallback] });
    const pool = await service.getLiquidPool();
    assert.equal(pool.length, 190);
    assert.equal(new Set(pool.map(row => row.symbol)).size, 190);
});

test("新浪页码越界返回null时视为空页", async () => {
    const source = createSinaListSource({ httpClient: { async get() { return { data: "null" }; } }, requestWithRetry: fn => fn() });
    assert.deepEqual(await source.fetchPage({ page: 99, sortBy: "turnover", descending: true }), []);
});
