const { config } = require("../config");
const { PHOTO_CAPTION_LIMIT } = require("../constants");
const { createHttpClient, requestWithRetry } = require("../lib/http");

let client;
function getClient() {
    if (!client) client = createHttpClient({ timeout: config.telegram.timeoutMs, label: "Telegram" });
    return client;
}

function methodUrl(method) {
    if (!config.telegram.botToken) throw new Error("缺少TELEGRAM_BOT_TOKEN");
    return `${config.telegram.apiBase}/bot${config.telegram.botToken}/${method}`;
}

async function telegramRequest(method, payload = {}) {
    const response = await requestWithRetry(() => getClient().post(methodUrl(method), payload), 3, 300);
    if (!response.data || response.data.ok !== true) {
        throw new Error(`Telegram ${method}请求失败`);
    }
    return response.data.result;
}

async function sendMessage(chatId, text, options = {}) {
    return telegramRequest("sendMessage", {
        chat_id: String(chatId),
        text,
        parse_mode: options.parseMode || "HTML",
        disable_web_page_preview: options.disableWebPagePreview !== false,
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
    });
}

function multipartField(boundary, name, value) {
    return Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`
    );
}

// 以multipart上传PNG，避免依赖额外的表单库
async function sendPhoto(chatId, photo, caption = "", filename = "chart.png") {
    if (!Buffer.isBuffer(photo)) throw new TypeError("photo必须是PNG Buffer");
    if (caption.length > PHOTO_CAPTION_LIMIT) throw new Error("Telegram图片说明超过1024字符限制");
    const url = methodUrl("sendPhoto");
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
    await requestWithRetry(() => getClient().post(url, body, {
        headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length
        },
        maxBodyLength: Infinity
    }), 3, 300);
}

async function answerCallbackQuery(callbackQueryId, options = {}) {
    return telegramRequest("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(options.text ? { text: options.text } : {}),
        ...(options.showAlert ? { show_alert: true } : {})
    });
}

// 用户屏蔽机器人时Telegram返回403
function isBotBlockedError(error) {
    return error?.response?.status === 403;
}

module.exports = {
    answerCallbackQuery,
    isBotBlockedError,
    sendMessage,
    sendPhoto,
    telegramRequest
};
