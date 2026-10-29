const { config } = require("../config");
const telegram = require("../gateways/telegram");
const { runPool } = require("../lib/async");
const { createHttpClient, formatError, requestWithRetry } = require("../lib/http");
const { createLimitUpService } = require("../models/market/limit-up");
const { createNewsService } = require("../models/market/news");
const { getChinaClock, isWeekdayWindow, minutesOfDay } = require("../models/market/trading-calendar");
const { alertAdmin } = require("../services/admin-alert");
const { resolveDailyPage } = require("../services/daily-page");
const { sendAndRecord } = require("../services/tracked-delivery");
const { generateLimitUpChart } = require("../views/charts/limit-up-chart");
const { formatLimitUpCaption, formatLimitUpText, limitUpKeyboard, summarizeLimitUp } = require("../views/limit-up-view");
const { QuoteApp } = require("../views/quote-app");

// 涨停复盘推送控制器：收盘后取东方财富涨停/跌停/炸板/昨日涨停四个池，连板股各附一条最新公告或新闻，
// 推送给开启 /limit 的用户（连板梯队图 + 概况 + 股票按钮），开启每日总结网页时同时写入网页并附网页按钮。
// 投递状态记在 daily_delivery_runs（失败10分钟后重试，重启不重复发送）；接口返回的数据日期不是当天时按休市跳过
const JOB_NAME = "limit-up";
const WINDOW_START = 15 * 60 + 5;
const FINAL_FROM = 16 * 60 + 30;
const WINDOW_END = 16 * 60 + 40;
// 公告/新闻只查连板股（最多这么多只），超过这个天数的不算“相关”
const MAX_CATALYST_STOCKS = 20;
const CATALYST_MAX_AGE_DAYS = 7;

function isLimitUpWindow(now = new Date()) {
    return isWeekdayWindow(now, WINDOW_START, WINDOW_END);
}

// 当天的内容只生成一次，所有用户共用（进程内缓存；重启后重新生成）；published：已写入每日总结网页
const contentCache = { date: "", content: null, published: false };

let defaultServices;
function getDefaultServices() {
    if (!defaultServices) {
        const httpClient = createHttpClient();
        defaultServices = {
            limitUp: createLimitUpService({ httpClient, requestWithRetry }),
            news: createNewsService({ httpClient, requestWithRetry })
        };
    }
    return defaultServices;
}

// 自动生成的行情播报只是复述涨停/资金/龙虎榜，不说明原因；交易异常波动公告也是例行公告
const ROUTINE_TITLE = /连板|涨停板|涨停走出|一字|龙虎榜|成交额|创.{0,12}新高|突破|主力资金|资金流|机构风向标|融资|大宗交易|异常波动|盘中播报|盘前|早盘|午盘|收盘|附股/;

function itemDate(item) {
    return String(item.date || item.time || "").slice(0, 10);
}

// 公告与新闻里取标题提到这只股票、且不是例行播报的最新一条（同一天新闻优先，通常直接说明了涨停原因）；太旧的不要
function latestCatalyst(stock, { news = [], announcements = [] }, dateStr) {
    const oldest = new Date(Date.parse(`${dateStr}T00:00:00Z`) - CATALYST_MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);
    const mentions = title => title.includes(stock.symbol) || (stock.name && title.includes(stock.name));
    return [...news, ...announcements]
        .filter(item => item && item.title && mentions(item.title) && !ROUTINE_TITLE.test(item.title))
        .filter(item => itemDate(item) >= oldest && itemDate(item) <= dateStr)
        .sort((a, b) => itemDate(b).localeCompare(itemDate(a)))[0] || null;
}

// 新闻按代码取最新、按名称取最相关各一页（两种搜法各有漏掉的），再加最新公告
async function findCatalysts(stocks, news, dateStr) {
    const catalysts = {};
    await runPool(stocks.slice(0, MAX_CATALYST_STOCKS), async stock => {
        const [byCode, byName, announcements] = await Promise.all([
            news.searchNews(stock.symbol, { sort: "time", pageSize: 10 }).catch(() => []),
            news.searchNews(stock.name, { sort: "default", pageSize: 10 }).catch(() => []),
            news.getAnnouncements(stock.symbol).catch(() => [])
        ]);
        const catalyst = latestCatalyst(stock, { news: [...byCode, ...byName], announcements }, dateStr);
        if (catalyst) catalysts[stock.symbol] = { title: catalyst.title, url: catalyst.url, date: itemDate(catalyst) };
    }, 3);
    return catalysts;
}

// 返回 null 表示当天休市（接口的数据日期不是当天）
async function buildContent(dateStr, { limitUp, news }) {
    const pools = await limitUp.getDailyPools(dateStr);
    if (pools.dataDate !== dateStr) return null;
    const ladderStocks = summarizeLimitUp(pools).ladder.flatMap(level => level.stocks);
    return { ...pools, catalysts: await findCatalysts(ladderStocks, news, dateStr) };
}

