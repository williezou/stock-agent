require("dotenv").config();

const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { getChinaClock, isAfterChinaClose } = require("./calendar");
const { generateOverviewChart, generateStockChart } = require("./daily-chart");
const { formatDailyCloseDelivery } = require("./daily-format");
const { createMarketService } = require("./market");
const { createNewsService } = require("./news");
const { DEFAULT_TARGETS } = require("./stocks");
const { sendTelegramPhotoTo } = require("./telegram");
const { analyzeKlines, buildTradePlan } = require("./technical");
const { createWatchlistStore } = require("./watchlist-store");

const PROXY_URL =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;

function createHttpClient() {
    if (!PROXY_URL) return axios.create({ timeout: 25000 });
    const masked = PROXY_URL.replace(/\/\/.*@/, "//****@");
    console.log(`🧭 使用代理: ${masked}`);
    const agent = new HttpsProxyAgent(PROXY_URL);
    return axios.create({
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: 25000
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestWithRetry(fn, retries = 3) {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (error) {
            attempt++;
            if (attempt > retries) throw error;
            await delay(400 * attempt);
        }
    }
}

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

function formatError(error) {
    if (!error) return "未知错误";
    let message = error.message || String(error);
    for (const secret of [
        process.env.TELEGRAM_BOT_TOKEN,
        process.env.TELEGRAM_CHAT_ID,
        PROXY_URL
    ].filter(Boolean)) {
        message = message.split(secret).join("****");
    }
    return message;
}

function commonLatestDate(klineSets) {
    if (!klineSets.length) return null;
    const common = new Set(klineSets[0].map(item => item.date));
    for (const rows of klineSets.slice(1)) {
        const dates = new Set(rows.map(item => item.date));
        for (const date of common) {
            if (!dates.has(date)) common.delete(date);
        }
    }
    return [...common].sort().at(-1) || null;
}

function selectReportDate(klineSets, { dryRun, now = new Date() }) {
    const { dateStr, weekday } = getChinaClock(now);
    const afterClose = isAfterChinaClose(now);

    if (!dryRun) {
        if (weekday === "Sat" || weekday === "Sun") {
            return { date: null, reason: "周末不发送" };
        }
        if (!afterClose) {
            return { date: null, reason: "北京时间15:15前不使用可能尚未收定的日K" };
        }
        const allHaveToday = klineSets.every(rows => rows.at(-1) && rows.at(-1).date === dateStr);
        if (!allHaveToday) {
            return { date: null, reason: `${dateStr}没有完整日K，按非交易日或数据未就绪处理` };
        }
        return { date: dateStr, reason: "" };
    }

    const completedSets = klineSets.map(rows => {
        if (rows.at(-1) && rows.at(-1).date === dateStr && !afterClose) return rows.slice(0, -1);
        return rows;
    });
    const date = commonLatestDate(completedSets);
    return date
        ? { date, reason: "" }
        : { date: null, reason: "没有两只股票共有的已完成日K" };
}

function prioritize(items, keywords) {
    return [...(items || [])]
        .filter(item => {
            const title = String(item.title || "").trim();
            return title.length >= 6 || keywords.some(keyword => title.includes(keyword));
        })
        .map((item, index) => {
            const title = String(item.title || "");
            const score = keywords.reduce((sum, keyword) => sum + (title.includes(keyword) ? 1 : 0), 0);
            return { item, index, score };
        })
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(entry => entry.item);
}

async function getContextItems(newsService, targets) {
    let index = new Map();
    try {
        index = await newsService.buildNewsNowIndex(targets);
    } catch (error) {
        console.log(`⚠️ 聚合新闻获取失败，继续使用个股新闻: ${formatError(error)}`);
    }

    return runPool(targets, async target => {
        const [newsResult, announcementResult] = await Promise.allSettled([
            newsService.getNews(target.symbol),
            newsService.getAnnouncements(target.symbol)
        ]);
        const directNews = newsResult.status === "fulfilled" ? newsResult.value : [];
        const announcements = announcementResult.status === "fulfilled" ? announcementResult.value : [];
        const mergedNews = newsService.mergeNewsLists(directNews, index.get(target.symbol) || []);
        return {
            news: prioritize(mergedNews, target.keywords),
            announcements: prioritize(announcements, target.keywords)
        };
    }, 2);
}

const KLINE_DAYS = 140;
const KLINE_CONCURRENCY = 3;
const KLINE_REQUEST_GAP_MS = 200;

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

// 只缓存字段完整的日K（东方财富、同花顺）；腾讯备用数据缺少历史成交额/换手率，不缓存，以便主源恢复后重新拉取
function isCompleteKlines(rows) {
    return rows.every(row => Number.isFinite(row.amount) && Number.isFinite(row.turnover));
}

// 限流拉取日K：并发上限+全局请求间隔，避免自选股并集较大时瞬间打满行情接口触发封禁；
// 传入klineCache时，当日已收定的完整日K会被缓存，重试只拉取尚未就绪的股票
async function fetchKlineSets(marketService, targets, { klineCache, dateStr, gapMs = KLINE_REQUEST_GAP_MS } = {}) {
    const waitTurn = createRateLimiter(gapMs);
    return runPool(targets, async target => {
        if (klineCache) {
            const cached = await klineCache.getCachedKlines(target.symbol, dateStr).catch(() => null);
            if (cached) return { status: "fulfilled", value: cached };
        }
        await waitTurn();
        try {
            const rows = await marketService.getDailyKline(target.symbol, KLINE_DAYS);
            if (klineCache && rows.at(-1) && rows.at(-1).date === dateStr && isCompleteKlines(rows)) {
                await klineCache.saveCachedKlines(target.symbol, dateStr, rows)
                    .catch(error => console.log(`⚠️ ${target.symbol}日K缓存写入失败: ${formatError(error)}`));
            }
            return { status: "fulfilled", value: rows };
        } catch (reason) {
            return { status: "rejected", reason };
        }
    }, KLINE_CONCURRENCY);
}

async function loadTargets() {
    if (!process.env.DATABASE_URL) return DEFAULT_TARGETS;
    if (!process.env.TELEGRAM_CHAT_ID) throw new Error("使用数据库自选股时必须配置TELEGRAM_CHAT_ID");
    const store = createWatchlistStore();
    try {
        await store.initialize();
        await store.seed(process.env.TELEGRAM_CHAT_ID, DEFAULT_TARGETS);
        return await store.list(process.env.TELEGRAM_CHAT_ID);
    } finally {
        await store.close();
    }
}

// 行情服务在进程内复用，数据源熔断冷却才能跨调度轮次生效（否则每轮都会重新冲击已封禁的接口）
let sharedServices;
function getSharedServices() {
    if (!sharedServices) {
        const httpClient = createHttpClient();
        sharedServices = { httpClient, marketService: createMarketService({ httpClient, requestWithRetry }) };
    }
    return sharedServices;
}

// 共享服务的健康计数是累计值，这里取本次调用期间的增量
function healthDelta(before, after) {
    const sources = {};
    for (const [name, count] of Object.entries(after.sources)) {
        const delta = count - (before.sources[name] || 0);
        if (delta > 0) sources[name] = delta;
    }
    return {
        primaryFailures: after.primaryFailures - before.primaryFailures,
        fallbackUsed: after.fallbackUsed - before.fallbackUsed,
        fallbackFailures: after.fallbackFailures - before.fallbackFailures,
        lastPrimaryError: after.primaryFailures > before.primaryFailures ? after.lastPrimaryError : "",
        sources
    };
}

async function buildReports({ dryRun = false, now = new Date(), targets, allowPartial = false, klineCache } = {}) {
    const { httpClient, marketService } = getSharedServices();
    const healthBefore = marketService.health();
    const dataHealth = () => healthDelta(healthBefore, marketService.health());
    const newsService = createNewsService({
        httpClient,
        requestWithRetry,
        runPool,
        delay,
        DEBUG: process.env.DEBUG === "1",
        formatError
    });

    const activeTargets = targets || await loadTargets();
    if (!activeTargets.length) {
        return { skipped: true, reason: "自选股列表为空", date: null, reports: [] };
    }
    let reportTargets = activeTargets;
    let unavailable = [];
    let klineSets;
    let selection;

    if (allowPartial && !dryRun) {
        const { dateStr, weekday } = getChinaClock(now);
        if (weekday === "Sat" || weekday === "Sun") {
            return { skipped: true, reason: "周末不发送", date: null, reports: [], unavailable: [] };
        }
        if (!isAfterChinaClose(now)) {
            return { skipped: true, reason: "北京时间15:15前不使用可能尚未收定的日K", date: null, reports: [], unavailable: [] };
        }
        const settled = await fetchKlineSets(marketService, activeTargets, { klineCache, dateStr });
        const ready = [];
        settled.forEach((result, index) => {
            const target = activeTargets[index];
            if (result.status === "rejected") {
                unavailable.push({ target, reason: formatError(result.reason) });
                return;
            }
            if (!result.value.at(-1) || result.value.at(-1).date !== dateStr) {
                unavailable.push({ target, reason: `${dateStr}没有完整日K` });
                return;
            }
            ready.push({ target, rows: result.value });
        });
        if (!ready.length) {
            return {
                skipped: true,
                reason: `${dateStr}没有完整日K，按非交易日或数据未就绪处理`,
                date: null,
                reports: [],
                unavailable,
                dataHealth: dataHealth()
            };
        }
        reportTargets = ready.map(item => item.target);
        klineSets = ready.map(item => item.rows);
        selection = { date: dateStr, reason: "" };
    } else {
        const settled = await fetchKlineSets(marketService, activeTargets);
        const failed = settled.find(result => result.status === "rejected");
        if (failed) throw failed.reason;
        klineSets = settled.map(result => result.value);
        selection = selectReportDate(klineSets, { dryRun, now });
    }
    if (!selection.date) return { skipped: true, reason: selection.reason, date: null, reports: [] };

    const contextItems = await getContextItems(newsService, reportTargets);
    const reports = reportTargets.map((meta, index) => {
        const rows = klineSets[index].filter(item => item.date <= selection.date);
        const analysis = analyzeKlines(rows);
        if (analysis.latest.date !== selection.date) {
            throw new Error(`${meta.name}缺少${selection.date}日K`);
        }
        return {
            meta,
            klines: rows,
            analysis,
            plan: buildTradePlan(analysis),
            news: contextItems[index].news,
            announcements: contextItems[index].announcements
        };
    });
    return { skipped: false, reason: "", date: selection.date, reports, unavailable, dataHealth: dataHealth() };
}

async function deliverDailyClose({ chatId, reports, date, dryRun = false }) {
    const delivery = formatDailyCloseDelivery({ reports, date });
    if (dryRun) {
        delivery.overviews.forEach((item, index) => {
            const overviewChart = generateOverviewChart(item.reports, date);
            console.log(`\n===== Telegram 总览图 ${index + 1}/${delivery.overviews.length}（${overviewChart.length} bytes）=====\n${item.caption}`);
        });
        delivery.stocks.forEach((item, index) => {
            const chart = generateStockChart(item.report);
            console.log(`\n===== Telegram 图表 ${index + 1}/${delivery.stocks.length}（${chart.length} bytes）=====\n${item.caption}`);
        });
        return delivery;
    }
    if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
        throw new Error("缺少TELEGRAM_BOT_TOKEN或目标chat_id，未发送任何消息");
    }
    for (const item of delivery.overviews) {
        await sendTelegramPhotoTo(chatId, generateOverviewChart(item.reports, date), item.caption, item.filename);
        await delay(350);
    }
    for (const item of delivery.stocks) {
        await delay(350);
        await sendTelegramPhotoTo(chatId, generateStockChart(item.report), item.caption, item.filename);
    }
    return delivery;
}

async function runDailyClose({ dryRun = process.argv.includes("--dry-run") } = {}) {
    console.log(`📈 开始生成每日自选股收盘分析${dryRun ? "（试运行）" : ""}...`);
    const result = await buildReports({ dryRun });
    if (result.skipped) {
        console.log(`🛑 本次不推送：${result.reason}`);
        return result;
    }

    const delivery = await deliverDailyClose({
        chatId: process.env.TELEGRAM_CHAT_ID,
        reports: result.reports,
        date: result.date,
        dryRun
    });
    if (dryRun) return { ...result, delivery };
    console.log(`✅ 已向Telegram发送${delivery.overviews.length}张总览图和${delivery.stocks.length}张${result.date}个股图表`);
    return { ...result, delivery };
}

if (require.main === module) {
    runDailyClose().catch(error => {
        console.error(`❌ 每日收盘任务失败：${formatError(error)}`);
        process.exitCode = 1;
    });
}

module.exports = {
    DEFAULT_TARGETS,
    buildReports,
    commonLatestDate,
    deliverDailyClose,
    fetchKlineSets,
    healthDelta,
    loadTargets,
    prioritize,
    runDailyClose,
    selectReportDate
};
