const { config } = require("../config");
const { PHOTO_CAPTION_LIMIT } = require("../constants");
const { createHttpClient, requestWithRetry } = require("../lib/http");
const { visibleLength } = require("../lib/telegram-text");

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

// 发送图片并返回Telegram消息对象。photo为PNG Buffer时以multipart上传（避免依赖表单库）；
// 为字符串时视为已上传图片的 file_id，直接引用而不重复上传
// options.replyMarkup：附在图片下方的按钮
async function sendPhoto(chatId, photo, caption = "", filename = "chart.png", options = {}) {
    if (visibleLength(caption) > PHOTO_CAPTION_LIMIT) throw new Error("Telegram图片说明超过1024字符限制");
    const replyMarkup = options.replyMarkup ? { reply_markup: options.replyMarkup } : {};
    if (typeof photo === "string") {
        return telegramRequest("sendPhoto", { chat_id: String(chatId), photo, caption, parse_mode: "HTML", ...replyMarkup });
    }
    if (!Buffer.isBuffer(photo)) throw new TypeError("photo必须是PNG Buffer或file_id");
    const url = methodUrl("sendPhoto");
    const safeFilename = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    const boundary = `----stock-agent-${Date.now().toString(16)}`;
    const body = Buffer.concat([
        multipartField(boundary, "chat_id", String(chatId)),
        multipartField(boundary, "caption", caption),
        multipartField(boundary, "parse_mode", "HTML"),
        ...(options.replyMarkup ? [multipartField(boundary, "reply_markup", JSON.stringify(options.replyMarkup))] : []),
        Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="photo"; filename="${safeFilename}"\r\n` +
            "Content-Type: image/png\r\n\r\n"
        ),
        photo,
        Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const response = await requestWithRetry(() => getClient().post(url, body, {
        headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length
        },
        maxBodyLength: Infinity
    }), 3, 300);
    return response.data && response.data.result;
}

// Telegram为同一图片生成多种尺寸，取最大尺寸的 file_id 供后续引用
function largestPhotoFileId(message) {
    const sizes = (message && message.photo) || [];
    return sizes.length ? sizes[sizes.length - 1].file_id : null;
}

// 机器人自身信息（用户名用于生成 t.me 深层链接），进程内只查询一次
let botProfile;
async function getMe() {
    if (!botProfile) botProfile = await telegramRequest("getMe");
    return botProfile;
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
    getMe,
    isBotBlockedError,
    largestPhotoFileId,
    sendMessage,
    sendPhoto,
    telegramRequest
};
