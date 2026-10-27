const { createRateLimiter, runPool } = require("../lib/async");
const { createHttpClient, formatError, requestWithRetry } = require("../lib/http");
const { createLonghuService } = require("../models/market/longhu");
const { createMarketService } = require("../models/market/market-data");
const { createNewsService } = require("../models/market/news");
const { createStockListService } = require("../models/market/stock-list");
const { chinaDateString, isAfterChinaClose, isTradingDay } = require("../models/market/trading-calendar");
const { buildTarget } = require("../models/stock");
const {
    STYLE_ORDER,
    applyStockFilters,
    computeFeatures,
    pickByStyle,
    scoreByStyle,
    scoreByStyleRelaxed
} = require("./screening");
const { analyzeKlines, buildTradePlan } = require("./technical-analysis");

// A股扫描：股票池 → 四种风格打分 → 补充新闻 → 去重选出每类入选 → 日K技术分析 → 涨跌停统计
const CONCURRENCY = 5;
const REQUEST_GAP_MS = 120; // 轻微节流，避免触发限流
const NEWS_MIN_SCORE_THRESHOLD = 4; // 只有接近阈值的才拉新闻，减少请求量
const CANDIDATE_PER_STYLE = 20;
const PICKS_PER_STYLE = 2; // 每类入选数量，对应一张总览图
const KLINE_DAYS = 140;
const NEWS_PER_STOCK = 3;

function createScanServices() {
    const httpClient = createHttpClient({ timeout: 20000 });
    return {
        httpClient,
        stockList: createStockListService({ httpClient, requestWithRetry }),
        news: createNewsService({ httpClient, requestWithRetry }),
        market: createMarketService({ httpClient, requestWithRetry }),
        longhu: createLonghuService({ httpClient, requestWithRetry })
    };
}

// 第一轮：只用行情快照打分（不含新闻），用于圈定需要拉新闻的候选
function scorePool(stocks) {
    return stocks.map(stock => {
        const features = computeFeatures(stock);
        const baseScores = Object.fromEntries(STYLE_ORDER.map(style => [style, scoreByStyle(style, features, [], [])]));
        return { symbol: stock.symbol, name: stock.name, features, baseScores };
    });
}

// 每种风格取前N名作为候选，拉取新闻与公告（新闻是打分中的催化剂加分项）
async function attachNews(services, scored) {
    const candidates = new Map();
    for (const style of STYLE_ORDER) {
        const top = [...scored]
            .sort((a, b) => b.baseScores[style] - a.baseScores[style])
            .slice(0, CANDIDATE_PER_STYLE);
        for (const item of top) candidates.set(item.symbol, item);
    }

    const newsNowIndex = await services.news.buildNewsNowIndex([...candidates.values()]);
    const waitTurn = createRateLimiter(REQUEST_GAP_MS);
    const withNews = await runPool([...candidates.values()], async item => {
        await waitTurn();
        try {
            let news = [];
            let announcements = [];
            const needNews = Object.values(item.baseScores).some(score => score >= NEWS_MIN_SCORE_THRESHOLD);
            if (needNews) {
                [news, announcements] = await Promise.all([
                    services.news.getNews(item.symbol),
                    services.news.getAnnouncements(item.symbol)
                ]);
            }
            news = services.news.mergeNewsLists(news, newsNowIndex.get(item.symbol) || []);
            return { ...item, news, announcements };
        } catch {
            return { ...item, news: [], announcements: [] };
        }
    }, CONCURRENCY);
    return new Map(withNews.map(item => [item.symbol, item]));
}

