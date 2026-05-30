/**
 * 龙虎榜数据抓取测试脚本
 */
require("dotenv").config();
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

const PROXY_URL =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;

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

async function testLonghuAPIs() {
    console.log("🧪 开始测试龙虎榜数据抓取...\n");

    // 测试 1: 龙虎榜上榜个股
    console.log("📍 测试1: 龙虎榜上榜个股");
    console.log("请求 URL: https://datacenter-web.eastmoney.com/api/data/v1/get");
    console.log("参数: RPT_BILLBOARD_LIST");
    try {
        const res1 = await axios.get("https://datacenter-web.eastmoney.com/api/data/v1/get", {
            params: {
                reportName: "RPT_BILLBOARD_LIST",
                columns: "ALL",
                pageNumber: 1,
                pageSize: 100,
                sortColumns: "TURNOVER_RATE",
                sortTypes: -1,
                source: "WEB",
                client: "WEB"
            },
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://data.eastmoney.com/"
            },
            timeout: 20000
        });

        if (res1.data?.result?.data) {
            const data = res1.data.result.data;
            console.log(`✅ 成功获取 ${data.length} 条龙虎榜数据`);
            if (data.length > 0) {
                console.log("样本数据 (前2条):");
                console.log(JSON.stringify(data.slice(0, 2), null, 2));
            }
        } else {
            console.log("❌ 返回数据格式异常");
            console.log("响应结构:", Object.keys(res1.data || {}));
        }
    } catch (e) {
        console.log("❌ 请求失败:", e.message);
    }

    console.log("\n" + "=".repeat(60) + "\n");

    // 测试 2: 连续上涨个股
    console.log("📍 测试2: 连续上涨个股");
    console.log("参数: RPT_DYNABOARD_RISE_LIST");
    try {
        const res2 = await axios.get("https://datacenter-web.eastmoney.com/api/data/v1/get", {
            params: {
                reportName: "RPT_DYNABOARD_RISE_LIST",
                columns: "ALL",
                pageNumber: 1,
                pageSize: 50,
                sortColumns: "RISE_DAY_COUNT",
                sortTypes: -1,
                source: "WEB",
                client: "WEB"
            },
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://data.eastmoney.com/"
            },
            timeout: 20000
        });

        if (res2.data?.result?.data) {
            const data = res2.data.result.data;
            console.log(`✅ 成功获取 ${data.length} 条连续上涨数据`);
            if (data.length > 0) {
                console.log("样本数据 (前2条):");
                console.log(JSON.stringify(data.slice(0, 2), null, 2));
            }
        } else {
            console.log("❌ 返回数据格式异常");
            console.log("响应结构:", Object.keys(res2.data || {}));
        }
    } catch (e) {
        console.log("❌ 请求失败:", e.message);
    }

    console.log("\n" + "=".repeat(60) + "\n");

    // 测试 3: 连续下跌个股
    console.log("📍 测试3: 连续下跌个股");
    console.log("参数: RPT_DYNABOARD_DECLINE_LIST");
    try {
        const res3 = await axios.get("https://datacenter-web.eastmoney.com/api/data/v1/get", {
            params: {
                reportName: "RPT_DYNABOARD_DECLINE_LIST",
                columns: "ALL",
                pageNumber: 1,
                pageSize: 50,
                sortColumns: "DECLINE_DAY_COUNT",
                sortTypes: -1,
                source: "WEB",
                client: "WEB"
            },
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://data.eastmoney.com/"
            },
            timeout: 20000
        });

        if (res3.data?.result?.data) {
            const data = res3.data.result.data;
            console.log(`✅ 成功获取 ${data.length} 条连续下跌数据`);
            if (data.length > 0) {
                console.log("样本数据 (前2条):");
                console.log(JSON.stringify(data.slice(0, 2), null, 2));
            }
        } else {
            console.log("❌ 返回数据格式异常");
            console.log("响应结构:", Object.keys(res3.data || {}));
        }
    } catch (e) {
        console.log("❌ 请求失败:", e.message);
    }

    console.log("\n" + "=".repeat(60) + "\n");

    // 测试 4: 替代方案 - 尝试直接从行情数据获取涨停/跌停
    console.log("📍 测试4: 替代方案 - 从行情数据抓取涨跌停");
    console.log("参数: 查询涨跌幅 >= 9.9% 的个股");
    try {
        const res4 = await axios.get("https://push2.eastmoney.com/api/qt/clist/get", {
            params: {
                pn: 1,
                pz: 500,
                po: 1,
                np: 1,
                fltt: 2,
                invt: 2,
                fid: "f3",
                fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
                fields: "f12,f14,f2,f3,f4,f5,f18,f26",
                _: Date.now()
            },
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://quote.eastmoney.com/"
            },
            timeout: 20000
        });

        if (res4.data?.data?.diff) {
            const allStocks = res4.data.data.diff;
            const limit_up = allStocks.filter(s => Number(s.f3) >= 9.95);
            const limit_down = allStocks.filter(s => Number(s.f3) <= -9.95);
            console.log(`✅ 获取股票池 ${allStocks.length} 只`);
            console.log(`   涨停: ${limit_up.length} 只`);
            console.log(`   跌停: ${limit_down.length} 只`);
            if (limit_up.length > 0) {
                console.log("\n涨停板样本 (前3只):");
                limit_up.slice(0, 3).forEach((s, i) => {
                    console.log(`  ${i + 1}. 代码:${s.f12} 名称:${s.f14} 涨幅:${s.f3}%`);
                });
            }
        } else {
            console.log("❌ 返回数据格式异常");
        }
    } catch (e) {
        console.log("❌ 请求失败:", e.message);
    }

    console.log("\n" + "=".repeat(60));
    console.log("✅ 测试完成");
}

testLonghuAPIs().catch(console.error);
