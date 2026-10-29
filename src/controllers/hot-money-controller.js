const { config } = require("../config");
const telegram = require("../gateways/telegram");
const { createHttpClient, formatError, requestWithRetry } = require("../lib/http");
const { aggregateSeats, createHotMoneyService } = require("../models/market/hot-money");
const { createLonghuService } = require("../models/market/longhu");
const { getChinaClock, isWeekdayWindow, minutesOfDay } = require("../models/market/trading-calendar");
const { alertAdmin } = require("../services/admin-alert");
const { resolveDailyPage } = require("../services/daily-page");
const { sendAndRecord } = require("../services/tracked-delivery");
const { generateHotMoneyChart } = require("../views/charts/hot-money-chart");
const { QuoteApp } = require("../views/quote-app");
const { dailyPageButton, longhuUpdatedMessage } = require("../views/daily-page-view");
const { formatHotMoneyCaption, formatHotMoneyText, isHighWinRate } = require("../views/hot-money-view");

// 游资动向推送控制器：当天龙虎榜推送成功（榜单已发布完成）后，汇总游资席位推送给开启龙虎榜推送的用户；
// 投递状态记在 daily_delivery_runs（失败10分钟后重试，重启不重复发送）。
// 开启每日总结网页时，游资动向写入网页，推送改为“龙虎榜与游资动向已更新”一条消息加网页按钮（当天第二条，没有游资净买入也推）
const JOB_NAME = "hot-money";
const LONGHU_JOB = "longhu";
const WINDOW_START = 17 * 60 + 30;
const FINAL_FROM = 20 * 60 + 40;
const WINDOW_END = 20 * 60 + 50;
const TOP_SEATS = 10;
const HIGH_WIN_SEATS = 8;

function isHotMoneyWindow(now = new Date()) {
    return isWeekdayWindow(now, WINDOW_START, WINDOW_END);
}

// 当天的推送内容只生成一次，所有用户共用（进程内缓存；重启后重新生成，数据不变）；published：已写入每日总结网页
const contentCache = { date: "", content: null, published: false };

let defaultServices;
function getDefaultServices() {
    if (!defaultServices) {
        const httpClient = createHttpClient();
        defaultServices = {
            hotMoney: createHotMoneyService({ httpClient, requestWithRetry }),
            longhu: createLonghuService({ httpClient, requestWithRetry })
        };
    }
    return defaultServices;
}

// 游资净买入前N家，以及当日净买入的高胜率游资（不论净买入排第几，按胜率排序），附营业部近一年统计；
// 股票名称取自当天龙虎榜榜单
async function buildContent(dateStr, { hotMoney, longhu }) {
    const board = await longhu.getBoardByDate(dateStr);
    const names = new Map(board.map(item => [item.symbol, item.name]));
    const all = aggregateSeats(await hotMoney.getSeatTrades(dateStr), names);
    const buyers = all.filter(seat => seat.net > 0);
    const stats = buyers.length ? await hotMoney.getSeatStats(buyers.map(seat => seat.code)) : new Map();
    const withStats = buyers.map(seat => ({ ...seat, stats: stats.get(seat.code) || null }));
    return {
        date: dateStr,
        totalSeats: all.length,
        seats: withStats.slice(0, TOP_SEATS),
        highWinSeats: withStats
            .filter(seat => isHighWinRate(seat.stats))
            .sort((a, b) => b.stats.riseProbability - a.stats.riseProbability || b.net - a.net)
            .slice(0, HIGH_WIN_SEATS)
    };
}

// 优先发图表（图片只上传一次，之后引用 file_id），图表生成失败时退回文字版；股票名称链接按各自选择的App
function prepareSend(content, { render, sendPhoto, sendMessage }) {
    let png = null;
    try {
        png = render(content);
    } catch (error) {
        console.error(`⚠️ 游资动向图表生成失败，改发文字：${formatError(error)}`);
    }
    let fileId = null;
    const caption = QuoteApp.memo(app => formatHotMoneyCaption(content, { app }));
    const text = QuoteApp.memo(app => formatHotMoneyText(content, { app }));
    return async subscriber => {
        const chatId = subscriber.chat_id;
        const app = QuoteApp.forSubscriber(subscriber);
        if (!png) return sendMessage(chatId, text(app));
        const message = await sendPhoto(chatId, fileId || png, caption(app), `hot-money-${content.date}.png`);
        fileId = fileId || telegram.largestPhotoFileId(message);
    };
}

