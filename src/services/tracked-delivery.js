const telegram = require("../gateways/telegram");
const { formatError } = require("../lib/http");

// 执行一次投递并记录任务状态（收盘报告与龙虎榜共用）：
// 成功 → done；用户屏蔽机器人 → 停用订阅并记 blocked；
// 其他失败 → finalAttempt 时记为终止的 failed（不再重试），否则 failDeliveryRun 等待10分钟后重领
async function sendAndRecord(store, { jobName, chatId, runDate, send, doneMessage = "", finalAttempt = false }) {
    try {
        await send();
    } catch (error) {
        if (telegram.isBotBlockedError(error)) {
            await store.deactivateSubscriber(chatId);
            await store.completeDeliveryRun(jobName, chatId, runDate, "blocked", "用户已阻止机器人");
            return "deactivated";
        }
        if (finalAttempt) {
            await store.completeDeliveryRun(jobName, chatId, runDate, "failed", formatError(error));
        } else {
            await store.failDeliveryRun(jobName, chatId, runDate, formatError(error));
        }
        return "failed";
    }
    await store.completeDeliveryRun(jobName, chatId, runDate, "done", doneMessage);
    return "delivered";
}

module.exports = { sendAndRecord };
