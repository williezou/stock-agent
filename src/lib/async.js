function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 固定并发数的任务池，结果顺序与输入一致
async function runPool(items, worker, concurrency = 3) {
    const results = new Array(items.length);
    let index = 0;
    async function next() {
        while (true) {
            const current = index++;
            if (current >= items.length) return;
            results[current] = await worker(items[current], current);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
    return results;
}

// 全局请求节流：所有并发worker共享同一时间槽，保证相邻两次请求至少间隔gapMs，而不是每个worker各等一遍
function createRateLimiter(gapMs) {
    let nextAt = 0;
    return async function wait() {
        const now = Date.now();
        const at = Math.max(now, nextAt);
        nextAt = at + gapMs;
        if (at > now) await delay(at - now);
    };
}

module.exports = { createRateLimiter, delay, runPool };
