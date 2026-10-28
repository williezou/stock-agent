/**
 * 龙虎榜数据服务
 * - 龙虎榜：同花顺日报页面为主源，东方财富明细接口为备用（减少对东方财富的请求，降低本机IP被封禁的风险）；
 *   同花顺没有IPv6，纯IPv6网络下只用东方财富
 * - 连涨/连跌：从行情列表筛选涨停/跌停个股
 */

const { config } = require("../../config");
const { formatError } = require("../../lib/http");
const { createEastmoneyLonghuSource } = require("./sources/eastmoney-longhu");
const { createTonghuashunLonghuSource } = require("./sources/tonghuashun-longhu");

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

function sortByNetAmount(board) {
    return [...board].sort((x, y) => y.netAmount - x.netAmount);
}

function createLonghuService({ httpClient, requestWithRetry, boardSources }) {
    const [primary, fallback] = boardSources || (config.ipv6Only
        ? [createEastmoneyLonghuSource({ httpClient, requestWithRetry })]
        : [
            createTonghuashunLonghuSource({ httpClient, requestWithRetry }),
            createEastmoneyLonghuSource({ httpClient, requestWithRetry })
        ]);

    /**
     * 指定交易日的龙虎榜（沪深北交易所当日公开信息，通常在收盘后16:00-20:00陆续发布），按净买入额从高到低排序。
     * 主源失败时改用备用源；主源返回空列表时也向备用源确认一次，避免主源页面改版解析不出数据却被当作“未发布”。
     * 两个源都失败时抛错（调用方需区分“未发布”与“取数失败”）
     */
    async function getBoardByDate(dateStr) {
        let board;
        try {
            board = await primary.getBoardByDate(dateStr);
        } catch (error) {
            if (!fallback) throw error;
            console.log(`⚠️ ${primary.name}龙虎榜获取失败（${formatError(error)}），改用${fallback.name}`);
            return sortByNetAmount(await fallback.getBoardByDate(dateStr));
        }
        if (!board.length && fallback) {
            board = await fallback.getBoardByDate(dateStr).catch(error => {
                console.log(`⚠️ ${fallback.name}龙虎榜确认失败（${formatError(error)}），按未发布处理`);
                return [];
            });
        }
        return sortByNetAmount(board);
    }

    // 某只股票当日的买卖席位明细（按用户点击查询），主源失败时改用备用源；未上榜或未发布时返回null
    async function getSeatDetails(dateStr, symbol) {
        const seatSources = [primary, fallback].filter(source => source && typeof source.getSeatDetails === "function");
        if (!seatSources.length) throw new Error(`${primary.name}不支持查询龙虎榜席位`);
        for (const [index, source] of seatSources.entries()) {
            try {
                return await source.getSeatDetails(dateStr, symbol);
            } catch (error) {
                const next = seatSources[index + 1];
                if (!next) throw error;
                console.log(`⚠️ ${source.name}龙虎榜席位获取失败（${formatError(error)}），改用${next.name}`);
            }
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
        getSeatDetails,
        getContinuousRiseStocks,
        getContinuousDeclineStocks
    };
}

module.exports = { createLonghuService };
