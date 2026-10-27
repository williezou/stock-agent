require("dotenv").config();

const { configureTelegramWebhook } = require("../telegram-setup");

async function configureTelegram() {
    const webhookUrl = await configureTelegramWebhook({ announce: true });
    console.log(`✅ Telegram webhook已配置为 ${webhookUrl}`);
}

configureTelegram().catch(error => {
    console.error(`❌ Telegram配置失败：${error.message}`);
    process.exit(1);
});
