/**
 * longhu.js 模块测试
 * 直接调用 createLonghuService 暴露的三个方法，验证模块行为：
 *   1. getLonghiBoardList        —— 真实龙虎榜（联网）
 *   2. getContinuousRiseStocks   —— 从行情筛选涨停（含离线 mock 用例）
 *   3. getContinuousDeclineStocks —— 从行情筛选跌停（含离线 mock 用例）
 */
require("dotenv").config();
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { createLonghuService } = require("./longhu");

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

const PROXY_URL =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;

// 与 scanner.js 保持一致的 httpClient 构造
const httpClient = (() => {
    if (!PROXY_URL) return axios.create({ timeout: 20000 });
    const agent = new HttpsProxyAgent(PROXY_URL);
    return axios.create({
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: 20000
    });
})();

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 与 scanner.js 保持一致的重试封装
async function requestWithRetry(fn, retries = 3, backoff = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (e) {
            if (i === retries - 1) throw e;
            await delay(backoff * (i + 1));
        }
    }
}

// 实例化被测模块
const longhu = createLonghuService({ httpClient, requestWithRetry, DEBUG });

// 拉取一份真实行情快照，喂给涨跌停筛选方法（仅 1 页，测试足够）
async function getMarketSnapshot() {
    const res = await requestWithRetry(() =>
        httpClient.get("https://push2.eastmoney.com/api/qt/clist/get", {
            params: {
                pn: 1,
                pz: 500,
                po: 0,
                np: 1,
                fltt: 2,
                invt: 2,
                fid: "f12",
                fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
                fields: "f12,f14,f2,f3,f4,f5,f6,f8,f18",
                _: Date.now()
            },
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://quote.eastmoney.com/"
            }
        })
    );
    const diff = res.data?.data?.diff || [];
    return diff.map(item => ({
        symbol: item.f12,
        name: item.f14,
        price: Number(item.f2) || 0,
        changePct: Number(item.f3) || 0,
        change: Number(item.f4) || 0,
        volume: Number(item.f5) || 0,
        prevClose: Number(item.f18) || 0
    }));
}

// 离线 mock 行情，覆盖各板块涨跌停边界（不依赖网络/交易时段）
const MOCK_STOCKS = [
    { symbol: "600000", name: "主板涨停", price: 11, changePct: 10.0, volume: 100, change: 1, prevClose: 10 },
    { symbol: "600001", name: "主板跌停", price: 9, changePct: -10.0, volume: 100, change: -1, prevClose: 10 },
    { symbol: "300001", name: "创业涨停", price: 12, changePct: 20.0, volume: 100, change: 2, prevClose: 10 },
    { symbol: "688001", name: "科创跌停", price: 8, changePct: -20.0, volume: 100, change: -2, prevClose: 10 },
    { symbol: "830001", name: "北交涨停", price: 13, changePct: 30.0, volume: 100, change: 3, prevClose: 10 },
    { symbol: "600002", name: "ST退市", price: 9.5, changePct: -5.0, volume: 100, change: -0.5, prevClose: 10 },
    { symbol: "600003", name: "普通上涨", price: 10.3, changePct: 3.0, volume: 100, change: 0.3, prevClose: 10 },
    { symbol: "600004", name: "普通下跌", price: 9.7, changePct: -3.0, volume: 100, change: -0.3, prevClose: 10 }
];

function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.log(`  ❌ ${msg}`);
        process.exitCode = 1;
    }
}

