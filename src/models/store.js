const { config } = require("../config");
const { createPool, migrate } = require("./db");
const { createDeliveryRunRepository } = require("./delivery-run");
const { createHistoryRepository } = require("./history");
const { createKlineCacheRepository } = require("./kline-cache");
const { createSessionRepository } = require("./session");
const { createSubscriberRepository } = require("./subscriber");
const { createWatchlistRepository } = require("./watchlist");

// 数据访问的统一入口：组合各表的仓储，并提供跨表的操作
function createStore({ connectionString = config.databaseUrl } = {}) {
    const pool = createPool(connectionString);
    const subscribers = createSubscriberRepository(pool);
    const sessions = createSessionRepository(pool);
    const watchlist = createWatchlistRepository(pool);
    const deliveryRuns = createDeliveryRunRepository(pool);
    const klineCache = createKlineCacheRepository(pool);
    const history = createHistoryRepository(pool);

    // 清理超过保留期（7天）的缓存与历史数据；启动时执行一次，调度器每天再执行一次
    async function pruneExpired() {
        await klineCache.pruneExpired();
        await history.pruneHistory();
    }

    async function initialize() {
        await migrate(pool);
        await pruneExpired();
    }

    // 停用订阅时一并清掉未完成的对话状态
    async function deactivateSubscriber(chatId) {
        const changed = await subscribers.deactivateSubscriber(chatId);
        await sessions.clearSession(chatId);
        return changed;
    }

    // 拉黑时一并清掉未完成的对话状态
    async function setSubscriberBanned(chatId, banned) {
        const subscriber = await subscribers.setSubscriberBanned(chatId, banned);
        if (subscriber && banned) await sessions.clearSession(chatId);
        return subscriber;
    }

    // 确保管理员存在（不覆盖其/stop状态）、播种默认自选股，并迁移旧任务记录
    async function bootstrapAdmin(chatId, defaultTargets) {
        await subscribers.ensureSubscriber(chatId);
        await watchlist.seed(chatId, defaultTargets);
        await deliveryRuns.migrateLegacyScheduledRuns(chatId);
    }

    return {
        ...subscribers,
        ...sessions,
        ...watchlist,
        ...deliveryRuns,
        ...klineCache,
        ...history,
        bootstrapAdmin,
        close: () => pool.end(),
        deactivateSubscriber,
        initialize,
        pruneExpired,
        setSubscriberBanned
    };
}

module.exports = { createStore };
