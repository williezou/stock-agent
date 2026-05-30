/**
 * 龙虎榜数据服务（改进版）
 * 使用行情数据直接筛选涨停/跌停个股
 * 因为东财官方龙虎榜 API 已不可用，改用此方案
 */

function createLonghuService({ httpClient, requestWithRetry, DEBUG }) {
    /**
     * 从行情数据筛选涨停个股
     */
    async function getContinuousRiseStocks(stocks = []) {
        try {
            // 筛选涨幅 >= 9.95% 的个股（涨停）
            const limitUp = stocks
                .filter(s => Number(s.changePct) >= 9.95)
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
                console.log(`🧪 筛选涨停: ${limitUp.length} ���`);
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
            // 筛选涨幅 <= -9.95% 的个股（跌停）
            const limitDown = stocks
                .filter(s => Number(s.changePct) <= -9.95)
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

    /**
     * 从行情数据筛选高换手个股（龙虎榜替代方案）
     * 换手率高的通常是龙虎榜关注的个股
     */
    async function getLonghiBoardList(stocks = []) {
        try {
            // 计算换手率（成交量 / 流通盘）
            // 这里用成交金额和价格作为代理指标
            const candidates = stocks
                .filter(s => {
                    // 过滤掉低价股和成交量太低的
                    const price = Number(s.price) || 0;
                    const volume = Number(s.volume) || 0;
                    return price > 2 && volume > 1000000;
                })
                .map(s => ({
                    symbol: s.symbol,
                    name: s.name,
                    price: s.price,
                    changePct: s.changePct,
                    volume: s.volume,
                    change: s.change,
                    // 活跃度评分：结合涨幅、成交量
                    activityScore: Math.abs(Number(s.changePct)) + (Number(s.volume) / 10000000)
                }))
                .sort((a, b) => b.activityScore - a.activityScore)
                .slice(0, 30);

            if (DEBUG) {
                console.log(`🧪 筛选活跃个股: ${candidates.length} 只`);
            }

            return candidates;
        } catch (e) {
            if (DEBUG) {
                console.log("❌ 活跃个股筛选失败:", e.message);
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
