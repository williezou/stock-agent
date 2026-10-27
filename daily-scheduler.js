require("dotenv").config();

const { getChinaClock } = require("./calendar");
const { runDailyClose } = require("./daily-close");
const { createWatchlistStore } = require("./watchlist-store");

const CHECK_INTERVAL_MS = Number(process.env.SCHEDULER_CHECK_INTERVAL_MS || 30000);
const MAX_ATTEMPTS = Number(process.env.DAILY_CLOSE_MAX_ATTEMPTS || 12);

function isRunWindow(now = new Date()) {
    const clock = getChinaClock(now);
    if (clock.weekday === "Sat" || clock.weekday === "Sun") return false;
    const minutes = clock.hour * 60 + clock.minute;
    return minutes >= 15 * 60 + 30 && minutes < 18 * 60;
}

function isTransientSkip(reason) {
    return /没有完整日K|数据未就绪/.test(String(reason || ""));
}

async function runSchedulerTick(store, now = new Date()) {
    if (!isRunWindow(now)) return { action: "outside-window" };
    const { dateStr } = getChinaClock(now);
    const claimed = await store.claimScheduledRun("daily-close", dateStr, MAX_ATTEMPTS);
    if (!claimed) return { action: "not-claimed" };

    try {
        const result = await runDailyClose({ dryRun: false });
        if (result.skipped && isTransientSkip(result.reason)) {
            await store.failScheduledRun("daily-close", dateStr, result.reason);
            return { action: "retry", reason: result.reason };
        }
        const status = result.skipped ? "skipped" : "done";
        await store.completeScheduledRun("daily-close", dateStr, status, result.reason || result.date);
        return { action: status, reason: result.reason || "" };
    } catch (error) {
        await store.failScheduledRun("daily-close", dateStr, error.message);
        throw error;
    }
}

async function startScheduler() {
    if (!process.env.DATABASE_URL) throw new Error("缺少DATABASE_URL");
    const store = createWatchlistStore();
    await store.initialize();
    console.log("⏰ 每日收盘调度器已启动：工作日北京时间15:30-18:00自动补偿执行");

    let stopped = false;
    const stop = () => { stopped = true; };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
        while (!stopped) {
            try {
                const outcome = await runSchedulerTick(store);
                if (!["outside-window", "not-claimed"].includes(outcome.action)) {
                    console.log(`📅 调度结果：${outcome.action}${outcome.reason ? `（${outcome.reason}）` : ""}`);
                }
            } catch (error) {
                console.error(`❌ 每日收盘调度失败：${error.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS));
        }
    } finally {
        await store.close();
        console.log("每日收盘调度器已停止");
    }
}

if (require.main === module) {
    startScheduler().catch(error => {
        console.error(`❌ 调度器启动失败：${error.message}`);
        process.exit(1);
    });
}

module.exports = { isRunWindow, isTransientSkip, runSchedulerTick, startScheduler };
