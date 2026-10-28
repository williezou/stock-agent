const { config } = require("../config");
const { WEBHOOK_PATH } = require("../constants");
const telegram = require("../gateways/telegram");
const { ADMIN_COMMANDS, BOT_COMMANDS, MESSAGES, removeKeyboardMarkup } = require("../views/bot-view");

const ALLOWED_UPDATES = ["message", "callback_query"];

function normalizeBaseUrl(value) {
    const baseUrl = String(value || "").replace(/\/$/, "");
    if (!baseUrl.startsWith("https://")) throw new Error("Webhook服务地址必须是HTTPS地址");
    return baseUrl;
}

function validateWebhookSecret(secret) {
    if (!secret) throw new Error("缺少TELEGRAM_WEBHOOK_SECRET");
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
        throw new Error("TELEGRAM_WEBHOOK_SECRET需为16-256位字母、数字、下划线或连字符");
    }
}

// Webhook模式：注册回调地址与Menu命令；announce时通知管理员（并清除旧的按钮键盘）
async function configureTelegramWebhook(options = {}) {
    const baseUrl = normalizeBaseUrl(options.baseUrl || config.telegram.publicBaseUrl);
    const secret = options.secret || config.telegram.webhookSecret;
    const chatId = options.chatId || config.telegram.adminChatId;
    validateWebhookSecret(secret);

    const webhookUrl = `${baseUrl}${WEBHOOK_PATH}`;
    await telegram.telegramRequest("setWebhook", {
        url: webhookUrl,
        secret_token: secret,
        allowed_updates: ALLOWED_UPDATES
    });
    await setMenuCommands();

    if (options.announce) {
        if (!chatId) throw new Error("缺少TELEGRAM_CHAT_ID");
        await telegram.sendMessage(chatId, MESSAGES.webhookReady, { replyMarkup: removeKeyboardMarkup() });
    }
    return webhookUrl;
}

// 长轮询模式：删除webhook（保留未处理消息）并注册Menu命令
async function configureTelegramPolling() {
    await telegram.telegramRequest("deleteWebhook", { drop_pending_updates: false });
    await setMenuCommands();
}

// 所有人的Menu命令；管理员会话额外显示管理员命令（按会话设置的命令优先于默认命令）
async function setMenuCommands() {
    await telegram.telegramRequest("setMyCommands", { commands: BOT_COMMANDS });
    if (config.telegram.adminChatId) {
        await telegram.telegramRequest("setMyCommands", {
            commands: [...BOT_COMMANDS, ...ADMIN_COMMANDS],
            scope: { type: "chat", chat_id: config.telegram.adminChatId }
        });
    }
}

module.exports = {
    ALLOWED_UPDATES,
    configureTelegramPolling,
    configureTelegramWebhook,
    normalizeBaseUrl,
    validateWebhookSecret
};
