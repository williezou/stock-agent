const { Pool } = require("pg");
const { buildTarget } = require("./stocks");

function createWatchlistStore({ connectionString = process.env.DATABASE_URL } = {}) {
    if (!connectionString) throw new Error("缺少DATABASE_URL");
    const pool = new Pool({ connectionString });

    async function initialize() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS watchlist (
                chat_id TEXT NOT NULL,
                symbol VARCHAR(6) NOT NULL,
                name TEXT NOT NULL,
                exchange_code VARCHAR(9) NOT NULL,
                quote_url TEXT NOT NULL,
                keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (chat_id, symbol)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bot_sessions (
                chat_id TEXT PRIMARY KEY,
                action TEXT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS watchlist_state (
                chat_id TEXT PRIMARY KEY,
                initialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
    }

    async function list(chatId) {
        const result = await pool.query(
            `SELECT symbol, name, exchange_code, quote_url, keywords
             FROM watchlist
             WHERE chat_id = $1 AND enabled = TRUE
             ORDER BY created_at, symbol`,
            [String(chatId)]
        );
        return result.rows.map(row => ({
            symbol: row.symbol,
            name: row.name,
            exchangeCode: row.exchange_code,
            quoteUrl: row.quote_url,
            keywords: Array.isArray(row.keywords) ? row.keywords : []
        }));
    }

    async function get(chatId, symbol) {
        const result = await pool.query(
            `SELECT symbol, name, exchange_code, quote_url, keywords
             FROM watchlist
             WHERE chat_id = $1 AND symbol = $2 AND enabled = TRUE`,
            [String(chatId), symbol]
        );
        if (!result.rows[0]) return null;
        const row = result.rows[0];
        return {
            symbol: row.symbol,
            name: row.name,
            exchangeCode: row.exchange_code,
            quoteUrl: row.quote_url,
            keywords: Array.isArray(row.keywords) ? row.keywords : []
        };
    }

    async function upsert(chatId, target) {
        const normalized = buildTarget(target.symbol, target.name, target.keywords);
        await pool.query(
            `INSERT INTO watchlist
                (chat_id, symbol, name, exchange_code, quote_url, keywords, enabled, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, TRUE, NOW())
             ON CONFLICT (chat_id, symbol) DO UPDATE SET
                name = EXCLUDED.name,
                exchange_code = EXCLUDED.exchange_code,
                quote_url = EXCLUDED.quote_url,
                keywords = EXCLUDED.keywords,
                enabled = TRUE,
                updated_at = NOW()`,
            [
                String(chatId),
                normalized.symbol,
                normalized.name,
                normalized.exchangeCode,
                normalized.quoteUrl,
                JSON.stringify(normalized.keywords)
            ]
        );
        return normalized;
    }

    async function remove(chatId, symbol) {
        const result = await pool.query(
            "DELETE FROM watchlist WHERE chat_id = $1 AND symbol = $2",
            [String(chatId), symbol]
        );
        return result.rowCount > 0;
    }

    async function seed(chatId, targets) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const marker = await client.query(
                `INSERT INTO watchlist_state (chat_id)
                 VALUES ($1)
                 ON CONFLICT (chat_id) DO NOTHING
                 RETURNING chat_id`,
                [String(chatId)]
            );
            if (marker.rowCount === 0) {
                await client.query("COMMIT");
                return false;
            }
            for (const target of targets) {
                const normalized = buildTarget(target.symbol, target.name, target.keywords);
                await client.query(
                    `INSERT INTO watchlist
                        (chat_id, symbol, name, exchange_code, quote_url, keywords, enabled, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6::jsonb, TRUE, NOW())
                     ON CONFLICT (chat_id, symbol) DO UPDATE SET
                        name = EXCLUDED.name,
                        exchange_code = EXCLUDED.exchange_code,
                        quote_url = EXCLUDED.quote_url,
                        keywords = EXCLUDED.keywords,
                        enabled = TRUE,
                        updated_at = NOW()`,
                    [
                        String(chatId),
                        normalized.symbol,
                        normalized.name,
                        normalized.exchangeCode,
                        normalized.quoteUrl,
                        JSON.stringify(normalized.keywords)
                    ]
                );
            }
            await client.query("COMMIT");
            return true;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async function setSession(chatId, action) {
        await pool.query(
            `INSERT INTO bot_sessions (chat_id, action, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (chat_id) DO UPDATE SET action = EXCLUDED.action, updated_at = NOW()`,
            [String(chatId), action]
        );
    }

    async function getSession(chatId) {
        const result = await pool.query(
            "SELECT action FROM bot_sessions WHERE chat_id = $1 AND updated_at > NOW() - INTERVAL '30 minutes'",
            [String(chatId)]
        );
        return result.rows[0] ? result.rows[0].action : null;
    }

    async function clearSession(chatId) {
        await pool.query("DELETE FROM bot_sessions WHERE chat_id = $1", [String(chatId)]);
    }

    async function close() {
        await pool.end();
    }

    return { clearSession, close, get, getSession, initialize, list, remove, seed, setSession, upsert };
}

module.exports = { createWatchlistStore };
