require("dotenv").config();

// 所有环境变量集中在此读取，其他模块只依赖这里导出的配置。
// 使用getter在每次访问时读取，运行期修改的环境变量（如测试中设置）也能生效
const env = process.env;

const config = {
    telegram: {
        get botToken() { return env.TELEGRAM_BOT_TOKEN || ""; },
        // 管理员会话：接收告警、不受邀请码与名额限制，也是单用户脚本的默认推送目标
        get adminChatId() { return env.TELEGRAM_CHAT_ID || ""; },
        get apiBase() { return env.TELEGRAM_API_BASE || "https://api.telegram.org"; },
        get timeoutMs() { return Number(env.TELEGRAM_TIMEOUT_MS || 60000); },
        get webhookSecret() { return env.TELEGRAM_WEBHOOK_SECRET || ""; },
        get publicBaseUrl() { return env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || ""; }
    },
    registration: {
        get inviteCode() { return env.BOT_INVITE_CODE || ""; },
        get openRegistration() { return env.BOT_OPEN_REGISTRATION === "true"; },
        get maxSubscribers() { return Number(env.MAX_SUBSCRIBERS || 50); },
        maxStocksPerUser: 10
    },
    get databaseUrl() { return env.DATABASE_URL || ""; },
    get proxyUrl() { return env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy || ""; },
    get newsNowBaseUrl() { return env.NEWSNOW_BASE_URL || "https://newsnow.busiyi.world"; },
    server: {
        get port() { return Number(env.PORT || 10000); },
        host: "0.0.0.0"
    },
    scheduler: {
        get checkIntervalMs() { return Number(env.SCHEDULER_CHECK_INTERVAL_MS || 30000); },
        get maxAttempts() { return Number(env.DAILY_CLOSE_MAX_ATTEMPTS || 12); }
    },
    get debug() { return env.DEBUG === "1" || env.DEBUG === "true"; }
};

// 启动时校验必需配置，缺失时一次性列出全部缺项
function requireConfig(entries) {
    const missing = Object.entries(entries).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`缺少配置：${missing.join("、")}`);
}

module.exports = { config, requireConfig };
