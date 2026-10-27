require("dotenv").config();

const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { createBotController } = require("./bot-service");
const { createMarketService } = require("./market");
const { DEFAULT_TARGETS } = require("./stocks");
const { answerCallbackQuery, sendTelegramTo, telegramRequest } = require("./telegram");
const { COMMANDS } = require("./telegram-setup");
const { createWatchlistStore } = require("./watchlist-store");

const ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID || "";
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;

function requireConfiguration() {
    const missing = [
        ["TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN],
        ["TELEGRAM_CHAT_ID", ALLOWED_CHAT_ID],
        ["DATABASE_URL", process.env.DATABASE_URL]
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`缺少配置：${missing.join("、")}`);
}

function createHttpClient() {
    if (!PROXY_URL) return axios.create({ timeout: 25000 });
    const agent = new HttpsProxyAgent(PROXY_URL);
    return axios.create({ httpAgent: agent, httpsAgent: agent, proxy: false, timeout: 25000 });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestWithRetry(fn, retries = 3) {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (error) {
            attempt++;
            if (attempt > retries) throw error;
            await delay(400 * attempt);
        }
    }
}

async function startPolling() {
    requireConfiguration();
    const store = createWatchlistStore();
    await store.initialize();
    await store.seed(ALLOWED_CHAT_ID, DEFAULT_TARGETS);
    const marketService = createMarketService({ httpClient: createHttpClient(), requestWithRetry });
    const controller = createBotController({
        store,
        marketService,
        sendMessage: sendTelegramTo,
        answerCallback: answerCallbackQuery,
        allowedChatId: ALLOWED_CHAT_ID,
        allowedUserId: ALLOWED_USER_ID
    });

    await telegramRequest("deleteWebhook", { drop_pending_updates: false });
    await telegramRequest("setMyCommands", { commands: COMMANDS });
    console.log("🤖 Telegram长轮询已启动，无需公网地址");

    let stopped = false;
    let offset;
    const stop = () => { stopped = true; };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);

    try {
        while (!stopped) {
            try {
                const updates = await telegramRequest("getUpdates", {
                    ...(offset === undefined ? {} : { offset }),
                    timeout: 25,
                    allowed_updates: ["message", "callback_query"]
                });
                for (const update of updates) {
                    offset = update.update_id + 1;
                    try {
                        await controller.handleUpdate(update);
                    } catch (error) {
                        console.error(`❌ Telegram更新处理失败：${error.message}`);
                        const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
                        if (chatId && String(chatId) === String(ALLOWED_CHAT_ID)) {
                            await sendTelegramTo(chatId, "❌ 操作失败，请稍后重试。").catch(() => {});
                        }
                    }
                }
            } catch (error) {
                if (stopped) break;
                console.error(`⚠️ Telegram轮询失败，将重试：${error.message}`);
                await delay(3000);
            }
        }
    } finally {
        await store.close();
        console.log("Telegram长轮询已停止");
    }
}

if (require.main === module) {
    startPolling().catch(error => {
        console.error(`❌ Telegram长轮询启动失败：${error.message}`);
        process.exit(1);
    });
}

module.exports = { startPolling };
