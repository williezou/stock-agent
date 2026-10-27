// 为webhook部署注册回调地址与Menu命令，并通知管理员
const { configureTelegramWebhook } = require("../src/services/bot-setup");

configureTelegramWebhook({ announce: true })
    .then(webhookUrl => console.log(`✅ Telegram webhook已配置为 ${webhookUrl}`))
    .catch(error => {
        console.error(`❌ Telegram配置失败：${error.message}`);
        process.exit(1);
    });
