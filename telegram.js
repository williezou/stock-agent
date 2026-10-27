const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PROXY_URL =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;
const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS || 60000);
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";

function createClient() {
    if (!PROXY_URL) return axios.create({ timeout: TELEGRAM_TIMEOUT_MS });
    const masked = PROXY_URL.replace(/\/\/.*@/, "//****@");
    console.log(`🧭 Telegram 使用代理: ${masked}`);
    const agent = new HttpsProxyAgent(PROXY_URL);
    return axios.create({
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: TELEGRAM_TIMEOUT_MS
    });
}

const client = createClient();

async function requestWithRetry(fn, retries = 3) {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (e) {
            attempt++;
            if (attempt > retries) throw e;
            const backoff = 300 * attempt;
            await new Promise(r => setTimeout(r, backoff));
        }
    }
}

async function telegramRequest(method, payload = {}) {
    if (!TELEGRAM_BOT_TOKEN) throw new Error("缺少TELEGRAM_BOT_TOKEN");
    const url = `${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/${method}`;
    const response = await requestWithRetry(() => client.post(url, payload));
    if (!response.data || response.data.ok !== true) {
        throw new Error(`Telegram ${method}请求失败`);
    }
    return response.data.result;
}

async function sendTelegramTo(chatId, text, options = {}) {
    return telegramRequest("sendMessage", {
        chat_id: String(chatId),
        text,
        parse_mode: options.parseMode || "HTML",
        disable_web_page_preview: options.disableWebPagePreview !== false,
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
    });
}

async function sendTelegram(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    return sendTelegramTo(TELEGRAM_CHAT_ID, text);
}

function multipartField(boundary, name, value) {
    return Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`
    );
}

async function sendTelegramPhotoTo(chatId, photo, caption = "", filename = "chart.png") {
    if (!TELEGRAM_BOT_TOKEN) throw new Error("缺少TELEGRAM_BOT_TOKEN");
    if (!Buffer.isBuffer(photo)) throw new TypeError("photo必须是PNG Buffer");
    if (caption.length > 1024) throw new Error("Telegram图片说明超过1024字符限制");
    const safeFilename = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    const boundary = `----stock-agent-${Date.now().toString(16)}`;
    const body = Buffer.concat([
        multipartField(boundary, "chat_id", String(chatId)),
        multipartField(boundary, "caption", caption),
        multipartField(boundary, "parse_mode", "HTML"),
        Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="photo"; filename="${safeFilename}"\r\n` +
            "Content-Type: image/png\r\n\r\n"
        ),
        photo,
        Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const url = `${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
    await requestWithRetry(() => client.post(url, body, {
        headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length
        },
        maxBodyLength: Infinity
    }));
}

async function sendTelegramPhoto(photo, caption = "", filename = "chart.png") {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    return sendTelegramPhotoTo(TELEGRAM_CHAT_ID, photo, caption, filename);
}

async function answerCallbackQuery(callbackQueryId, options = {}) {
    return telegramRequest("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(options.text ? { text: options.text } : {}),
        ...(options.showAlert ? { show_alert: true } : {})
    });
}

module.exports = {
    answerCallbackQuery,
    sendTelegram,
    sendTelegramPhoto,
    sendTelegramPhotoTo,
    sendTelegramTo,
    telegramRequest
};
