/**
 * 龙虎榜数据抓取 - 多方案测试
 * 包含详细的调试信息和多个备选数据源
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

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function testEndpoint(name, url, params, headers = {}) {
    console.log(`\n📍 ${name}`);
    console.log(`URL: ${url}`);
    console.log(`参数: ${JSON.stringify(params, null, 2)}`);
    
    try {
        const response = await axios.get(url, {
            params,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://data.eastmoney.com/",
                ...headers
            },
            timeout: 15000
        });

        console.log(`✅ HTTP ${response.status} - 成功`);
        
        // 分析响应结构
        const respData = response.data;
        console.log(`📊 响应数据结构:`);
        console.log(`   顶级键: ${Object.keys(respData).join(", ")}`);
        
        if (respData.result) {
            console.log(`   result 结构: ${Object.keys(respData.result).join(", ")}`);
            if (respData.result.data) {
                console.log(`   ✅ 获取数据行数: ${respData.result.data.length}`);
                if (respData.result.data.length > 0) {
                    console.log(`   📋 第一条数据字段: ${Object.keys(respData.result.data[0]).slice(0, 5).join(", ")}...`);
                    console.log(`   📋 样本数据:`);
                    console.log(JSON.stringify(respData.result.data[0], null, 2));
                }
            } else {
                console.log(`   ⚠️  result 中没有 data 字段`);
            }
        } else {
            console.log(`   ⚠️  响应中没有 result 字段`);
            console.log(`   完整响应 (前500字符): ${JSON.stringify(respData).slice(0, 500)}`);
        }
        
        return { success: true, data: respData };
    } catch (e) {
        if (e.response) {
            console.log(`❌ HTTP ${e.response.status} - ${e.response.statusText}`);
            console.log(`   响应: ${JSON.stringify(e.response.data).slice(0, 300)}`);
        } else {
            console.log(`❌ 请求失败: ${e.message}`);
            if (e.code) console.log(`   错误码: ${e.code}`);
        }
        return { success: false, error: e.message };
    }
}

async function runTests() {
    console.log("🚀 开始龙虎榜数据源测试\n");
    console.log("=".repeat(70));

    // 方案1: 官方龙虎榜数据
    await testEndpoint(
        "方案1: 龙虎榜上榜 (RPT_BILLBOARD_LIST)",
        "https://datacenter-web.eastmoney.com/api/data/v1/get",
        {
            reportName: "RPT_BILLBOARD_LIST",
            columns: "ALL",
            pageNumber: 1,
            pageSize: 20,
            sortColumns: "TURNOVER_RATE",
            sortTypes: -1,
            source: "WEB",
            client: "WEB"
        }
    );

    await delay(1000);

    // 方案2: 连续上涨
    await testEndpoint(
        "方案2: 连续上涨 (RPT_DYNABOARD_RISE_LIST)",
        "https://datacenter-web.eastmoney.com/api/data/v1/get",
        {
            reportName: "RPT_DYNABOARD_RISE_LIST",
            columns: "ALL",
            pageNumber: 1,
            pageSize: 20,
            sortColumns: "RISE_DAY_COUNT",
            sortTypes: -1,
            source: "WEB",
            client: "WEB"
        }
    );

    await delay(1000);

    // 方案3: 连续下跌
    await testEndpoint(
        "方案3: 连续下跌 (RPT_DYNABOARD_DECLINE_LIST)",
        "https://datacenter-web.eastmoney.com/api/data/v1/get",
        {
            reportName: "RPT_DYNABOARD_DECLINE_LIST",
            columns: "ALL",
            pageNumber: 1,
            pageSize: 20,
            sortColumns: "DECLINE_DAY_COUNT",
            sortTypes: -1,
            source: "WEB",
            client: "WEB"
        }
    );

    await delay(1000);

    // 方案4: 从行情数据筛选涨跌停
    console.log(`\n📍 方案4: 从行情数据筛选涨跌停`);
    try {
        const response = await axios.get("https://push2.eastmoney.com/api/qt/clist/get", {
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
            timeout: 15000
        });

        console.log(`✅ HTTP ${response.status} - 成功`);
        const allStocks = response.data?.data?.diff || [];
        const limitUp = allStocks.filter(s => Number(s.f3) >= 9.95);
        const limitDown = allStocks.filter(s => Number(s.f3) <= -9.95);
        
        console.log(`📊 总股票数: ${allStocks.length}`);
        console.log(`📈 涨停数: ${limitUp.length}`);
        console.log(`📉 跌停数: ${limitDown.length}`);
        
        if (limitUp.length > 0) {
            console.log(`\n涨停板样本 (前3只):`);
            limitUp.slice(0, 3).forEach((s, i) => {
                console.log(`  ${i + 1}. ${s.f12} ${s.f14} 涨幅: ${s.f3}% 成交量: ${s.f5}`);
            });
        }
    } catch (e) {
        console.log(`❌ 请求失败: ${e.message}`);
    }

    console.log("\n" + "=".repeat(70));
    console.log("\n📋 测试总结:");
    console.log(`
    如果方案1-3返回数据，则龙虎榜API可用，使用现有 longhu.js 模块
    如果方案1-3都失败，则使用方案4的替代方案
    
    下一步:
    1. 根据以上结果调整 longhu.js 中的 API 参数
    2. 如果都无法获取，改用方案4（从行情数据筛选）
    3. 运行 node scanner.js 进行完整测试
    `);
}

runTests().catch(e => {
    console.error("❌ 测试脚本执行失败:", e.message);
    process.exit(1);
});
