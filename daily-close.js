require("dotenv").config();

const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { getChinaClock, isAfterChinaClose } = require("./calendar");
const { generateOverviewChart, generateStockChart } = require("./daily-chart");
const { formatDailyCloseDelivery } = require("./daily-format");
const { createMarketService } = require("./market");
const { createNewsService } = require("./news");
const { sendTelegramPhoto } = require("./telegram");
const { analyzeKlines, buildTradePlan } = require("./technical");

const TARGETS = [
    {
        symbol: "600887",
        name: "伊利股份",
        exchangeCode: "600887.SH",
        quoteUrl: "https://quote.eastmoney.com/sh600887.html",
        keywords: ["三季报", "季报", "回购", "资产减值", "利润", "公告"]
    },
    {
        symbol: "002380",
        name: "科远智慧",
        exchangeCode: "002380.SZ",
        quoteUrl: "https://quote.eastmoney.com/sz002380.html",
        keywords: ["工业AI", "人工智能", "机器人", "三季报", "季报", "订单", "公告"]
    }
];

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

async function buildReports({ dryRun = false, now = new Date() } = {}) {
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

    const klineSets = await Promise.all(TARGETS.map(target => marketService.getDailyKline(target.symbol, 140)));
    const selection = selectReportDate(klineSets, { dryRun, now });
    if (!selection.date) return { skipped: true, reason: selection.reason, date: null, reports: [] };

    const contextItems = await getContextItems(newsService, TARGETS);
    const reports = TARGETS.map((meta, index) => {
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
    return { skipped: false, reason: "", date: selection.date, reports };
}

async function runDailyClose({ dryRun = process.argv.includes("--dry-run") } = {}) {
    console.log(`📈 开始生成伊利股份与科远智慧收盘分析${dryRun ? "（试运行）" : ""}...`);
    const result = await buildReports({ dryRun });
    if (result.skipped) {
        console.log(`🛑 本次不推送：${result.reason}`);
        return result;
    }

    const delivery = formatDailyCloseDelivery(result);
    if (dryRun) {
        const overviewChart = generateOverviewChart(result.reports, result.date);
        console.log(`\n===== Telegram 总览图（${overviewChart.length} bytes）=====\n${delivery.overviewCaption}`);
        delivery.stocks.forEach((item, index) => {
            const chart = generateStockChart(item.report);
            console.log(`\n===== Telegram 图表 ${index + 1}/${delivery.stocks.length}（${chart.length} bytes）=====\n${item.caption}`);
        });
        return { ...result, delivery };
    }

    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        throw new Error("缺少TELEGRAM_BOT_TOKEN或TELEGRAM_CHAT_ID，未发送任何消息");
    }
    await sendTelegramPhoto(
        generateOverviewChart(result.reports, result.date),
        delivery.overviewCaption,
        `overview-${result.date}.png`
    );
    for (const item of delivery.stocks) {
        await delay(350);
        await sendTelegramPhoto(generateStockChart(item.report), item.caption, item.filename);
    }
    console.log(`✅ 已向Telegram发送1张总览图和${delivery.stocks.length}张${result.date}个股图表`);
    return { ...result, delivery };
}

if (require.main === module) {
    runDailyClose().catch(error => {
        console.error(`❌ 每日收盘任务失败：${formatError(error)}`);
        process.exitCode = 1;
    });
}

module.exports = {
    TARGETS,
    buildReports,
    commonLatestDate,
    prioritize,
    runDailyClose,
    selectReportDate
};