async function runHotMoneyTick(store, now = new Date(), services = {}) {
    if (!isHotMoneyWindow(now)) return { action: "outside-window" };
    const { dateStr } = getChinaClock(now);
    const subscribers = await store.listDueSubscribers(JOB_NAME, dateStr, config.scheduler.maxAttempts, { audience: "longhu" });
    if (!subscribers.length) return { action: "not-due" };
    // 龙虎榜推送成功说明当天榜单已发布完成；龙虎榜跳过（休市、未发布）时游资动向也不推
    if (!await store.hasCompletedRun(LONGHU_JOB, dateStr)) return { action: "waiting" };

    const final = minutesOfDay(now) >= FINAL_FROM;
    const cache = services.cache || contentCache;
    const notify = services.sendMessage || telegram.sendMessage;
    const alertContext = {
        notify,
        adminChatId: services.adminChatId ?? config.telegram.adminChatId,
        alerted: services.alerted || store.adminAlerts,
        dateStr
    };
    if (cache.date !== dateStr || !cache.content) {
        try {
            cache.content = await buildContent(dateStr, { ...getDefaultServices(), ...services });
            cache.date = dateStr;
            cache.published = false;
        } catch (error) {
            console.error(`⚠️ 游资动向生成失败：${formatError(error)}`);
            if (final) {
                await alertAdmin(alertContext, { key: `${dateStr}:hot-money`, text: `❌ 今日游资动向生成失败：${formatError(error)}，今日不再推送。` });
                for (const subscriber of subscribers) {
                    if (await store.claimDeliveryRun(JOB_NAME, subscriber.chat_id, dateStr, config.scheduler.maxAttempts).catch(() => null) !== null) {
                        await store.completeDeliveryRun(JOB_NAME, subscriber.chat_id, dateStr, "skipped", "游资动向生成失败").catch(() => {});
                    }
                }
            }
            return { action: "build-failed", final };
        }
    }
    const content = cache.content;

    const page = resolveDailyPage(services);
    if (page && !cache.published) {
        try {
            await page.publishHotMoney({ date: dateStr, content, render: services.renderChart || generateHotMoneyChart });
            cache.published = true;
        } catch (error) {
            console.error(`⚠️ 游资动向网页写入失败，改为推送图片：${formatError(error)}`);
        }
    }
    const send = page && cache.published
        ? async subscriber => notify(subscriber.chat_id, longhuUpdatedMessage({ date: dateStr, hotMoney: content }), {
            replyMarkup: dailyPageButton(await page.publishIndex(await store.getSubscriber(subscriber.chat_id), dateStr))
        })
        : content.seats.length || content.highWinSeats.length
        ? prepareSend(content, {
            render: services.renderChart || generateHotMoneyChart,
            sendPhoto: services.sendPhoto || telegram.sendPhoto,
            sendMessage: notify
        })
        : null;
    const totals = { delivered: 0, skipped: 0, failed: 0, deactivated: 0 };
    for (const subscriber of subscribers) {
        const chatId = subscriber.chat_id;
        try {
            if (await store.claimDeliveryRun(JOB_NAME, chatId, dateStr, config.scheduler.maxAttempts) === null) continue;
            if (!send) {
                await store.completeDeliveryRun(JOB_NAME, chatId, dateStr, "skipped", "今日没有游资净买入");
                totals.skipped++;
                continue;
            }
            totals[await sendAndRecord(store, { jobName: JOB_NAME, chatId, runDate: dateStr, send: () => send(subscriber), finalAttempt: final })]++;
        } catch (error) {
            console.error(`❌ 处理${chatId}的游资动向投递失败：${formatError(error)}`);
            totals.failed++;
        }
    }
    return { action: "processed", seats: content.seats.length, recipients: subscribers.length, ...totals };
}

module.exports = { buildContent, isHotMoneyWindow, runHotMoneyTick };
