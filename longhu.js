/**
 * 龙虎榜数据服务
 * - 龙虎榜主榜：东财每日龙虎榜明细接口（data.eastmoney.com/stock/lhb.html 数据源）
 * - 连涨/连跌：从行情列表筛选涨停/跌停个股
 */

// 每日龙虎榜明细
const LONGHU_BASE_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";

// 按板块返回当日涨跌停幅度（百分比，取略低于理论值以容忍四舍五入）
function limitMovePct(symbol, name) {
    const s = String(symbol || "");
    const nm = String(name || "");
    if (nm.includes("ST")) return 4.9; // ST/*ST ±5%
    if (s.startsWith("688") || s.startsWith("689")) return 19.9; // 科创板 ±20%
    if (s.startsWith("300") || s.startsWith("301")) return 19.9; // 创业板 ±20%
    if (s.startsWith("8") || s.startsWith("4") || s.startsWith("920")) return 29.9; // 北交所 ±30%
    return 9.9; // 沪深主板 ±10%
}

function createLonghuService({ httpClient, requestWithRetry, DEBUG }) {
    /**
     * 获取真实龙虎榜（最新交易日上榜个股）
     */
    async function getLonghiBoardList() {
        try {
            const res = await requestWithRetry(() =>
                httpClient.get(LONGHU_BASE_URL, {
                    params: {
                        reportName: "RPT_DAILYBILLBOARD_DETAILS",
                        columns: "ALL",
                        pageNumber: 1,
                        pageSize: 100,
                        // 先按交易日倒序拿到最新一天，再按净买入额排序
                        sortColumns: "TRADE_DATE,BILLBOARD_NET_AMT",
                        sortTypes: "-1,-1",
                        source: "WEB",
                        client: "WEB"
                    },
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        "Referer": "https://data.eastmoney.com/"
                    }
                })
            );

            // 东财失败时仍返回 HTTP 200 但 success=false，需显式校验，否则会静默变空
            if (res.data && res.data.success === false) {
                if (DEBUG) console.log("❌ 龙虎榜接口业务失败:", res.data.message);
                return [];
            }

            if (DEBUG) {
                console.log("🧪 Longhu raw keys:",
                    res.data?.result?.data?.[0] ? Object.keys(res.data.result.data[0]) : []);
            }

            const data = (res.data?.result?.data) || [];
            // 只保留最新交易日，避免上榜数不足时混入前一交易日
            const latestDate = data.length ? (data[0].TRADE_DATE || "").toString().slice(0, 10) : "";

            // 同一只股票当日可能因多个原因多次上榜，按代码去重并合并上榜原因
            const bySymbol = new Map();
            for (const item of data) {
                if (latestDate && !(item.TRADE_DATE || "").toString().startsWith(latestDate)) continue;
                const symbol = item.SECURITY_CODE || "";
                if (!symbol) continue;
                const reason = item.EXPLANATION || item.EXPLAIN || "";
                const existing = bySymbol.get(symbol);
                if (existing) {
                    if (reason && !existing.reason.includes(reason)) {
                        existing.reason = existing.reason ? `${existing.reason}；${reason}` : reason;
                        existing.boardType = existing.reason;
                    }
                    continue;
                }
                bySymbol.set(symbol, {
                    symbol,
                    name: item.SECURITY_NAME_ABBR || "",
                    price: Number(item.CLOSE_PRICE) || 0,
                    changePct: Number(item.CHANGE_RATE) || 0,
                    turnoverRate: Number(item.TURNOVERRATE) || 0,
                    boardDate: (item.TRADE_DATE || "").toString().slice(0, 10),
                    boardType: reason,
                    reason,
                    netAmount: Number(item.BILLBOARD_NET_AMT) || 0,
                    dealAmount: Number(item.BILLBOARD_DEAL_AMT) || 0
                });
            }
            return [...bySymbol.values()].slice(0, 30);
        } catch (e) {
            if (DEBUG) {
                console.log("❌ 龙虎榜获取失败:", e.message);
            }
            return [];
        }
    }

    /**
     * 从行情数据筛选涨停个股
     */
    async function getContinuousRiseStocks(stocks = []) {
        try {
            // 按板块涨停幅度筛选（主板10%、创业/科创20%、北交30%、ST5%）
            const limitUp = stocks
                .filter(s => Number(s.changePct) >= limitMovePct(s.symbol, s.name))
                .map(s => ({
                    symbol: s.symbol,
                    name: s.name,
                    price: s.price,
                    changePct: s.changePct,
                    volume: s.volume,
                    change: s.change,
                    prevClose: s.prevClose
                }))
                .sort((a, b) => b.changePct - a.changePct)
                .slice(0, 20);

            if (DEBUG) {
                console.log(`🧪 筛选涨停: ${limitUp.length} 只`);
            }

            return limitUp;
        } catch (e) {
            if (DEBUG) {
                console.log("❌ 涨停筛选失败:", e.message);
            }
            return [];
        }
    }

    /**
     * 从行情数据筛选跌停个股
     */
    async function getContinuousDeclineStocks(stocks = []) {
        try {
            // 按板块跌停幅度筛选
            const limitDown = stocks
                .filter(s => Number(s.changePct) <= -limitMovePct(s.symbol, s.name))
                .map(s => ({
                    symbol: s.symbol,
                    name: s.name,
                    price: s.price,
                    changePct: s.changePct,
                    volume: s.volume,
                    change: s.change,
                    prevClose: s.prevClose
                }))
                .sort((a, b) => a.changePct - b.changePct)
                .slice(0, 20);

            if (DEBUG) {
                console.log(`🧪 筛选跌停: ${limitDown.length} 只`);
            }

            return limitDown;
        } catch (e) {
            if (DEBUG) {
                console.log("❌ 跌停筛选失败:", e.message);
            }
            return [];
        }
    }

    return {
        getLonghiBoardList,
        getContinuousRiseStocks,
        getContinuousDeclineStocks
    };
}

module.exports = { createLonghuService };
