const { Pool } = require("pg");
const { buildTarget } = require("./stocks");

function createWatchlistStore({ connectionString = process.env.DATABASE_URL } = {}) {
    if (!connectionString) throw new Error("缺少DATABASE_URL");
    const pool = new Pool({ connectionString });

    async function initialize() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS telegram_subscribers (
                chat_id TEXT PRIMARY KEY,
                telegram_user_id TEXT,
                username TEXT,
                first_name TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
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
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scheduled_runs (
                job_name TEXT NOT NULL,
                run_date DATE NOT NULL,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                started_at TIMESTAMPTZ,
                finished_at TIMESTAMPTZ,
                message TEXT,
                PRIMARY KEY (job_name, run_date)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS daily_delivery_runs (
                job_name TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                run_date DATE NOT NULL,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                started_at TIMESTAMPTZ,
                finished_at TIMESTAMPTZ,
                message TEXT,
                PRIMARY KEY (job_name, chat_id, run_date)
            )
        `);
    }

    function upsertSubscriber(db, { chatId, userId, username, firstName }) {
        return db.query(
            `INSERT INTO telegram_subscribers
                (chat_id, telegram_user_id, username, first_name, status, updated_at)
             VALUES ($1, $2, $3, $4, 'active', NOW())
             ON CONFLICT (chat_id) DO UPDATE SET
                telegram_user_id = COALESCE(EXCLUDED.telegram_user_id, telegram_subscribers.telegram_user_id),
                username = COALESCE(EXCLUDED.username, telegram_subscribers.username),
                first_name = COALESCE(EXCLUDED.first_name, telegram_subscribers.first_name),
                status = 'active',
                updated_at = NOW()
             RETURNING chat_id, telegram_user_id, username, first_name, status, timezone`,
            [
                String(chatId),
                userId === undefined || userId === null ? null : String(userId),
                username || null,
                firstName || null
            ]
        ).then(result => result.rows[0]);
    }

    async function registerSubscriber({ maxActive = 0, ...subscriber }) {
        // Already-active users cannot change the active count, so only activations take the cap lock.
        if (maxActive <= 0 || (await getSubscriber(subscriber.chatId))?.status === "active") {
            return upsertSubscriber(pool, subscriber);
        }
        const client = await pool.connect();
        let failure;
        try {
            await client.query("BEGIN");
            // Serialize activations so concurrent /start cannot overshoot the active-subscriber cap.
            await client.query("SELECT pg_advisory_xact_lock(hashtext('telegram_subscribers'))");
            const count = await client.query(
                "SELECT COUNT(*)::int AS total FROM telegram_subscribers WHERE status = 'active' AND chat_id <> $1",
                [String(subscriber.chatId)]
            );
            if (count.rows[0].total >= maxActive) {
                await client.query("ROLLBACK");
                return null;
            }
            const row = await upsertSubscriber(client, subscriber);
            await client.query("COMMIT");
            return row;
        } catch (error) {
            failure = error;
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            // Passing the error discards a possibly broken connection instead of returning it to the pool.
            client.release(failure);
        }
    }

    async function getSubscriber(chatId) {
        const result = await pool.query(
            `SELECT chat_id, telegram_user_id, username, first_name, status, timezone
             FROM telegram_subscribers WHERE chat_id = $1`,
            [String(chatId)]
        );
        return result.rows[0] || null;
    }

    async function listDueSubscribers(jobName, runDate, maxAttempts = 12) {
        const result = await pool.query(
            `SELECT s.chat_id, s.telegram_user_id, s.username, s.first_name, s.timezone
             FROM telegram_subscribers s
             LEFT JOIN daily_delivery_runs r
                ON r.job_name = $1 AND r.chat_id = s.chat_id AND r.run_date = $2
             WHERE s.status = 'active'
               AND EXISTS (SELECT 1 FROM watchlist w WHERE w.chat_id = s.chat_id AND w.enabled = TRUE)
               AND (
                    r.chat_id IS NULL
                    OR (r.attempts < $3 AND (
                        (r.status = 'failed' AND r.next_attempt_at <= NOW())
                        OR (r.status = 'running' AND r.started_at < NOW() - INTERVAL '45 minutes')
                    ))
               )
             ORDER BY s.created_at, s.chat_id`,
            [jobName, runDate, maxAttempts]
        );
        return result.rows;
    }

    async function deactivateSubscriber(chatId) {
        const result = await pool.query(
            `UPDATE telegram_subscribers SET status = 'inactive', updated_at = NOW()
             WHERE chat_id = $1`,
            [String(chatId)]
        );
        await clearSession(chatId);
        return result.rowCount > 0;
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

    async function migrateLegacyScheduledRuns(chatId) {
        await pool.query(
            `INSERT INTO daily_delivery_runs
                (job_name, chat_id, run_date, status, attempts, next_attempt_at, started_at, finished_at, message)
             SELECT job_name, $1, run_date, status, attempts, next_attempt_at, started_at, finished_at, message
             FROM scheduled_runs
             WHERE job_name = 'daily-close'
             ON CONFLICT (job_name, chat_id, run_date) DO NOTHING`,
            [String(chatId)]
        );
    }

    // Ensures the admin exists without overriding a /stop or a blocked-bot deactivation.
    async function bootstrapAdmin(chatId, defaultTargets) {
        await pool.query(
            `INSERT INTO telegram_subscribers (chat_id, status)
             VALUES ($1, 'active')
             ON CONFLICT (chat_id) DO NOTHING`,
            [String(chatId)]
        );
        await seed(chatId, defaultTargets);
        await migrateLegacyScheduledRuns(chatId);
    }

    async function claimDeliveryRun(jobName, chatId, runDate, maxAttempts = 12) {
        const result = await pool.query(
            `INSERT INTO daily_delivery_runs
                (job_name, chat_id, run_date, status, attempts, next_attempt_at, started_at, message)
             VALUES ($1, $2, $3, 'running', 1, NOW(), NOW(), NULL)
             ON CONFLICT (job_name, chat_id, run_date) DO UPDATE SET
                status = 'running',
                attempts = daily_delivery_runs.attempts + 1,
                started_at = NOW(),
                message = NULL
             WHERE daily_delivery_runs.attempts < $4
               AND (
                    (daily_delivery_runs.status = 'failed' AND daily_delivery_runs.next_attempt_at <= NOW())
                    OR (daily_delivery_runs.status = 'running' AND daily_delivery_runs.started_at < NOW() - INTERVAL '45 minutes')
               )
             RETURNING attempts`,
            [jobName, String(chatId), runDate, maxAttempts]
        );
        return result.rows[0] ? Number(result.rows[0].attempts) : null;
    }

    async function completeDeliveryRun(jobName, chatId, runDate, status, message = "") {
        await pool.query(
            `UPDATE daily_delivery_runs
             SET status = $4, finished_at = NOW(), message = $5
             WHERE job_name = $1 AND chat_id = $2 AND run_date = $3`,
            [jobName, String(chatId), runDate, status, String(message || "").slice(0, 1000)]
        );
    }

    async function failDeliveryRun(jobName, chatId, runDate, message = "") {
        await pool.query(
            `UPDATE daily_delivery_runs
             SET status = 'failed', next_attempt_at = NOW() + INTERVAL '10 minutes', message = $4
             WHERE job_name = $1 AND chat_id = $2 AND run_date = $3`,
            [jobName, String(chatId), runDate, String(message || "").slice(0, 1000)]
        );
    }

    async function close() {
        await pool.end();
    }

    return {
        bootstrapAdmin,
        claimDeliveryRun,
        clearSession,
        close,
        completeDeliveryRun,
        deactivateSubscriber,
        failDeliveryRun,
        get,
        getSubscriber,
        getSession,
        initialize,
        list,
        listDueSubscribers,
        registerSubscriber,
        remove,
        seed,
        setSession,
        upsert
    };
}

module.exports = { createWatchlistStore };
