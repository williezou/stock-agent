// 云端（如Render）运行的机器人：HTTP服务接收Telegram webhook
const http = require("node:http");
const { createBotApp } = require("../src/app");
const { config, requireConfig } = require("../src/config");
const { createWebhookHandler } = require("../src/controllers/webhook-controller");
const { formatError } = require("../src/lib/http");
const { configureTelegramWebhook, validateWebhookSecret } = require("../src/services/bot-setup");

async function startServer() {
    requireConfig({
        TELEGRAM_BOT_TOKEN: config.telegram.botToken,
        DATABASE_URL: config.databaseUrl,
        TELEGRAM_WEBHOOK_SECRET: config.telegram.webhookSecret,
        TELEGRAM_CHAT_ID: config.telegram.adminChatId
    });
    validateWebhookSecret(config.telegram.webhookSecret);

    const { botController, store } = await createBotApp();
    const server = http.createServer(createWebhookHandler({
        botController,
        webhookSecret: config.telegram.webhookSecret
    }));

    const { host, port } = config.server;
    server.listen(port, host, () => {
        console.log(`🤖 Telegram webhook服务已监听 ${host}:${port}`);
        if (config.telegram.publicBaseUrl) {
            configureTelegramWebhook()
                .then(webhookUrl => console.log(`✅ Telegram webhook已自动配置为 ${webhookUrl}`))
                .catch(error => console.error(`❌ Telegram webhook自动配置失败：${formatError(error)}`));
        }
    });

    function shutdown(signal) {
        console.log(`收到${signal}，正在关闭服务...`);
        server.close(async () => {
            await store.close();
            process.exit(0);
        });
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer().catch(error => {
    console.error(`❌ Webhook服务启动失败：${formatError(error)}`);
    process.exit(1);
});