async function testLonghuBoard() {
    console.log("\n📍 测试 getLonghiBoardList()（联网，真实龙虎榜）");
    const list = await longhu.getLonghiBoardList();
    assert(Array.isArray(list), `返回数组（实际 ${typeof list}）`);
    console.log(`  ℹ️  上榜个股数: ${list.length}`);
    if (list.length > 0) {
        const s = list[0];
        console.log(`  📋 样本: ${s.symbol} ${s.name} 收盘=${s.price} 涨幅=${s.changePct}% 净买入=${s.netAmount}`);
        console.log(`         上榜原因: ${s.reason || "(无)"}`);
        const keys = ["symbol", "name", "price", "changePct", "boardDate", "reason", "netAmount", "dealAmount"];
        assert(keys.every(k => k in s), `字段完整: ${keys.join(", ")}`);
        assert(list.length <= 30, "结果不超过 30 条上限");
        const dates = new Set(list.map(x => x.boardDate));
        assert(dates.size <= 1, `仅含单一交易日（实际 ${[...dates].join(",")}）`);
    } else {
        console.log("  ⚠️  返回空数组（可能非交易日或接口暂不可用，非模块缺陷）");
    }
}

async function testRiseDeclineMock() {
    console.log("\n📍 测试涨/跌停筛选（离线 mock 数据）");
    const rise = await longhu.getContinuousRiseStocks(MOCK_STOCKS);
    const decline = await longhu.getContinuousDeclineStocks(MOCK_STOCKS);

    const riseSet = new Set(rise.map(s => s.symbol));
    const declineSet = new Set(decline.map(s => s.symbol));

    console.log(`  涨停命中: ${[...riseSet].join(", ") || "(无)"}`);
    console.log(`  跌停命中: ${[...declineSet].join(", ") || "(无)"}`);

    assert(riseSet.has("600000"), "主板 +10% 判为涨停");
    assert(riseSet.has("300001"), "创业板 +20% 判为涨停");
    assert(riseSet.has("830001"), "北交所 +30% 判为涨停");
    assert(!riseSet.has("600003"), "主板 +3% 不判为涨停");
    assert(!riseSet.has("300001") === false, "创业板 +20% 确实涨停");

    assert(declineSet.has("600001"), "主板 -10% 判为跌停");
    assert(declineSet.has("688001"), "科创板 -20% 判为跌停");
    assert(declineSet.has("600002"), "ST -5% 判为跌停");
    assert(!declineSet.has("600004"), "主板 -3% 不判为跌停");

    assert(rise.every(s => s.changePct > 0), "涨停列表涨幅均为正");
    assert(decline.every(s => s.changePct < 0), "跌停列表涨幅均为负");
}

async function testRiseDeclineLive() {
    console.log("\n📍 测试涨/跌停筛选（真实行情快照，前 500 只）");
    let stocks = [];
    try {
        stocks = await getMarketSnapshot();
    } catch (e) {
        console.log(`  ⚠️  行情快照获取失败，跳过联网用例: ${e.message}`);
        return;
    }
    console.log(`  ℹ️  快照股票数: ${stocks.length}`);
    const rise = await longhu.getContinuousRiseStocks(stocks);
    const decline = await longhu.getContinuousDeclineStocks(stocks);
    console.log(`  📈 涨停: ${rise.length} 只  📉 跌停: ${decline.length} 只`);
    assert(rise.length <= 20, "涨停结果不超过 20 条上限");
    assert(decline.length <= 20, "跌停结果不超过 20 条上限");
    if (rise.length > 0) {
        console.log(`  样本涨停: ${rise.slice(0, 3).map(s => `${s.symbol} ${s.name} ${s.changePct}%`).join(" | ")}`);
    }
    if (decline.length > 0) {
        console.log(`  样本跌停: ${decline.slice(0, 3).map(s => `${s.symbol} ${s.name} ${s.changePct}%`).join(" | ")}`);
    }
}

async function runTests() {
    console.log("🚀 longhu.js 模块测试");
    console.log("=".repeat(70));

    await testRiseDeclineMock();
    await testLonghuBoard();
    await testRiseDeclineLive();

    console.log("\n" + "=".repeat(70));
    console.log(process.exitCode ? "❌ 存在失败用例（见上方 ❌）" : "✅ 全部用例通过");
}

runTests().catch(e => {
    console.error("❌ 测试脚本执行失败:", e.message);
    process.exit(1);
});
