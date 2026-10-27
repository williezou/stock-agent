// 多用户每日收盘调度器：常驻进程，按固定间隔执行调度轮次
const { openStore } = require("../src/app");
const { config, requireConfig } = require("../src/config");
const { runSchedulerTick } = require("../src/controllers/scheduler-controller");
const { delay } = require("../src/lib/async");
const { formatError } = require("../src/lib/http");

const QUIET_OUTCOMES = ["outside-window", "not-claimed"];

async function startScheduler() {
    requireConfig({
        DATABASE_URL: config.databaseUrl,
        TELEGRAM_BOT_TOKEN: config.telegram.botToken,
        TELEGRAM_CHAT_ID: config.telegram.adminChatId
    });
    const store = await openStore();
    console.log("⏰ 多用户收盘调度器已启动：工作日北京时间15:30-18:00按用户独立投递");

    let stopped = false;
    const stop = () => { stopped = true; };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
        while (!stopped) {
            try {
                const outcome = await runSchedulerTick(store);
                if (!QUIET_OUTCOMES.includes(outcome.action)) {
                    console.log(`📅 调度结果：${JSON.stringify(outcome)}`);
                }
            } catch (error) {
                console.error(`❌ 每日收盘调度失败：${formatError(error)}`);
            }
            await delay(config.scheduler.checkIntervalMs);
        }
    } finally {
        await store.close();
        console.log("每日收盘调度器已停止");
    }
}

startScheduler().catch(error => {
    console.error(`❌ 调度器启动失败：${formatError(error)}`);
    process.exit(1);
});
