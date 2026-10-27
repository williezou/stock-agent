const { config } = require("../config");
const { createRateLimiter, runPool } = require("../lib/async");
const { createHttpClient, formatError, requestWithRetry } = require("../lib/http");
const { createMarketService, healthDelta } = require("../models/market/market-data");
const { createNewsService } = require("../models/market/news");
const { getChinaClock, isAfterChinaClose } = require("../models/market/trading-calendar");
const { DEFAULT_TARGETS } = require("../models/stock");
const { createStore } = require("../models/store");
const { analyzeKlines, buildTradePlan } = require("./technical-analysis");

// 每日收盘报告：拉取自选股日K → 技术分析与交易计划 → 附上新闻公告
const KLINE_DAYS = 140;
const KLINE_CONCURRENCY = 3;
const KLINE_REQUEST_GAP_MS = 200;
const NEWS_CONCURRENCY = 2;

// 行情服务在进程内复用，数据源熔断冷却才能跨调度轮次生效（否则每轮都会重新冲击已封禁的接口）
let sharedServices;
function getSharedServices() {
    if (!sharedServices) {
        const httpClient = createHttpClient();
        sharedServices = {
            marketService: createMarketService({ httpClient, requestWithRetry }),
            newsService: createNewsService({ httpClient, requestWithRetry })
        };
    }
    return sharedServices;
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

// 正式运行只用北京时间收盘后当日的完整日K；试运行回退到所有股票共有的最近完成日
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

// 过滤无意义短标题，并让命中关键词多的新闻排在前面
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
    }, NEWS_CONCURRENCY);
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

// 单用户脚本的股票来源：配置了数据库时读取管理员的自选股，否则使用默认股票
async function loadAdminTargets() {
    if (!config.databaseUrl) return DEFAULT_TARGETS;
    if (!config.telegram.adminChatId) throw new Error("使用数据库自选股时必须配置TELEGRAM_CHAT_ID");
    const store = createStore();
    try {
        await store.initialize();
        await store.seed(config.telegram.adminChatId, DEFAULT_TARGETS);
        return await store.list(config.telegram.adminChatId);
    } finally {
        await store.close();
    }
}

// allowPartial：多用户调度使用，部分股票日K未就绪时仍为其余股票生成报告，并在unavailable中列出缺失项
async function buildReports({ dryRun = false, now = new Date(), targets, allowPartial = false, klineCache } = {}) {
    const { marketService, newsService } = getSharedServices();
    const healthBefore = marketService.health();
    const dataHealth = () => healthDelta(healthBefore, marketService.health());

    const activeTargets = targets || await loadAdminTargets();
    if (!activeTargets.length) {
        return { skipped: true, reason: "自选股列表为空", date: null, reports: [] };
    }
    let reportTargets = activeTargets;
    const unavailable = [];
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

module.exports = {
    buildReports,
    commonLatestDate,
    fetchKlineSets,
    prioritize,
    selectReportDate
};
