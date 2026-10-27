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

async function buildReports({ dryRun = false, now = new Date(), targets, allowPartial = false } = {}) {
    const httpClient = createHttpClient();
    const marketService = createMarketService({ httpClient, requestWithRetry });
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
        const settled = await Promise.allSettled(
            activeTargets.map(target => marketService.getDailyKline(target.symbol, 140))
        );
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
                unavailable
            };
        }
        reportTargets = ready.map(item => item.target);
        klineSets = ready.map(item => item.rows);
        selection = { date: dateStr, reason: "" };
    } else {
        klineSets = await Promise.all(activeTargets.map(target => marketService.getDailyKline(target.symbol, 140)));
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
    return { skipped: false, reason: "", date: selection.date, reports, unavailable };
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
    loadTargets,
    prioritize,
    runDailyClose,
    selectReportDate
};