// 第二轮：带上新闻重新打分；严格条件无结果时启用放宽规则
function buildStyleLists(scored, enrichedMap) {
    function rank(style, scorer) {
        return scored
            .map(item => {
                const enriched = enrichedMap.get(item.symbol) || item;
                const news = enriched.news || [];
                const announcements = enriched.announcements || [];
                const score = scorer(style, item.features, news, announcements);
                if (score === null) return null;
                return {
                    symbol: item.symbol,
                    name: item.name,
                    score,
                    gap: (item.features.gap * 100).toFixed(2) + "%",
                    volume: item.features.volume,
                    newsCount: news.length,
                    annCount: announcements.length,
                    news: news.slice(0, NEWS_PER_STOCK),
                    announcements: announcements.slice(0, NEWS_PER_STOCK)
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);
    }

    const lists = {};
    for (const style of STYLE_ORDER) {
        lists[style] = rank(style, scoreByStyle);
        if (!lists[style].length) {
            lists[style] = rank(style, scoreByStyleRelaxed);
            if (lists[style].length) {
                console.log(`\n⚠️ ${style} 严格条件为空，已启用放宽规则（数量: ${lists[style].length}）`);
            }
        }
    }
    return lists;
}

function logPicks(picked) {
    for (const style of STYLE_ORDER) {
        if (!picked[style].length) {
            console.log(`\n⚠️ ${style} 严格/放宽条件均无可用标的（或已归入其他分类），本类留空`);
            continue;
        }
        console.log(`\n🔥 ${style} 入选：`);
        console.table(picked[style].map(({ news, announcements, ...rest }) => rest));
    }
}

// 为入选股票拉取日K生成技术分析与交易计划；盘中运行时剔除尚未收定的当日K线
async function analyzePicks(services, picked, today) {
    const settled = isAfterChinaClose();
    const pickedList = STYLE_ORDER.flatMap(style => picked[style].map(item => ({ style, item })));
    const waitTurn = createRateLimiter(REQUEST_GAP_MS);
    const analyzed = await runPool(pickedList, async ({ style, item }) => {
        await waitTurn();
        try {
            const raw = await services.market.getDailyKline(item.symbol, KLINE_DAYS);
            const klines = !settled && raw.at(-1)?.date === today ? raw.slice(0, -1) : raw;
            const analysis = analyzeKlines(klines);
            return {
                style,
                item,
                report: {
                    style,
                    meta: buildTarget(item.symbol, item.name),
                    klines,
                    analysis,
                    plan: buildTradePlan(analysis),
                    news: item.news,
                    announcements: item.announcements
                }
            };
        } catch (error) {
            console.log(`⚠️ ${item.symbol} 日K分析失败:`, formatError(error));
            return { style, item, report: null };
        }
    }, CONCURRENCY);
    return Object.fromEntries(STYLE_ORDER.map(style => [
        style,
        analyzed.filter(pick => pick.style === style).map(({ item, report }) => ({ item, report }))
    ]));
}

// 涨跌停统计；失败时返回空数据，不影响扫描结论。
// 龙虎榜要到收盘后傍晚才发布，扫描时尚未出炉，改由调度器单独推送
async function collectMarketHeat(services) {
    try {
        const movers = await services.stockList.getMovers();
        const [riseStocks, declineStocks] = await Promise.all([
            services.longhu.getContinuousRiseStocks(movers.gainers.rows),
            services.longhu.getContinuousDeclineStocks(movers.losers.rows)
        ]);
        console.log(`\n📈 涨停个股: ${riseStocks.length}${movers.gainers.capped ? "+" : ""}`);
        console.log(`\n📉 跌停个股: ${declineStocks.length}${movers.losers.capped ? "+" : ""}`);
        return {
            riseStocks,
            declineStocks,
            riseCapped: movers.gainers.capped,
            declineCapped: movers.losers.capped
        };
    } catch (error) {
        console.log("⚠️ 涨跌停数据获取失败:", formatError(error));
        return {};
    }
}

// 返回 { ok, reason, date, picksByStyle, longhiData }；非交易日或股票池获取失败时ok=false
async function runScan(services = createScanServices()) {
    console.log("🚀 开始扫描...");
    const trading = await isTradingDay({ httpClient: services.httpClient, requestWithRetry });
    if (!trading.ok) return { ok: false, reason: `非交易日（${trading.reason}）：${trading.dateStr}` };

    let stocks;
    try {
        stocks = applyStockFilters(await services.stockList.getLiquidPool());
    } catch (error) {
        return { ok: false, reason: `拉取A股列表失败: ${error.code || formatError(error)}` };
    }

    const scored = scorePool(stocks);
    const enrichedMap = await attachNews(services, scored);
    console.log(`📊 股票池数量: ${scored.length}`);
    const picked = pickByStyle(buildStyleLists(scored, enrichedMap), STYLE_ORDER, PICKS_PER_STYLE);
    logPicks(picked);

    const date = chinaDateString();
    const picksByStyle = await analyzePicks(services, picked, date);
    const longhiData = await collectMarketHeat(services);
    return { ok: true, reason: "", date, picksByStyle, longhiData };
}

module.exports = { runScan };
