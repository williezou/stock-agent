// 每日投递任务状态：(任务名, 会话, 日期)唯一；失败后10分钟可重领，运行超过45分钟视为卡死可重领
const RETRY_INTERVAL = "10 minutes";
const STALE_RUNNING = "45 minutes";

function createDeliveryRunRepository(pool) {
    // 今天仍需投递的活跃订阅者：没有任务记录或任务可重领。
    // audience：watchlist=有自选股的用户（收盘报告），longhu=开启龙虎榜推送的用户，limitUp=开启涨停复盘的用户
    const AUDIENCE_FILTERS = {
        watchlist: "AND EXISTS (SELECT 1 FROM watchlist w WHERE w.chat_id = s.chat_id AND w.enabled = TRUE)",
        longhu: "AND s.longhu_enabled = TRUE",
        limitUp: "AND s.limit_up_enabled = TRUE"
    };

    async function listDueSubscribers(jobName, runDate, maxAttempts = 12, { audience = "watchlist" } = {}) {
        const audienceFilter = AUDIENCE_FILTERS[audience];
        if (!audienceFilter) throw new Error(`未知的推送对象：${audience}`);
        const result = await pool.query(
            `SELECT s.chat_id, s.telegram_user_id, s.username, s.first_name, s.timezone, s.quote_app
             FROM telegram_subscribers s
             LEFT JOIN daily_delivery_runs r
                ON r.job_name = $1 AND r.chat_id = s.chat_id AND r.run_date = $2
             WHERE s.status = 'active'
               ${audienceFilter}
               AND (
                    r.chat_id IS NULL
                    OR (r.attempts < $3 AND (
                        (r.status = 'failed' AND r.next_attempt_at <= NOW())
                        OR (r.status = 'running' AND r.started_at < NOW() - INTERVAL '${STALE_RUNNING}')
                    ))
               )
             ORDER BY s.created_at, s.chat_id`,
            [jobName, runDate, maxAttempts]
        );
        return result.rows;
    }

    // 原子领取任务，返回本次是第几次尝试；不可领取时返回null（多个调度进程并存也不会重复投递）
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
                    OR (daily_delivery_runs.status = 'running' AND daily_delivery_runs.started_at < NOW() - INTERVAL '${STALE_RUNNING}')
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
             SET status = 'failed', next_attempt_at = NOW() + INTERVAL '${RETRY_INTERVAL}', message = $4
             WHERE job_name = $1 AND chat_id = $2 AND run_date = $3`,
            [jobName, String(chatId), runDate, String(message || "").slice(0, 1000)]
        );
    }

    // 把单用户时代scheduled_runs中的记录归到管理员名下，避免升级当天重复推送
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

    // 某任务当天是否已成功投递给至少一位用户（如游资动向等龙虎榜发布完成、推送成功后再推）
    async function hasCompletedRun(jobName, runDate) {
        const result = await pool.query(
            "SELECT 1 FROM daily_delivery_runs WHERE job_name = $1 AND run_date = $2 AND status = 'done' LIMIT 1",
            [jobName, runDate]
        );
        return result.rowCount > 0;
    }

    return { claimDeliveryRun, completeDeliveryRun, failDeliveryRun, hasCompletedRun, listDueSubscribers, migrateLegacyScheduledRuns };
}

module.exports = { createDeliveryRunRepository };
