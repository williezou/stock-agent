// 本机/Docker运行的机器人：长轮询Telegram，无需公网地址
const { createBotApp } = require("../src/app");
const { config, requireConfig } = require("../src/config");
const telegram = require("../src/gateways/telegram");
const { delay } = require("../src/lib/async");
const { formatError } = require("../src/lib/http");
const { ALLOWED_UPDATES, configureTelegramPolling } = require("../src/services/bot-setup");

const POLL_TIMEOUT_SECONDS = 25;
const RETRY_DELAY_MS = 3000;

async function startPolling() {
    requireConfig({
        TELEGRAM_BOT_TOKEN: config.telegram.botToken,
        TELEGRAM_CHAT_ID: config.telegram.adminChatId,
        DATABASE_URL: config.databaseUrl
    });
    const { botController, store } = await createBotApp();
    await configureTelegramPolling();
    console.log("🤖 Telegram长轮询已启动，无需公网地址");

    let stopped = false;
    let offset;
    const stop = () => { stopped = true; };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);

    try {
        while (!stopped) {
            try {
                const updates = await telegram.telegramRequest("getUpdates", {
                    ...(offset === undefined ? {} : { offset }),
                    timeout: POLL_TIMEOUT_SECONDS,
                    allowed_updates: ALLOWED_UPDATES
                });
                for (const update of updates) {
                    offset = update.update_id + 1;
                    await botController.handleUpdateSafely(update);
                }
            } catch (error) {
                if (stopped) break;
                console.error(`⚠️ Telegram轮询失败，将重试：${formatError(error)}`);
                await delay(RETRY_DELAY_MS);
            }
        }
    } finally {
        await store.close();
        console.log("Telegram长轮询已停止");
    }
}

startPolling().catch(error => {
    console.error(`❌ Telegram长轮询启动失败：${formatError(error)}`);
    process.exit(1);
});
