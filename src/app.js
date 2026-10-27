const { config } = require("./config");
const { createBotController } = require("./controllers/bot-controller");
const telegram = require("./gateways/telegram");
const { createHttpClient, requestWithRetry } = require("./lib/http");
const { createMarketService } = require("./models/market/market-data");
const { DEFAULT_TARGETS } = require("./models/stock");
const { createStore } = require("./models/store");

// 初始化数据库并确保管理员订阅存在（不覆盖其/stop状态）
async function openStore() {
    const store = createStore();
    await store.initialize();
    await store.bootstrapAdmin(config.telegram.adminChatId, DEFAULT_TARGETS);
    return store;
}

// 组装机器人：数据库 + 行情服务 + Telegram网关 → 控制器（webhook与长轮询共用）
async function createBotApp() {
    const store = await openStore();
    const marketService = createMarketService({ httpClient: createHttpClient(), requestWithRetry });
    const botController = createBotController({
        store,
        marketService,
        sendMessage: telegram.sendMessage,
        answerCallback: telegram.answerCallbackQuery
    });
    return { botController, store };
}

module.exports = { createBotApp, openStore };
