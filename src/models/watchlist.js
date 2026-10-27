const { withTransaction } = require("./db");
const { buildTarget } = require("./stock");

const UPSERT_SQL = `INSERT INTO watchlist
        (chat_id, symbol, name, exchange_code, quote_url, keywords, enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, TRUE, NOW())
     ON CONFLICT (chat_id, symbol) DO UPDATE SET
        name = EXCLUDED.name,
        exchange_code = EXCLUDED.exchange_code,
        quote_url = EXCLUDED.quote_url,
        keywords = EXCLUDED.keywords,
        enabled = TRUE,
        updated_at = NOW()`;

function toTarget(row) {
    return {
        symbol: row.symbol,
        name: row.name,
        exchangeCode: row.exchange_code,
        quoteUrl: row.quote_url,
        keywords: Array.isArray(row.keywords) ? row.keywords : []
    };
}

function upsertParams(chatId, target) {
    const normalized = buildTarget(target.symbol, target.name, target.keywords);
    return [
        normalized,
        [
            String(chatId),
            normalized.symbol,
            normalized.name,
            normalized.exchangeCode,
            normalized.quoteUrl,
            JSON.stringify(normalized.keywords)
        ]
    ];
}

// 每个订阅者独立的自选股列表
function createWatchlistRepository(pool) {
    async function list(chatId) {
        const result = await pool.query(
            `SELECT symbol, name, exchange_code, quote_url, keywords
             FROM watchlist
             WHERE chat_id = $1 AND enabled = TRUE
             ORDER BY created_at, symbol`,
            [String(chatId)]
        );
        return result.rows.map(toTarget);
    }

    async function get(chatId, symbol) {
        const result = await pool.query(
            `SELECT symbol, name, exchange_code, quote_url, keywords
             FROM watchlist
             WHERE chat_id = $1 AND symbol = $2 AND enabled = TRUE`,
            [String(chatId), symbol]
        );
        return result.rows[0] ? toTarget(result.rows[0]) : null;
    }

    async function upsert(chatId, target) {
        const [normalized, params] = upsertParams(chatId, target);
        await pool.query(UPSERT_SQL, params);
        return normalized;
    }

    async function remove(chatId, symbol) {
        const result = await pool.query(
            "DELETE FROM watchlist WHERE chat_id = $1 AND symbol = $2",
            [String(chatId), symbol]
        );
        return result.rowCount > 0;
    }

    // 首次为该会话写入默认股票；watchlist_state标记保证只播种一次（用户删光后不会被重新填充）
    async function seed(chatId, targets) {
        return withTransaction(pool, async client => {
            const marker = await client.query(
                `INSERT INTO watchlist_state (chat_id)
                 VALUES ($1)
                 ON CONFLICT (chat_id) DO NOTHING
                 RETURNING chat_id`,
                [String(chatId)]
            );
            if (marker.rowCount === 0) return false;
            for (const target of targets) {
                await client.query(UPSERT_SQL, upsertParams(chatId, target)[1]);
            }
            return true;
        });
    }

    return { get, list, remove, seed, upsert };
}

module.exports = { createWatchlistRepository };
