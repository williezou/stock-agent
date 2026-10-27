const test = require("node:test");
const assert = require("node:assert/strict");
const { createMarketService, parseJsonp, parseTencentKlines, parseThsKlines } = require("../market");
const { fetchKlineSets } = require("../daily-close");

const tencentPayload = {
    data: {
        sh600519: {
            qfqday: [
                ["2026-10-23", "1311.84", "1335.00", "1343.88", "1310.00", "57686"],
                ["2026-10-26", "1325.40", "1349.98", "1350.00", "1324.79", "41599"],
                ["2026-10-27", "1343.88", "1355.90", "1357.00", "1338.01", "38669"]
            ],
            qt: { sh600519: Object.assign(new Array(40).fill(""), { 1: "贵州茅台", 2: "600519", 30: "20261027161452", 37: "522680", 38: "0.31" }) }
        }
    }
};

test("腾讯日K推算涨跌幅，最新一日补齐成交额与换手率", () => {
    const rows = parseTencentKlines(tencentPayload, "600519");
    assert.deepEqual(rows.map(row => row.date), ["2026-10-26", "2026-10-27"]);
    assert.equal(rows[1].changePct.toFixed(2), "0.44");
    assert.equal(rows[1].amount, 5226800000);
    assert.equal(rows[1].turnover, 0.31);
    assert.ok(Number.isNaN(rows[0].turnover));
});

const thsHistory = 'quotebridge_v6_line_hs_600519_01_last({"name":"\\u8d35\\u5dde\\u8305\\u53f0","data":"20261023,1311.84,1343.88,1310.00,1335.00,5768593,7677216300.00,0.462,,900.00,1201500;20261026,1325.40,1350.00,1324.79,1349.98,4159916,5574287600.00,0.333,,3100.00,4184938"})';
const thsToday = 'quotebridge_v6_line_hs_600519_01_today({"hs_600519":{"1":"20261027","7":"1343.88","8":"1357.00","9":"1338.01","11":"1355.90","13":3866914,"19":"5226798700.00","1968584":"0.309"}})';

test("同花顺日K合并当日K线，成交量换算为手并带成交额换手率", () => {
    const rows = parseThsKlines(parseJsonp(thsHistory), parseJsonp(thsToday), "600519");
    assert.deepEqual(rows.map(row => row.date), ["2026-10-26", "2026-10-27"]);
    assert.equal(rows[0].volume, 41599.16);
    assert.equal(rows[0].turnover, 0.333);
    assert.equal(rows[1].close, 1355.9);
    assert.equal(rows[1].amount, 5226798700);
    assert.equal(rows[1].changePct.toFixed(2), "0.44");
    assert.equal(parseJsonp(thsHistory).name, "贵州茅台");
});

function sourceClient(failing, calls) {
    return {
        async get(url) {
            const source = url.includes("eastmoney") ? "em" : url.includes("10jqka") ? "ths" : "tx";
            if (!url.includes("today.js")) calls.push(source);
            if (failing.includes(source)) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
            if (source === "ths") return { data: url.includes("today.js") ? thsToday : thsHistory };
            return { data: tencentPayload };
        }
    };
}

test("东方财富失败时依次切换同花顺、腾讯，连续失败的源进入冷却", async () => {
    const calls = [];
    const service = createMarketService({ httpClient: sourceClient(["em"], calls), requestWithRetry: fn => fn() });
    for (let i = 0; i < 3; i++) {
        const rows = await service.getDailyKline("600519", 2);
        assert.equal(rows.at(-1).close, 1355.9);
    }
    assert.deepEqual(calls, ["em", "ths", "em", "ths", "ths"]);
    const health = service.health();
    assert.equal(health.primaryFailures, 2);
    assert.equal(health.fallbackUsed, 3);
    assert.deepEqual(health.sources, { "同花顺": 3 });
    assert.deepEqual(await service.getStockProfile("600519"), { symbol: "600519", name: "贵州茅台" });

    const txCalls = [];
    const tencentOnly = createMarketService({ httpClient: sourceClient(["em", "ths"], txCalls), requestWithRetry: fn => fn() });
    assert.equal((await tencentOnly.getDailyKline("600519", 2)).at(-1).close, 1355.9);
    assert.deepEqual(txCalls, ["em", "ths", "tx"]);

    const allDown = createMarketService({ httpClient: sourceClient(["em", "ths", "tx"], []), requestWithRetry: fn => fn() });
    await assert.rejects(allDown.getDailyKline("600519", 2));
    assert.equal(allDown.health().fallbackFailures, 1);
});

