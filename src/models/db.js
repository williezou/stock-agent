const { Pool } = require("pg");

// 表结构定义；启动时幂等执行（CREATE TABLE IF NOT EXISTS）
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS telegram_subscribers (
        chat_id TEXT PRIMARY KEY,
        telegram_user_id TEXT,
        username TEXT,
        first_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // 订阅者可单独关闭龙虎榜推送（默认开启）
    "ALTER TABLE telegram_subscribers ADD COLUMN IF NOT EXISTS longhu_enabled BOOLEAN NOT NULL DEFAULT TRUE",
    // 盘中资金异动提醒（默认开启）
    "ALTER TABLE telegram_subscribers ADD COLUMN IF NOT EXISTS fund_flow_enabled BOOLEAN NOT NULL DEFAULT TRUE",
    // 盘中量价异动提醒（默认开启）
    "ALTER TABLE telegram_subscribers ADD COLUMN IF NOT EXISTS volume_spike_enabled BOOLEAN NOT NULL DEFAULT TRUE",
    `CREATE TABLE IF NOT EXISTS watchlist (
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
    )`,
    `CREATE TABLE IF NOT EXISTS bot_sessions (
        chat_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS watchlist_state (
        chat_id TEXT PRIMARY KEY,
        initialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // 单用户时代的任务表，仅作为迁移来源保留
    `CREATE TABLE IF NOT EXISTS scheduled_runs (
        job_name TEXT NOT NULL,
        run_date DATE NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        message TEXT,
        PRIMARY KEY (job_name, run_date)
    )`,
    `CREATE TABLE IF NOT EXISTS daily_delivery_runs (
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
    )`,
    `CREATE TABLE IF NOT EXISTS kline_cache (
        symbol VARCHAR(6) NOT NULL,
        trade_date DATE NOT NULL,
        klines JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (symbol, trade_date)
    )`,
    // 以下历史数据均保留7天（见 history.js）：
    // 当日收盘报告（每只股票一份，多个用户共用，避免重复拉取行情与新闻）
    `CREATE TABLE IF NOT EXISTS stock_reports (
        report_date DATE NOT NULL,
        symbol VARCHAR(6) NOT NULL,
        report JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (report_date, symbol)
    )`,
    // 资金异动推送记录
    `CREATE TABLE IF NOT EXISTS fund_flow_alerts (
        id BIGSERIAL PRIMARY KEY,
        alert_date DATE NOT NULL,
        window_label TEXT NOT NULL,
        content JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    "CREATE INDEX IF NOT EXISTS fund_flow_alerts_date_idx ON fund_flow_alerts (alert_date)",
    // 资金异动监控状态（起点快照与已推送股票），重启后可恢复
    `CREATE TABLE IF NOT EXISTS fund_flow_state (
        state_date DATE NOT NULL,
        window_label TEXT NOT NULL,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (state_date, window_label)
    )`,
    // 已发送的管理员告警（按“日期:类型”去重，重启后不重复提醒）
    `CREATE TABLE IF NOT EXISTS admin_alerts (
        alert_key TEXT PRIMARY KEY,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
];

function createPool(connectionString) {
    if (!connectionString) throw new Error("缺少DATABASE_URL");
    return new Pool({ connectionString });
}

async function migrate(pool) {
    for (const statement of SCHEMA) await pool.query(statement);
}

class Rollback {
    constructor(value) {
        this.value = value;
    }
}

// 在事务回调中返回 rollback(value)：放弃本次事务的全部写入，并让 withTransaction 返回 value
function rollback(value) {
    return new Rollback(value);
}

// 在事务中执行fn；出错或fn返回rollback()时回滚，出错时丢弃可能已损坏的连接而不是放回连接池
async function withTransaction(pool, fn) {
    const client = await pool.connect();
    let failure;
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        if (result instanceof Rollback) {
            await client.query("ROLLBACK");
            return result.value;
        }
        await client.query("COMMIT");
        return result;
    } catch (error) {
        failure = error;
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release(failure);
    }
}

module.exports = { createPool, migrate, rollback, withTransaction };
