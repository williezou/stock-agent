const { rollback, withTransaction } = require("./db");

// 订阅者：每个Telegram私聊会话一条记录，status为active/inactive/banned（管理员拉黑）
function createSubscriberRepository(pool) {
    function upsertActive(db, { chatId, userId, username, firstName }) {
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
             RETURNING chat_id, telegram_user_id, username, first_name, status, timezone, longhu_enabled, fund_flow_enabled`,
            [
                String(chatId),
                userId === undefined || userId === null ? null : String(userId),
                username || null,
                firstName || null
            ]
        ).then(result => result.rows[0]);
    }

    async function getSubscriber(chatId) {
        const result = await pool.query(
            `SELECT chat_id, telegram_user_id, username, first_name, status, timezone, longhu_enabled, fund_flow_enabled
             FROM telegram_subscribers WHERE chat_id = $1`,
            [String(chatId)]
        );
        return result.rows[0] || null;
    }

    // 启用订阅；maxActive>0时受活跃名额限制，名额已满返回null
    async function registerSubscriber({ maxActive = 0, ...subscriber }) {
        // 已是活跃用户不会改变活跃人数，只有激活操作才需要加锁计数
        if (maxActive <= 0 || (await getSubscriber(subscriber.chatId))?.status === "active") {
            return upsertActive(pool, subscriber);
        }
        return withTransaction(pool, async client => {
            // 串行化激活操作，避免并发/start突破名额上限
            await client.query("SELECT pg_advisory_xact_lock(hashtext('telegram_subscribers'))");
            const count = await client.query(
                "SELECT COUNT(*)::int AS total FROM telegram_subscribers WHERE status = 'active' AND chat_id <> $1",
                [String(subscriber.chatId)]
            );
            if (count.rows[0].total >= maxActive) return rollback(null);
            return upsertActive(client, subscriber);
        });
    }

    async function deactivateSubscriber(chatId) {
        const result = await pool.query(
            `UPDATE telegram_subscribers SET status = 'inactive', updated_at = NOW()
             WHERE chat_id = $1 AND status <> 'banned'`,
            [String(chatId)]
        );
        return result.rowCount > 0;
    }

    async function setLonghuEnabled(chatId, enabled) {
        const result = await pool.query(
            "UPDATE telegram_subscribers SET longhu_enabled = $2, updated_at = NOW() WHERE chat_id = $1",
            [String(chatId), Boolean(enabled)]
        );
        return result.rowCount > 0;
    }

    async function setFundFlowEnabled(chatId, enabled) {
        const result = await pool.query(
            "UPDATE telegram_subscribers SET fund_flow_enabled = $2, updated_at = NOW() WHERE chat_id = $1",
            [String(chatId), Boolean(enabled)]
        );
        return result.rowCount > 0;
    }

    // 资金异动提醒的接收者：开启该提醒的活跃订阅者（盘中多次推送，不经过每日投递任务表）
    async function listFundFlowSubscribers() {
        const result = await pool.query(
            `SELECT chat_id FROM telegram_subscribers
             WHERE status = 'active' AND fund_flow_enabled = TRUE
             ORDER BY created_at, chat_id`
        );
        return result.rows;
    }

    // 用户在Telegram里改了用户名或名字时同步（用户名可被删除，置为空；名字缺失时保留原值）
    async function updateSubscriberProfile(chatId, { username, firstName }) {
        await pool.query(
            `UPDATE telegram_subscribers SET username = $2, first_name = COALESCE($3, first_name), updated_at = NOW()
             WHERE chat_id = $1`,
            [String(chatId), username || null, firstName || null]
        );
    }

    // 管理员拉黑/解除：拉黑后不再推送、消息不回复；解除只对已拉黑的用户生效（不会把自己 /stop 的用户重新启用），
    // 恢复为启用。返回更新后的记录，没有符合条件的记录时为null
    async function setSubscriberBanned(chatId, banned) {
        const result = await pool.query(
            `UPDATE telegram_subscribers SET status = $2, updated_at = NOW()
             WHERE chat_id = $1 AND ($2 = 'banned' OR status = 'banned')
             RETURNING chat_id, username, first_name, status`,
            [String(chatId), banned ? "banned" : "active"]
        );
        return result.rows[0] || null;
    }

    // 管理员按用户名查找（不区分大小写，可带@）。用户名可以更换，可能有多条记录用过同一个，最多返回2条供调用方判断
    async function findSubscribersByUsername(username) {
        const result = await pool.query(
            `SELECT chat_id, username, first_name, status FROM telegram_subscribers
             WHERE LOWER(username) = LOWER($1)
             ORDER BY updated_at DESC
             LIMIT 2`,
            [String(username).replace(/^@/, "")]
        );
        return result.rows;
    }

    // 管理员 /users：全部订阅者及其推送开关、启用中的自选股（按添加顺序），按注册时间排序
    async function listSubscriberSummaries() {
        const result = await pool.query(
            `SELECT s.chat_id, s.username, s.first_name, s.status, s.longhu_enabled, s.fund_flow_enabled,
                    to_char(s.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS created_date,
                    COALESCE((SELECT json_agg(json_build_object('symbol', w.symbol, 'name', w.name) ORDER BY w.created_at, w.symbol)
                              FROM watchlist w WHERE w.chat_id = s.chat_id AND w.enabled = TRUE), '[]'::json) AS watchlist
             FROM telegram_subscribers s
             ORDER BY s.created_at, s.chat_id`
        );
        return result.rows;
    }

    // 确保记录存在但不改变已有状态（不覆盖用户的/stop或被屏蔽后的停用）
    async function ensureSubscriber(chatId) {
        await pool.query(
            `INSERT INTO telegram_subscribers (chat_id, status)
             VALUES ($1, 'active')
             ON CONFLICT (chat_id) DO NOTHING`,
            [String(chatId)]
        );
    }

    return {
        deactivateSubscriber,
        ensureSubscriber,
        findSubscribersByUsername,
        getSubscriber,
        listFundFlowSubscribers,
        listSubscriberSummaries,
        registerSubscriber,
        setFundFlowEnabled,
        setSubscriberBanned,
        setLonghuEnabled,
        updateSubscriberProfile
    };
}

module.exports = { createSubscriberRepository };
