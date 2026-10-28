// 每日调度器：常驻进程，按固定间隔执行资金异动、收盘报告与龙虎榜任务的调度轮次（A股扫描在GitHub Actions执行）
const { openStore } = require("../src/app");
const { config, requireConfig } = require("../src/config");
const { createMonitors, runFundFlowTick } = require("../src/controllers/fund-flow-controller");
const { runLonghuTick } = require("../src/controllers/longhu-controller");
const { runSchedulerTick } = require("../src/controllers/scheduler-controller");
const { chinaDateString } = require("../src/models/market/trading-calendar");
const { delay } = require("../src/lib/async");
const { formatError } = require("../src/lib/http");

const QUIET_OUTCOMES = ["outside-window", "not-claimed", "not-due", "waiting"];
const JOBS = [
    { label: "资金异动", tick: runFundFlowTick },
    { label: "收盘报告", tick: runSchedulerTick },
    { label: "龙虎榜", tick: runLonghuTick }
];

async function startScheduler() {
    requireConfig({
        DATABASE_URL: config.databaseUrl,
        TELEGRAM_BOT_TOKEN: config.telegram.botToken,
        TELEGRAM_CHAT_ID: config.telegram.adminChatId
    });
    createMonitors(); // 资金异动时间段格式错误时启动即失败，而不是每轮报错
    const store = await openStore();
    console.log(`⏰ 调度器已启动（工作日北京时间）：资金异动 ${config.fundFlow.windows}，15:30-18:00 收盘报告，17:30-20:30 龙虎榜发布后推送`);

    // 启动时 openStore 已清理过一次过期数据（保留7天），之后每天换日时再清理
    let prunedDate = chinaDateString();
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
        while (!stopped) {
            if (chinaDateString() !== prunedDate) {
                prunedDate = chinaDateString();
                await store.pruneExpired().catch(error => console.error(`⚠️ 清理过期数据失败：${formatError(error)}`));
            }
            // 各任务并行且相互独立：收盘报告耗时较长时不会拖延龙虎榜检查，一个任务出错也不影响另一个
            await Promise.all(JOBS.map(async job => {
                try {
                    const outcome = await job.tick(store);
                    if (!QUIET_OUTCOMES.includes(outcome.action)) {
                        console.log(`📅 ${job.label}调度结果：${JSON.stringify(outcome)}`);
                    }
                } catch (error) {
                    console.error(`❌ ${job.label}调度失败：${formatError(error)}`);
                }
            }));
            await delay(config.scheduler.checkIntervalMs);
        }
    } finally {
        await store.close();
        console.log("每日调度器已停止");
    }
}

startScheduler().catch(error => {
    console.error(`❌ 调度器启动失败：${formatError(error)}`);
    process.exit(1);
});
