const { menuReplyMarkup } = require("./bot-service");
const { sendTelegramTo, telegramRequest } = require("./telegram");

const COMMANDS = [
    { command: "menu", description: "显示操作菜单" },
    { command: "add", description: "添加每日追踪股票" },
    { command: "remove", description: "删除每日追踪股票" },
    { command: "list", description: "查看每日追踪列表" },
    { command: "cancel", description: "取消当前操作" }
];

function normalizeBaseUrl(value) {
    const baseUrl = String(value || "").replace(/\/$/, "");
    if (!baseUrl.startsWith("https://")) throw new Error("Webhook服务地址必须是HTTPS地址");
    return baseUrl;
}

async function configureTelegramWebhook(options = {}) {
    const baseUrl = normalizeBaseUrl(
        options.baseUrl || process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL
    );
    const secret = options.secret || process.env.TELEGRAM_WEBHOOK_SECRET;
    const chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;
    if (!secret) throw new Error("缺少TELEGRAM_WEBHOOK_SECRET");
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
        throw new Error("TELEGRAM_WEBHOOK_SECRET需为16-256位字母、数字、下划线或连字符");
    }

    const webhookUrl = `${baseUrl}/telegram/webhook`;
    await telegramRequest("setWebhook", {
        url: webhookUrl,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"]
    });
    await telegramRequest("setMyCommands", { commands: COMMANDS });

    if (options.announce) {
        if (!chatId) throw new Error("缺少TELEGRAM_CHAT_ID");
        await sendTelegramTo(chatId, "✅ 股票追踪菜单已启用。", { replyMarkup: menuReplyMarkup() });
    }
    return webhookUrl;
}

module.exports = { COMMANDS, configureTelegramWebhook, normalizeBaseUrl };