// 优先发图表（图片只上传一次，之后引用 file_id），图表生成失败时退回文字版；按钮打开各自选择的App，并附各自的网页按钮
function prepareSend(content, { render, sendPhoto, sendMessage, pageUrl }) {
    let png = null;
    try {
        png = render(content);
    } catch (error) {
        console.error(`⚠️ 涨停复盘图表生成失败，改发文字：${formatError(error)}`);
    }
    let fileId = null;
    const caption = QuoteApp.memo(app => formatLimitUpCaption(content, { app }));
    const text = QuoteApp.memo(app => formatLimitUpText(content, { app }));
    return async subscriber => {
        const chatId = subscriber.chat_id;
        const app = QuoteApp.forSubscriber(subscriber);
        const replyMarkup = limitUpKeyboard(content, { app, pageUrl: await pageUrl(subscriber) });
        if (!png) return sendMessage(chatId, text(app), { replyMarkup });
        const message = await sendPhoto(chatId, fileId || png, caption(app), `limit-up-${content.date}.png`, { replyMarkup });
        fileId = fileId || telegram.largestPhotoFileId(message);
    };
}

async function skipAll(store, subscribers, dateStr, reason) {
    for (const subscriber of subscribers) {
        if (await store.claimDeliveryRun(JOB_NAME, subscriber.chat_id, dateStr, config.scheduler.maxAttempts).catch(() => null) !== null) {
            await store.completeDeliveryRun(JOB_NAME, subscriber.chat_id, dateStr, "skipped", reason).catch(() => {});
        }
    }
}

async function runLimitUpTick(store, now = new Date(), services = {}) {
    if (!isLimitUpWindow(now)) return { action: "outside-window" };
    const { dateStr } = getChinaClock(now);
    const subscribers = await store.listDueSubscribers(JOB_NAME, dateStr, config.scheduler.maxAttempts, { audience: "limitUp" });
    if (!subscribers.length) return { action: "not-due" };

    const final = minutesOfDay(now) >= FINAL_FROM;
    const cache = services.cache || contentCache;
    const notify = services.sendMessage || telegram.sendMessage;
    const alertContext = {
        notify,
        adminChatId: services.adminChatId ?? config.telegram.adminChatId,
        alerted: services.alerted || store.adminAlerts,
        dateStr
    };
    if (cache.date !== dateStr) {
        let content;
        try {
            content = await buildContent(dateStr, { ...getDefaultServices(), ...services });
        } catch (error) {
            console.error(`⚠️ 涨停复盘生成失败：${formatError(error)}`);
            if (final) {
                await alertAdmin(alertContext, { key: `${dateStr}:limit-up`, text: `❌ 今日涨停复盘生成失败：${formatError(error)}，今日不再推送。` });
                await skipAll(store, subscribers, dateStr, "涨停复盘生成失败");
            }
            return { action: "build-failed", final };
        }
        Object.assign(cache, { date: dateStr, content, published: false });
    }
    if (!cache.content) {
        await skipAll(store, subscribers, dateStr, "休市");
        return { action: "skipped", reason: "休市" };
    }
    const content = cache.content;

    const page = resolveDailyPage(services);
    if (page && !cache.published) {
        try {
            await page.publishLimitUp({ date: dateStr, content, render: services.renderChart || generateLimitUpChart });
            cache.published = true;
        } catch (error) {
            console.error(`⚠️ 涨停复盘网页写入失败，推送不带网页按钮：${formatError(error)}`);
        }
    }
    const send = prepareSend(content, {
        render: services.renderChart || generateLimitUpChart,
        sendPhoto: services.sendPhoto || telegram.sendPhoto,
        sendMessage: notify,
        // 入口页按用户的推送开关与所选App生成；写入失败时不带网页按钮
        pageUrl: async subscriber => {
            if (!page || !cache.published) return null;
            return page.publishIndex(await store.getSubscriber(subscriber.chat_id), dateStr)
                .catch(error => { console.error(`⚠️ ${subscriber.chat_id}的每日总结入口页写入失败：${formatError(error)}`); return null; });
        }
    });
    const totals = { delivered: 0, failed: 0, deactivated: 0 };
    for (const subscriber of subscribers) {
        const chatId = subscriber.chat_id;
        try {
            if (await store.claimDeliveryRun(JOB_NAME, chatId, dateStr, config.scheduler.maxAttempts) === null) continue;
            totals[await sendAndRecord(store, { jobName: JOB_NAME, chatId, runDate: dateStr, send: () => send(subscriber), finalAttempt: final })]++;
        } catch (error) {
            console.error(`❌ 处理${chatId}的涨停复盘投递失败：${formatError(error)}`);
            totals.failed++;
        }
    }
    if (final && totals.failed) {
        await alertAdmin(alertContext, { key: `${dateStr}:limit-up-send`, text: `⚠️ 今日涨停复盘有${totals.failed}位用户推送失败，已无重试机会。` });
    }
    return { action: "processed", limitUp: content.limitUp.length, recipients: subscribers.length, ...totals };
}

module.exports = { buildContent, isLimitUpWindow, latestCatalyst, runLimitUpTick };
