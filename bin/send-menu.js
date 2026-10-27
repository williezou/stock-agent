// 向管理员发送一条启动通知，同时清除旧的按钮键盘
const { config, requireConfig } = require("../src/config");
const telegram = require("../src/gateways/telegram");
const { MESSAGES, removeKeyboardMarkup } = require("../src/views/bot-view");

requireConfig({ TELEGRAM_BOT_TOKEN: config.telegram.botToken, TELEGRAM_CHAT_ID: config.telegram.adminChatId });
telegram.sendMessage(config.telegram.adminChatId, MESSAGES.serviceStarted, { replyMarkup: removeKeyboardMarkup() })
    .catch(error => {
        console.error(`❌ 菜单发送失败：${error.message}`);
        process.exit(1);
    });
