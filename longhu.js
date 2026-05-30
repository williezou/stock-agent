/**
 * 龙虎榜数据服务
 * 从东财获取A股龙虎榜信息
 * - 沪深京龙虎榜
 * - 涨幅排行榜（连续上涨）
 * - 跌幅排行榜（连续下跌）
 */

const LONGHU_BASE_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";

function createLonghuService({ httpClient, requestWithRetry, DEBUG }) {
    /**
     * 获取沪深京龙虎榜
     * 返回当日上榜个股信息
     */
    async function getLonghiBoardList() {
        try {
            const res = await requestWithRetry(() =>
                httpClient.get(LONGHU_BASE_URL, {
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
                    }
                })
            );

            if (DEBUG) {
                console.log("🧪 Longhu raw keys:", 
                    res.data?.result?.data?.[0] ? Object.keys(res.data.result.data[0]) : []);
            }

            const data = (res.data?.result?.data) || [];
            return data.map(item => ({
                symbol: item.SECURITY_CODE || "",
                name: item.SECURITY_NAME_ABBR || "",
                price: Number(item.CLOSE_PRICE) || 0,
                changePct: Number(item.CHANGE_RATE) || 0,
                turnoverRate: Number(item.TURNOVER_RATE) || 0,
                listDate: (item.LIST_DATE || "").toString().slice(0, 10),
                boardDate: (item.BILLBOARD_DATE || "").toString().slice(0, 10),
                // 龙虎榜上榜类型
                boardType: item.BILLBOARD_TYPE_NAME || "",
                // 上榜原因
                reason: item.REASON || "",
                // 成交金额
                dealAmount: Number(item.DEAL_AMOUNT) || 0
            })).slice(0, 30);
        } catch (e) {
            if (DEBUG) {
                console.log("❌ 龙虎榜获取失败:", e.message);
            }
            return [];
        }
    }

    /**
     * 获取连续上涨个股（涨停板列表）
     */
    async function getContinuousRiseStocks() {
        try {
            const res = await requestWithRetry(() =>
                httpClient.get(LONGHU_BASE_URL, {
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
                    }
                })
            );

            if (DEBUG) {
                console.log("🧪 Continuous Rise raw keys:",
                    res.data?.result?.data?.[0] ? Object.keys(res.data.result.data[0]) : []);
            }

            const data = (res.data?.result?.data) || [];
            return data.map(item => ({
                symbol: item.SECURITY_CODE || "",
                name: item.SECURITY_NAME_ABBR || "",
                price: Number(item.PRICE) || 0,
                changePct: Number(item.CHANGE_RATE) || 0,
                consecutiveDays: Number(item.RISE_DAY_COUNT) || 0,
                highestPrice: Number(item.HIGHEST_PRICE) || 0,
                lowestPrice: Number(item.LOWEST_PRICE) || 0
            })).slice(0, 20);
        } catch (e) {
            if (DEBUG) {
                console.log("❌ 连续上涨获取失败:", e.message);
            }
            return [];
        }
    }

    /**
     * 获取连续下跌个股（跌停板列表）
     */
    async function getContinuousDeclineStocks() {
        try {
            const res = await requestWithRetry(() =>
                httpClient.get(LONGHU_BASE_URL, {
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
                    }
                })
            );

            if (DEBUG) {
                console.log("🧪 Continuous Decline raw keys:",
                    res.data?.result?.data?.[0] ? Object.keys(res.data.result.data[0]) : []);
            }

            const data = (res.data?.result?.data) || [];
            return data.map(item => ({
                symbol: item.SECURITY_CODE || "",
                name: item.SECURITY_NAME_ABBR || "",
                price: Number(item.PRICE) || 0,
                changePct: Number(item.CHANGE_RATE) || 0,
                consecutiveDays: Number(item.DECLINE_DAY_COUNT) || 0,
                highestPrice: Number(item.HIGHEST_PRICE) || 0,
                lowestPrice: Number(item.LOWEST_PRICE) || 0
            })).slice(0, 20);
        } catch (e) {
            if (DEBUG) {
                console.log("❌ 连续下跌获取失败:", e.message);
            }
            return [];
        }
    }

    /**
     * 获取特定股票的龙虎榜详情（哪些机构参与）
     */
    async function getLonghuDetail(symbol) {
        try {
            const res = await requestWithRetry(() =>
                httpClient.get(LONGHU_BASE_URL, {
                    params: {
                        reportName: "RPT_BILLBOARD_DETAIL",
                        columns: "ALL",
                        filter: `(SECURITY_CODE="${symbol}")`,
                        pageNumber: 1,
                        pageSize: 20,
                        sortColumns: "DEAL_AMOUNT",
                        sortTypes: -1,
                        source: "WEB",
                        client: "WEB"
                    },
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        "Referer": "https://data.eastmoney.com/"
                    }
                })
            );

            const data = (res.data?.result?.data) || [];
            return data.map(item => ({
                operator: item.OPERATOR_NAME || "",
                buyAmount: Number(item.BUY_AMOUNT) || 0,
                sellAmount: Number(item.SELL_AMOUNT) || 0,
                netAmount: Number(item.NET_AMOUNT) || 0,
                ratio: Number(item.RATIO) || 0,
                type: item.OPERATOR_TYPE || "其他"
            })).slice(0, 5);
        } catch (e) {
            if (DEBUG) {
                console.log("❌ 龙虎榜详情获取失败:", e.message);
            }
            return [];
        }
    }

    return {
        getLonghiBoardList,
        getContinuousRiseStocks,
        getContinuousDeclineStocks,
        getLonghuDetail
    };
}

module.exports = { createLonghuService };
