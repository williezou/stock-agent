/**
 * 龙虎榜数据服务
 * - 龙虎榜：东财每日龙虎榜明细接口（data.eastmoney.com/stock/lhb.html 数据源）
 * - 连涨/连跌：从行情列表筛选涨停/跌停个股
 */

const { config } = require("../../config");
const { BROWSER_USER_AGENT } = require("../../lib/http");

// 每日龙虎榜明细
const LONGHU_BASE_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const BOARD_PAGE_SIZE = 500; // 单日上榜明细通常不足200条，极端行情可能更多
const BOARD_MAX_PAGES = 5;

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

function createLonghuService({ httpClient, requestWithRetry }) {
    /**
     * 指定交易日的龙虎榜（沪深北交易所当日公开信息，通常在收盘后16:00-20:00陆续发布）。
     * 同一股票可能因多个原因多次上榜，按代码合并上榜原因；按净买入额从高到低排序。
     * 接口失败时抛错（调用方需区分“未发布”与“取数失败”）
     */
    async function fetchBoardPage(dateStr, pageNumber) {
        const res = await requestWithRetry(() =>
            httpClient.get(LONGHU_BASE_URL, {
                params: {
                    reportName: "RPT_DAILYBILLBOARD_DETAILS",
                    columns: "ALL",
                    pageNumber,
                    pageSize: BOARD_PAGE_SIZE,
                    sortColumns: "BILLBOARD_NET_AMT",
                    sortTypes: "-1",
                    filter: `(TRADE_DATE<='${dateStr}')(TRADE_DATE>='${dateStr}')`,
                    source: "WEB",
                    client: "WEB"
                },
                headers: {
                    "User-Agent": BROWSER_USER_AGENT,
                    "Referer": "https://data.eastmoney.com/"
                }
            })
        );
        // 东财失败时仍返回 HTTP 200 但 success=false，需显式校验，否则会静默变空
        if (res.data && res.data.success === false && res.data.code !== 9201) {
            throw new Error(`龙虎榜接口业务失败: ${res.data.message || "未知原因"}`);
        }
        return { rows: res.data?.result?.data || [], pages: Number(res.data?.result?.pages) || 1 };
    }

    async function getBoardByDate(dateStr) {
        // 明细按“股票×上榜原因”逐条返回，逐页拉全，避免极端行情下净卖出靠后的股票被截断
        const first = await fetchBoardPage(dateStr, 1);
        const data = [...first.rows];
        for (let page = 2; page <= Math.min(first.pages, BOARD_MAX_PAGES); page++) {
            data.push(...(await fetchBoardPage(dateStr, page)).rows);
        }
        if (first.pages > BOARD_MAX_PAGES) {
            console.log(`⚠️ ${dateStr}龙虎榜明细超过${BOARD_MAX_PAGES}页，仅统计前${BOARD_MAX_PAGES * BOARD_PAGE_SIZE}条`);
        }
        if (config.debug && data[0]) console.log("🧪 Longhu raw keys:", Object.keys(data[0]));

        const bySymbol = new Map();
        for (const item of data) {
            const symbol = item.SECURITY_CODE || "";
            if (!symbol) continue;
            const reason = item.EXPLANATION || item.EXPLAIN || "";
            const existing = bySymbol.get(symbol);
            if (existing) {
                if (reason && !existing.reason.includes(reason)) {
                    existing.reason = existing.reason ? `${existing.reason}；${reason}` : reason;
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
                reason,
                netAmount: Number(item.BILLBOARD_NET_AMT) || 0,
                dealAmount: Number(item.BILLBOARD_DEAL_AMT) || 0
            });
        }
        return [...bySymbol.values()].sort((x, y) => y.netAmount - x.netAmount);
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
                .sort((a, b) => b.changePct - a.changePct);

            if (config.debug) {
                console.log(`🧪 筛选涨停: ${limitUp.length} 只`);
            }

            return limitUp;
        } catch (e) {
            if (config.debug) {
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
                .sort((a, b) => a.changePct - b.changePct);

            if (config.debug) {
                console.log(`🧪 筛选跌停: ${limitDown.length} 只`);
            }

            return limitDown;
        } catch (e) {
            if (config.debug) {
                console.log("❌ 跌停筛选失败:", e.message);
            }
            return [];
        }
    }

    return {
        getBoardByDate,
        getContinuousRiseStocks,
        getContinuousDeclineStocks
    };
}

module.exports = { createLonghuService };
