require("dotenv").config();

const { getChinaClock } = require("./calendar");
const { buildReports, deliverDailyClose } = require("./daily-close");
const { escapeHtml } = require("./daily-format");
const { DEFAULT_TARGETS } = require("./stocks");
const { sendTelegramTo } = require("./telegram");
const { createWatchlistStore } = require("./watchlist-store");

const CHECK_INTERVAL_MS = Number(process.env.SCHEDULER_CHECK_INTERVAL_MS || 30000);
const MAX_ATTEMPTS = Number(process.env.DAILY_CLOSE_MAX_ATTEMPTS || 12);
const JOB_NAME = "daily-close";

function isRunWindow(now = new Date()) {
    const clock = getChinaClock(now);
    if (clock.weekday === "Sat" || clock.weekday === "Sun") return false;
    const minutes = clock.hour * 60 + clock.minute;
    return minutes >= 15 * 60 + 30 && minutes < 18 * 60;
}

function isFinalWindow(now = new Date()) {
    const { hour, minute } = getChinaClock(now);
    return hour * 60 + minute >= 17 * 60 + 30;
}

function isTransientSkip(reason) {
    return /没有完整日K|数据未就绪/.test(String(reason || ""));
}

function uniqueTargets(recipients) {
    const targets = new Map();
    for (const recipient of recipients) {
        for (const target of recipient.targets) {
            if (!targets.has(target.symbol)) targets.set(target.symbol, target);
        }
    }
    return [...targets.values()];
}

function isBotBlocked(error) {
    return error?.response?.status === 403;
}

async function runSchedulerTick(store, now = new Date(), services = {}) {
    if (!isRunWindow(now)) return { action: "outside-window" };
    const reportBuilder = services.buildReports || buildReports;
    const deliver = services.deliverDailyClose || deliverDailyClose;
    const notify = services.sendTelegramTo || sendTelegramTo;
    const { dateStr } = getChinaClock(now);
    const subscribers = await store.listDueSubscribers(JOB_NAME, dateStr, MAX_ATTEMPTS);
    const recipients = [];

    for (const subscriber of subscribers) {
        try {
            const targets = await store.list(subscriber.chat_id);
            if (!targets.length) continue;
            const attempt = await store.claimDeliveryRun(JOB_NAME, subscriber.chat_id, dateStr, MAX_ATTEMPTS);
            if (attempt !== null) recipients.push({ subscriber, targets, attempt });
        } catch (error) {
            console.error(`❌ 领取${subscriber.chat_id}的投递任务失败：${error.message}`);
        }
    }
    if (!recipients.length) return { action: "not-claimed" };

    let result;
    try {
        result = await reportBuilder({
            targets: uniqueTargets(recipients),
            now,
            dryRun: false,
            allowPartial: true
        });
    } catch (error) {
        await Promise.allSettled(recipients.map(recipient =>
            store.failDeliveryRun(JOB_NAME, recipient.subscriber.chat_id, dateStr, error.message)
        ));
        throw error;
    }

    if (result.skipped) {
        const retry = isTransientSkip(result.reason) && !isFinalWindow(now);
        await Promise.allSettled(recipients.map(recipient => retry
            ? store.failDeliveryRun(JOB_NAME, recipient.subscriber.chat_id, dateStr, result.reason)
            : store.completeDeliveryRun(JOB_NAME, recipient.subscriber.chat_id, dateStr, "skipped", result.reason)
        ));
        return { action: retry ? "retry" : "skipped", recipients: recipients.length, reason: result.reason };
    }

    const reportBySymbol = new Map(result.reports.map(report => [report.meta.symbol, report]));
    const totals = { delivered: 0, retried: 0, skipped: 0, failed: 0, deactivated: 0 };
    for (const recipient of recipients) {
        try {
            totals[await deliverToRecipient(recipient)]++;
        } catch (error) {
            // Store errors must not abort the tick and strand later recipients in 'running'.
            console.error(`❌ 处理${recipient.subscriber.chat_id}的投递状态失败：${error.message}`);
            totals.failed++;
        }
    }

    async function deliverToRecipient(recipient) {
        const chatId = recipient.subscriber.chat_id;
        const reports = recipient.targets.map(target => reportBySymbol.get(target.symbol)).filter(Boolean);
        const missing = recipient.targets.filter(target => !reportBySymbol.has(target.symbol));
        const finalAttempt = recipient.attempt >= MAX_ATTEMPTS || isFinalWindow(now);

        if (missing.length && !finalAttempt) {
            await store.failDeliveryRun(
                JOB_NAME,
                chatId,
                dateStr,
                `等待日K：${missing.map(target => target.symbol).join(",")}`
            );
            return "retried";
        }
        if (!reports.length) {
            await store.completeDeliveryRun(
                JOB_NAME,
                chatId,
                dateStr,
                "skipped",
                `无可用日K：${missing.map(target => target.symbol).join(",")}`
            );
            return "skipped";
        }

        try {
            await deliver({ chatId, reports, date: result.date });
        } catch (error) {
            if (isBotBlocked(error)) {
                await store.deactivateSubscriber(chatId);
                await store.completeDeliveryRun(JOB_NAME, chatId, dateStr, "blocked", "用户已阻止机器人");
                return "deactivated";
            }
            await store.failDeliveryRun(JOB_NAME, chatId, dateStr, error.message);
            return "failed";
        }
        await store.completeDeliveryRun(
            JOB_NAME,
            chatId,
            dateStr,
            "done",
            missing.length ? `部分发送，缺少：${missing.map(target => target.symbol).join(",")}` : result.date
        );
        if (missing.length) {
            // The report is already delivered; a failed notice must not trigger a full resend.
            const names = missing.map(target => `<code>${target.symbol}</code> ${escapeHtml(target.name)}`);
            await notify(chatId, `⚠️ 以下股票今日没有完整日K，本次未包含：\n${names.join("\n")}`)
                .catch(error => console.error(`⚠️ 向${chatId}发送缺失提示失败：${error.message}`));
        }
        return "delivered";
    }
    return { action: "processed", recipients: recipients.length, ...totals };
}

async function startScheduler() {
    const missing = ["DATABASE_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]
        .filter(name => !process.env[name]);
    if (missing.length) throw new Error(`缺少配置：${missing.join("、")}`);
    const store = createWatchlistStore();
    await store.initialize();
    await store.bootstrapAdmin(process.env.TELEGRAM_CHAT_ID, DEFAULT_TARGETS);
    console.log("⏰ 多用户收盘调度器已启动：工作日北京时间15:30-18:00按用户独立投递");

    let stopped = false;
    const stop = () => { stopped = true; };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
        while (!stopped) {
            try {
                const outcome = await runSchedulerTick(store);
                if (!["outside-window", "not-claimed"].includes(outcome.action)) {
                    console.log(`📅 调度结果：${JSON.stringify(outcome)}`);
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

module.exports = {
    isFinalWindow,
    isRunWindow,
    isTransientSkip,
    runSchedulerTick,
    startScheduler,
    uniqueTargets
};
