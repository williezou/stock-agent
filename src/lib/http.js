const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { config } = require("../config");
const { delay } = require("./async");

const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// 按配置的代理创建axios客户端；label用于启动日志区分不同用途的客户端
function createHttpClient({ timeout = 25000, label = "" } = {}) {
    if (!config.proxyUrl) return axios.create({ timeout });
    const masked = config.proxyUrl.replace(/\/\/.*@/, "//****@");
    console.log(`🧭 ${label ? `${label} ` : ""}使用代理: ${masked}`);
    const agent = new HttpsProxyAgent(config.proxyUrl);
    return axios.create({ httpAgent: agent, httpsAgent: agent, proxy: false, timeout });
}

// 失败后按线性退避重试，共尝试 retries + 1 次
async function requestWithRetry(fn, retries = 3, backoffMs = 400) {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (error) {
            attempt++;
            if (attempt > retries) throw error;
            await delay(backoffMs * attempt);
        }
    }
}

// 错误信息写入日志或消息前脱敏，避免泄露token、chat id与代理凭据
function formatError(error) {
    if (!error) return "未知错误";
    let message = error.message || String(error);
    for (const secret of [config.telegram.botToken, config.telegram.adminChatId, config.proxyUrl].filter(Boolean)) {
        message = message.split(secret).join("****");
    }
    return message;
}

module.exports = { BROWSER_USER_AGENT, createHttpClient, formatError, requestWithRetry };