test("日K拉取限制并发，并复用当日缓存", async () => {
    let active = 0;
    let peak = 0;
    const fetched = [];
    const marketService = {
        async getDailyKline(symbol) {
            active++;
            peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
            fetched.push(symbol);
            const row = { date: symbol === "000004" ? "2026-10-26" : "2026-10-27", close: 1 };
            // 000005模拟腾讯备用数据：缺少成交额/换手率
            return [symbol === "000005" ? { ...row, amount: NaN, turnover: NaN } : { ...row, amount: 1, turnover: 1 }];
        }
    };
    const saved = [];
    const klineCache = {
        async getCachedKlines(symbol) { return symbol === "000001" ? [{ date: "2026-10-27", close: 9 }] : null; },
        async saveCachedKlines(symbol) { saved.push(symbol); }
    };
    const targets = ["000001", "000002", "000003", "000004", "000005", "000006"].map(symbol => ({ symbol }));
    const results = await fetchKlineSets(marketService, targets, { klineCache, dateStr: "2026-10-27", gapMs: 1 });
    assert.ok(peak <= 3);
    assert.equal(results[0].value[0].close, 9);
    assert.ok(!fetched.includes("000001"));
    assert.ok(saved.includes("000002"));
    assert.ok(!saved.includes("000004"), "未收定的日K不缓存");
    assert.ok(!saved.includes("000005"), "字段不完整的备用源日K不缓存");
});

test("并发worker共享请求间隔", async () => {
    const started = [];
    const marketService = {
        async getDailyKline() {
            started.push(Date.now());
            return [];
        }
    };
    await fetchKlineSets(marketService, [1, 2, 3, 4].map(i => ({ symbol: String(i) })), { gapMs: 40 });
    started.sort((a, b) => a - b);
    for (let i = 1; i < started.length; i++) assert.ok(started[i] - started[i - 1] >= 35, `间隔过短：${started[i] - started[i - 1]}ms`);
});

test("查无此股不计入熔断，冷却结束后重新计数", async () => {
    let clock = 0;
    let emDown = false;
    const calls = [];
    const httpClient = {
        async get(url, options = {}) {
            const source = url.includes("eastmoney") ? "em" : url.includes("10jqka") ? "ths" : "tx";
            if (!url.includes("today.js")) calls.push(source);
            if (source === "em" && emDown) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
            if (source === "em") return { data: { data: null } };
            if (source === "ths") throw Object.assign(new Error("404"), { response: { status: 404 } });
            return { data: { data: {} } };
        }
    };
    const service = createMarketService({ httpClient, requestWithRetry: fn => fn(), now: () => clock });
    for (let i = 0; i < 3; i++) await assert.rejects(service.getStockProfile("999999"), /无法识别股票代码/);
    assert.equal(service.health().primaryFailures, 0);
    assert.equal(service.health().fallbackFailures, 0);
    assert.deepEqual(calls.slice(-3), ["em", "ths", "tx"], "无效代码不会让数据源进入冷却");

    emDown = true;
    await assert.rejects(service.getDailyKline("600519", 2));
    await assert.rejects(service.getDailyKline("600519", 2));
    calls.length = 0;
    await assert.rejects(service.getDailyKline("600519", 2));
    assert.ok(!calls.includes("em"), "连续失败后东方财富进入冷却");

    clock += 31 * 60 * 1000;
    calls.length = 0;
    await assert.rejects(service.getDailyKline("600519", 2));
    await assert.rejects(service.getDailyKline("600519", 2));
    assert.deepEqual(calls.filter(c => c === "em"), ["em", "em"], "冷却结束后需再次连续失败才重新暂停");
});
