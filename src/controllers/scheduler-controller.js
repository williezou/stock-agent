const { config } = require("../config");
const telegram = require("../gateways/telegram");
const { defaultSourceNames } = require("../models/market/market-data");
const { getChinaClock, isWeekdayWindow, minutesOfDay } = require("../models/market/trading-calendar");
const { alertAdmin, sentAlerts } = require("../services/admin-alert");
const { resolveDailyPage } = require("../services/daily-page");
const { buildReports } = require("../services/daily-report");
const { deliverDailyClose } = require("../services/report-delivery");
const { sendAndRecord } = require("../services/tracked-delivery");
const { closeMessage, dailyPageButton } = require("../views/daily-page-view");
const { StockLink } = require("../views/stock-link");

// 每日收盘调度控制器：工作日北京时间15:30-18:00轮询，为每个订阅者领取并投递当日报告
const JOB_NAME = "daily-close";
const RETRY_DELAY_MS = 10 * 60 * 1000; // 与failDeliveryRun中的next_attempt_at间隔一致

const WINDOW_START = 15 * 60 + 30;
const FINAL_FROM = 17 * 60 + 30;
const WINDOW_END = 18 * 60;

function isRunWindow(now = new Date()) {
    return isWeekdayWindow(now, WINDOW_START, WINDOW_END);
}

function isFinalWindow(now = new Date()) {
    return minutesOfDay(now) >= FINAL_FROM;
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

function dataSourceAlerts(health, dateStr) {
    if (!health) return [];
    const alerts = [];
    const [primaryName, ...fallbackNames] = defaultSourceNames();
    if (health.primaryFailures > 0) {
        alerts.push({
            key: `${dateStr}:primary`,
            text: `⚠️ ${primaryName}行情接口异常（${health.lastPrimaryError || "未知错误"}，失败${health.primaryFailures}次），今日已自动切换备用源（${Object.keys(health.sources || {}).join("、") || fallbackNames.join("/")}）。`
        });
    }
    if (health.fallbackFailures > 0) {
        alerts.push({
            key: `${dateStr}:fallback`,
            text: `❌ ${[primaryName, ...fallbackNames].join("、")}行情源均获取失败（${health.fallbackFailures}只股票），相关用户的收盘报告将延迟或缺少这些股票。`
        });
    }
    return alerts;
}

async function runSchedulerTick(store, now = new Date(), services = {}) {
    if (!isRunWindow(now)) return { action: "outside-window" };
    const reportBuilder = services.buildReports || buildReports;
    const deliver = services.deliverDailyClose || deliverDailyClose;
    const notify = services.sendMessage || telegram.sendMessage;
    const { dateStr } = getChinaClock(now);
    const alertContext = {
        notify,
        adminChatId: services.adminChatId ?? config.telegram.adminChatId,
        alerted: services.alerted || store.adminAlerts || sentAlerts,
        dateStr
    };
    const subscribers = await store.listDueSubscribers(JOB_NAME, dateStr, config.scheduler.maxAttempts);
    const recipients = [];

    for (const subscriber of subscribers) {
        try {
            const targets = await store.list(subscriber.chat_id);
            if (!targets.length) continue;
            const attempt = await store.claimDeliveryRun(JOB_NAME, subscriber.chat_id, dateStr, config.scheduler.maxAttempts);
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
            allowPartial: true,
            klineCache: typeof store.getCachedKlines === "function" ? store : undefined,
            reportCache: typeof store.getCachedReports === "function" ? store : undefined
        });
    } catch (error) {
        await Promise.allSettled(recipients.map(recipient =>
            store.failDeliveryRun(JOB_NAME, recipient.subscriber.chat_id, dateStr, error.message)
        ));
        // 下一次重试已落在投递窗口外或次数用尽时，提示最终失败，而不是承诺会重试
        const retryAt = new Date(now.getTime() + RETRY_DELAY_MS);
        const lastChance = !isRunWindow(retryAt) || recipients.every(recipient => recipient.attempt >= config.scheduler.maxAttempts);
        await alertAdmin(alertContext, lastChance
            ? { key: `${dateStr}:build-final`, text: `❌ 今日收盘报告最终生成失败：${error.message}。已停止重试，今日不再推送。` }
            : { key: `${dateStr}:build`, text: `❌ 每日收盘报告生成失败：${error.message}。将在约10分钟后重试。` });
        throw error;
    }
    for (const alert of dataSourceAlerts(result.dataHealth, dateStr)) {
        await alertAdmin(alertContext, alert);
    }

    if (result.skipped) {
        const retry = isTransientSkip(result.reason) && !isFinalWindow(now);
        await Promise.allSettled(recipients.map(recipient => retry
            ? store.failDeliveryRun(JOB_NAME, recipient.subscriber.chat_id, dateStr, result.reason)
            : store.completeDeliveryRun(JOB_NAME, recipient.subscriber.chat_id, dateStr, "skipped", result.reason)
        ));
        return { action: retry ? "retry" : "skipped", recipients: recipients.length, reason: result.reason };
    }

    // 每日总结网页：先写盘中异动回顾（所有用户共用），每个用户写自己的收盘内容后只推一条概况+按钮；
    // 网页写入失败时该用户退回逐条推送图片
    const page = resolveDailyPage(services);
    if (page && typeof store.listFundFlowAlerts === "function") {
        await store.listFundFlowAlerts(dateStr)
            .then(alerts => page.publishIntraday(dateStr, alerts))
            .catch(error => console.error(`⚠️ 盘中异动回顾写入失败：${error.message}`));
    }
    async function deliverReports(chatId, reports) {
        if (page) {
            let url = null;
            try {
                url = await page.publishClose(await store.getSubscriber(chatId), { reports, date: dateStr });
            } catch (error) {
                console.error(`⚠️ ${chatId}的每日总结网页写入失败，改为逐条推送：${error.message}`);
            }
            if (url) return notify(chatId, closeMessage({ reports, date: result.date }), { replyMarkup: dailyPageButton(url) });
        }
        return deliver({ chatId, reports, date: result.date });
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
        const finalAttempt = recipient.attempt >= config.scheduler.maxAttempts || isFinalWindow(now);

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

        const outcome = await sendAndRecord(store, {
            jobName: JOB_NAME,
            chatId,
            runDate: dateStr,
            send: () => deliverReports(chatId, reports),
            doneMessage: missing.length ? `部分发送，缺少：${missing.map(target => target.symbol).join(",")}` : result.date
        });
        if (outcome !== "delivered") return outcome;
        if (missing.length) {
            // The report is already delivered; a failed notice must not trigger a full resend.
            const names = missing.map(target => StockLink.of(target).html());
            await notify(chatId, `⚠️ 以下股票今日没有完整日K，本次未包含：\n${names.join("\n")}`)
                .catch(error => console.error(`⚠️ 向${chatId}发送缺失提示失败：${error.message}`));
        }
        return "delivered";
    }
    return { action: "processed", recipients: recipients.length, ...totals };
}

module.exports = {
    dataSourceAlerts,
    isFinalWindow,
    isRunWindow,
    isTransientSkip,
    runSchedulerTick,
    uniqueTargets
};
