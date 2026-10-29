require("dotenv").config();

// 所有环境变量集中在此读取，其他模块只依赖这里导出的配置。
// 使用getter在每次访问时读取，运行期修改的环境变量（如测试中设置）也能生效
const env = process.env;

// 数值配置：未设置或不是正数时用默认值，避免填错后轮询间隔或门槛悄悄失效
function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

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
    // 纯IPv6网络（如无公网IPv4的云主机）：行情改走有IPv6的接口入口，跳过没有IPv6的同花顺
    get ipv6Only() { return env.IPV6_ONLY === "true"; },
    server: {
        get port() { return Number(env.PORT || 10000); },
        host: "0.0.0.0"
    },
    scheduler: {
        get checkIntervalMs() { return Number(env.SCHEDULER_CHECK_INTERVAL_MS || 30000); },
        get maxAttempts() { return Number(env.DAILY_CLOSE_MAX_ATTEMPTS || 12); }
    },
    // 资金异动提醒：时间段“名称@HH:MM-HH:MM”，多个用逗号分隔（如再加“开盘@09:30-10:00”）；
    // 区间主力净额变化同时达到金额（万元）与占当日成交额比例（%）两个门槛才推送
    fundFlow: {
        get windows() { return env.FUND_FLOW_WINDOWS || "尾盘@14:30-15:00"; },
        get pollMinutes() { return Math.ceil(positiveNumber(env.FUND_FLOW_POLL_MINUTES, 1)); },
        get minAmount() { return positiveNumber(env.FUND_FLOW_MIN_AMOUNT_WAN, 5000) * 10000; },
        get minRatio() { return positiveNumber(env.FUND_FLOW_MIN_RATIO_PCT, 2) / 100; }
    },
    // 量价异动提醒：时间段格式同上（默认避开午休与深市收盘集合竞价）；回看分钟数内成交额（万元）与涨跌幅变化（个百分点）同时达到门槛才推送
    volumeSpike: {
        get windows() { return env.VOLUME_SPIKE_WINDOWS || "上午@09:30-11:30,下午@13:00-14:57"; },
        get lookbackMinutes() { return Math.ceil(positiveNumber(env.VOLUME_SPIKE_LOOKBACK_MINUTES, 5)); },
        get pushMinutes() { return Math.ceil(positiveNumber(env.VOLUME_SPIKE_PUSH_MINUTES, 10)); },
        get minAmount() { return positiveNumber(env.VOLUME_SPIKE_MIN_AMOUNT_WAN, 5000) * 10000; },
        get minChangePct() { return positiveNumber(env.VOLUME_SPIKE_MIN_CHANGE_PCT, 2); }
    },
    get debug() { return env.DEBUG === "1" || env.DEBUG === "true"; }
};

// 启动时校验必需配置，缺失时一次性列出全部缺项
function requireConfig(entries) {
    const missing = Object.entries(entries).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`缺少配置：${missing.join("、")}`);
}

module.exports = { config, requireConfig };
