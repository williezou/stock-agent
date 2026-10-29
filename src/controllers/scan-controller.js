const { config } = require("../config");
const telegram = require("../gateways/telegram");
const { formatError } = require("../lib/http");
const { getChinaClock, isWeekdayWindow, minutesOfDay, nowChinaString } = require("../models/market/trading-calendar");
const { alertAdmin } = require("../services/admin-alert");
const { resolveDailyPage } = require("../services/daily-page");
const { runScan } = require("../services/scan");
const { sendAndRecord } = require("../services/tracked-delivery");
const { QuoteApp } = require("../views/quote-app");
const { formatScanMessage, formatScanSummary } = require("../views/scan-view");

// A股扫描推送控制器（原在 GitHub Actions 只推给管理员）：收盘后扫描一次，写成所有用户共用的网页（按App各一份），
// 给开启 /scan 的用户推送今日结论 + 网页按钮；网页写入失败时推送完整的扫描结论文字。
// 15:40 起避开收盘报告首轮（扫描要一两分钟，调度器逐个任务执行）；投递状态记在 daily_delivery_runs
const JOB_NAME = "scan";
const WINDOW_START = 15 * 60 + 40;
const FINAL_FROM = 17 * 60;
const WINDOW_END = 17 * 60 + 20;
// 取数失败后隔一段时间再扫，不在每轮调度都重跑
const RETRY_AFTER_MS = 10 * 60 * 1000;

function isScanWindow(now = new Date()) {
    return isWeekdayWindow(now, WINDOW_START, WINDOW_END);
}

// 当天的扫描结果只生成一次，所有用户共用（进程内缓存；重启后重新扫描）
const scanCache = { date: "", result: null, failedAt: 0, pageUrl: null };

async function skipAll(store, subscribers, dateStr, reason) {
    for (const subscriber of subscribers) {
        if (await store.claimDeliveryRun(JOB_NAME, subscriber.chat_id, dateStr, config.scheduler.maxAttempts).catch(() => null) !== null) {
            await store.completeDeliveryRun(JOB_NAME, subscriber.chat_id, dateStr, "skipped", reason).catch(() => {});
        }
    }
}

async function runScanTick(store, now = new Date(), services = {}) {
    if (!isScanWindow(now)) return { action: "outside-window" };
    const { dateStr } = getChinaClock(now);
    const subscribers = await store.listDueSubscribers(JOB_NAME, dateStr, config.scheduler.maxAttempts, { audience: "scan" });
    if (!subscribers.length) return { action: "not-due" };

    const final = minutesOfDay(now) >= FINAL_FROM;
    const cache = services.cache || scanCache;
    const notify = services.sendMessage || telegram.sendMessage;
    const alertContext = {
        notify,
        adminChatId: services.adminChatId ?? config.telegram.adminChatId,
        alerted: services.alerted || store.adminAlerts,
        dateStr
    };
    if (cache.date !== dateStr) Object.assign(cache, { date: dateStr, result: null, failedAt: 0, pageUrl: null });
    if (!cache.result) {
        if (cache.failedAt && now.getTime() - cache.failedAt < RETRY_AFTER_MS && !final) return { action: "waiting" };
        let result;
        try {
            result = await (services.runScan || runScan)();
        } catch (error) {
            result = { ok: false, retryable: true, reason: formatError(error) };
        }
        if (!result.ok && !result.retryable) {
            await skipAll(store, subscribers, dateStr, result.reason);
            return { action: "skipped", reason: result.reason };
        }
        if (!result.ok) {
            console.error(`⚠️ A股扫描失败：${result.reason}`);
            cache.failedAt = now.getTime();
            if (final) {
                await alertAdmin(alertContext, { key: `${dateStr}:scan`, text: `❌ 今日A股扫描失败：${result.reason}，今日不再推送。` });
                await skipAll(store, subscribers, dateStr, "扫描失败");
            }
            return { action: "scan-failed", final };
        }
        cache.result = { ...result, now: services.now || nowChinaString(now) };
        const page = resolveDailyPage(services);
        if (page) {
            try {
                cache.pageUrl = await page.publishScan({ date: dateStr, now: cache.result.now, picksByStyle: result.picksByStyle, longhiData: result.longhiData });
            } catch (error) {
                console.error(`⚠️ A股扫描网页写入失败，改为推送扫描结论：${formatError(error)}`);
            }
        }
    }

    const result = cache.result;
    const message = QuoteApp.memo(app => formatScanMessage(result, { app }));
    const fallback = formatScanSummary({ now: result.now, picksByStyle: result.picksByStyle, longhiData: result.longhiData });
    const send = subscriber => {
        const app = QuoteApp.forSubscriber(subscriber);
        if (!cache.pageUrl) return notify(subscriber.chat_id, fallback);
        return notify(subscriber.chat_id, message(app), { replyMarkup: { inline_keyboard: [[{ text: "📈 打开今日A股扫描", url: cache.pageUrl(app) }]] } });
    };
    const totals = { delivered: 0, failed: 0, deactivated: 0 };
    for (const subscriber of subscribers) {
        const chatId = subscriber.chat_id;
        try {
            if (await store.claimDeliveryRun(JOB_NAME, chatId, dateStr, config.scheduler.maxAttempts) === null) continue;
            totals[await sendAndRecord(store, { jobName: JOB_NAME, chatId, runDate: dateStr, send: () => send(subscriber), finalAttempt: final })]++;
        } catch (error) {
            console.error(`❌ 处理${chatId}的A股扫描投递失败：${formatError(error)}`);
            totals.failed++;
        }
    }
    if (final && totals.failed) {
        await alertAdmin(alertContext, { key: `${dateStr}:scan-send`, text: `⚠️ 今日A股扫描有${totals.failed}位用户推送失败，已无重试机会。` });
    }
    return { action: "processed", recipients: subscribers.length, page: Boolean(cache.pageUrl), ...totals };
}

module.exports = { isScanWindow, runScanTick };
