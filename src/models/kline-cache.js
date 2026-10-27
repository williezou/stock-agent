const RETENTION_DAYS = 7;

// 当日收盘后已收定的日K缓存，供调度重试复用，减少对行情接口的重复请求
function createKlineCacheRepository(pool) {
    async function getCachedKlines(symbol, tradeDate) {
        const result = await pool.query(
            "SELECT klines FROM kline_cache WHERE symbol = $1 AND trade_date = $2",
            [symbol, tradeDate]
        );
        return result.rows[0] ? result.rows[0].klines : null;
    }

    async function saveCachedKlines(symbol, tradeDate, klines) {
        await pool.query(
            `INSERT INTO kline_cache (symbol, trade_date, klines, fetched_at)
             VALUES ($1, $2, $3::jsonb, NOW())
             ON CONFLICT (symbol, trade_date) DO UPDATE SET klines = EXCLUDED.klines, fetched_at = NOW()`,
            [symbol, tradeDate, JSON.stringify(klines)]
        );
    }

    async function pruneExpired() {
        await pool.query(`DELETE FROM kline_cache WHERE trade_date < CURRENT_DATE - ${RETENTION_DAYS}`);
    }

    return { getCachedKlines, pruneExpired, saveCachedKlines };
}

module.exports = { createKlineCacheRepository };
