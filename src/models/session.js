const SESSION_TTL = "30 minutes";

// 机器人多步对话状态（例如“等待输入股票代码”），超过30分钟视为过期
function createSessionRepository(pool) {
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
            `SELECT action FROM bot_sessions WHERE chat_id = $1 AND updated_at > NOW() - INTERVAL '${SESSION_TTL}'`,
            [String(chatId)]
        );
        return result.rows[0] ? result.rows[0].action : null;
    }

    async function clearSession(chatId) {
        await pool.query("DELETE FROM bot_sessions WHERE chat_id = $1", [String(chatId)]);
    }

    return { clearSession, getSession, setSession };
}

module.exports = { createSessionRepository };
