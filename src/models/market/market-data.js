const { isNotFound } = require("./sources/common");
const { createEastmoneySource } = require("./sources/eastmoney");
const { createTencentSource } = require("./sources/tencent");
const { createTonghuashunSource } = require("./sources/tonghuashun");

const SOURCE_FAILURE_THRESHOLD = 2; // 某数据源连续失败达到次数后暂停访问，避免在封禁期间持续请求
const SOURCE_COOLDOWN_MS = 30 * 60 * 1000;

// 行情数据服务：按 东方财富 → 同花顺 → 腾讯 顺序自动切换，每个数据源独立熔断。
// 进程内应复用同一实例，熔断冷却才能跨调度轮次生效
function createMarketService({ httpClient, requestWithRetry, now = () => Date.now(), sources }) {
    const sourceList = sources || [
        createEastmoneySource({ httpClient, requestWithRetry }),
        createTonghuashunSource({ httpClient, requestWithRetry }),
        createTencentSource({ httpClient, requestWithRetry })
    ];
    const health = { primaryFailures: 0, fallbackUsed: 0, fallbackFailures: 0, lastPrimaryError: "", sources: {} };
    const breakers = new Map();

    function breaker(name) {
        if (!breakers.has(name)) breakers.set(name, { consecutive: 0, pausedUntil: 0 });
        const state = breakers.get(name);
        // 冷却结束后重新计数，给数据源完整的恢复机会，而不是一次偶发失败就再次暂停
        if (state.pausedUntil && now() >= state.pausedUntil) {
            state.pausedUntil = 0;
            state.consecutive = 0;
        }
        return state;
    }

    function recordFailure(name, index, error) {
        const state = breaker(name);
        state.consecutive++;
        if (state.consecutive >= SOURCE_FAILURE_THRESHOLD) state.pausedUntil = now() + SOURCE_COOLDOWN_MS;
        if (index === 0) {
            health.primaryFailures++;
            health.lastPrimaryError = error.code || error.message || String(error);
        }
    }

    async function withFailover(call) {
        let lastError;
        let notFoundError;
        for (const [index, source] of sourceList.entries()) {
            if (now() < breaker(source.name).pausedUntil) continue;
            try {
                const result = await call(source);
                breaker(source.name).consecutive = 0;
                if (index > 0) health.fallbackUsed++;
                health.sources[source.name] = (health.sources[source.name] || 0) + 1;
                return result;
            } catch (error) {
                if (isNotFound(error)) {
                    // 数据源正常响应但查无此股：不计入熔断，继续向下一个源确认
                    breaker(source.name).consecutive = 0;
                    notFoundError = notFoundError || error;
                    continue;
                }
                lastError = error;
                recordFailure(source.name, index, error);
            }
        }
        // 所有可用源都确认查无此股时按“代码无效”处理，不算数据源故障
        if (notFoundError && !lastError) throw notFoundError;
        health.fallbackFailures++;
        throw lastError || new Error("所有行情数据源均处于冷却期");
    }

    return {
        getDailyKline: (symbol, limit = 120) => withFailover(source => source.getDailyKline(symbol, limit)),
        getStockProfile: symbol => withFailover(source => source.getStockProfile(symbol)),
        health: () => ({ ...health, sources: { ...health.sources } })
    };
}

// 共享实例的健康计数是累计值，取某次调用期间的增量
function healthDelta(before, after) {
    const sources = {};
    for (const [name, count] of Object.entries(after.sources)) {
        const delta = count - (before.sources[name] || 0);
        if (delta > 0) sources[name] = delta;
    }
    return {
        primaryFailures: after.primaryFailures - before.primaryFailures,
        fallbackUsed: after.fallbackUsed - before.fallbackUsed,
        fallbackFailures: after.fallbackFailures - before.fallbackFailures,
        lastPrimaryError: after.primaryFailures > before.primaryFailures ? after.lastPrimaryError : "",
        sources
    };
}

module.exports = { createMarketService, healthDelta };
