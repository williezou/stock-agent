require("dotenv").config();
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { sendTelegram, sendTelegramPhoto } = require("./telegram");
const { createNewsService } = require("./news");
const { createLonghuService } = require("./longhu");
const { computeFeatures, pickByStyle, scoreByStyle, scoreByStyleRelaxed } = require("./scoring");
const { applyStockFilters } = require("./filters");
const { isAfterChinaClose, isTradingDay, nowChinaString, chinaDateString } = require("./calendar");
const { STYLE_ORDER, formatScanDelivery, formatScanSummary } = require("./format");
const { generateOverviewChart, generateStockChart } = require("./daily-chart");
const { buildTarget } = require("./stocks");
const { analyzeKlines, buildTradePlan } = require("./technical");
const { createMarketService } = require("./market");

const PROXY_URL =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;

const httpClient = (() => {
    if (!PROXY_URL) return axios.create({ timeout: 20000 });
    const masked = PROXY_URL.replace(/\/\/.*@/, "//****@");
    console.log(`🧭 使用代理: ${masked}`);
    const agent = new HttpsProxyAgent(PROXY_URL);
    return axios.create({
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: 20000
    });
})();

// =====================
// 配置
// =====================
const MIN_PREMARKET_VOLUME = 1000000;
const CONCURRENCY = 5;
const REQUEST_DELAY_MS = 120; // 轻微节流，避免触发限流
const EM_BASE_URL = "https://push2.eastmoney.com/api/qt/clist/get";
const NEWS_MIN_SCORE_THRESHOLD = 4; // 只有接近阈值的才拉新闻，减少请求量
const CANDIDATE_PER_STYLE = 20;
const DEBUG = process.env.DEBUG === "1";
const DRY_RUN = process.argv.includes("--dry-run");
const PICKS_PER_STYLE = 2; // 每类入选数量，对应一张总览图
const KLINE_DAYS = 140;

// =====================
// 获取A股列表（简化版）
// =====================
async function fetchStockList({ pn = 1, pz, fid, po }) {
    const params = {
        pn,
        pz,
        po,
        np: 1,
        fltt: 2,
        invt: 2,
        fid,
        // 沪深A股
        fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
        // 代码/名称/最新价/涨跌幅/涨跌额/成交量/昨收/上市日期
        fields: "f12,f14,f2,f3,f4,f5,f18,f26",
        _: Date.now()
    };
    const res = await requestWithRetry(
        () =>
            httpClient.get(EM_BASE_URL, {
                params,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Referer": "https://quote.eastmoney.com/"
                }
            }),
        5
    );
    const diff = (res.data && res.data.data && res.data.data.diff) || [];
    return diff.map(d => ({
        symbol: d.f12,
        name: d.f14,
        price: Number(d.f2) || 0,
        changePct: Number(d.f3) || 0,
        change: Number(d.f4) || 0,
        volume: Number(d.f5) || 0,
        prevClose: Number(d.f18) || 0,
        listingDate: d.f26 || ""
    }));
}

// 选股池按成交额排序取流动性最好的股票，避免只在当日涨幅榜里挑选导致各分类重叠
async function getStocks() {
    let list;
    try {
        list = await fetchStockList({ pz: 200, fid: "f6", po: 1 });
    } catch (e) {
        console.log("⚠️ 拉取股票池超时，尝试降低数量重试...");
        list = await fetchStockList({ pz: 100, fid: "f6", po: 1 });
    }
    return applyStockFilters(list);
}

// 涨跌幅两端的榜单，用于统计涨停/跌停与市场情绪
const MOVERS_PAGE_SIZE = 100;
const MOVERS_MAX_PAGES = 5;
const MIN_LIMIT_MOVE_PCT = 4.9; // 最小涨跌停幅度（ST ±5%），低于此值不可能再有涨跌停

// 按涨跌幅逐页拉取，直到越过涨跌停区间；翻到上限仍未越过时标记为触顶（计数只是下限）
async function getMoversSide(po) {
    const rows = [];
    for (let pn = 1; pn <= MOVERS_MAX_PAGES; pn++) {
        const page = await fetchStockList({ pn, pz: MOVERS_PAGE_SIZE, fid: "f3", po });
        rows.push(...page);
        const last = page.at(-1);
        if (page.length < MOVERS_PAGE_SIZE || !last || Math.abs(last.changePct) < MIN_LIMIT_MOVE_PCT) {
            return { rows, capped: false };
        }
        if (REQUEST_DELAY_MS > 0) await delay(REQUEST_DELAY_MS);
    }
    return { rows, capped: true };
}

async function getMovers() {
    const [gainers, losers] = await Promise.all([getMoversSide(1), getMoversSide(0)]);
    return { gainers, losers };
}

// =====================
// 简单并发池
// =====================
async function runPool(items, worker, concurrency) {
    const results = new Array(items.length);
    let index = 0;

    async function next() {
        while (true) {
            const i = index++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
    await Promise.all(workers);
    return results;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function maskSecrets(text) {
    if (!text) return text;
    let out = String(text);
    const secrets = [
        process.env.TELEGRAM_BOT_TOKEN,
        process.env.TELEGRAM_CHAT_ID
    ].filter(Boolean);
    for (const s of secrets) {
        if (s) out = out.split(s).join("****");
    }
    return out;
}

function formatError(e) {
    if (!e) return "";
    const msg = e.message || e.toString();
    return maskSecrets(msg);
}

async function requestWithRetry(fn, retries = 3) {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (e) {
            attempt++;
            if (attempt > retries) throw e;
            const backoff = 300 * attempt;
            await delay(backoff);
        }
    }
}

const newsService = createNewsService({
    httpClient,
    requestWithRetry,
    runPool,
    delay,
    DEBUG,
    formatError
});
const marketService = createMarketService({ httpClient, requestWithRetry });
const longhuService = createLonghuService({ httpClient, requestWithRetry, DEBUG });

// =====================
// 主流程
// =====================
async function runScanner() {
    console.log("🚀 开始扫描...");

    const trading = await isTradingDay({ httpClient, requestWithRetry, formatError });
    if (!trading.ok) {
        console.log(`🛑 非交易日（${trading.reason}）：${trading.dateStr}`);
        return {};
    }

    let stocks;
    try {
        stocks = await getStocks();
    } catch (e) {
        console.log("❌ 拉取A股列表失败:", e.code || formatError(e) || e);
        return {};
    }

    const baseResults = await runPool(stocks, async (stock, i) => {
        try {
            // 轻微错峰
            if (REQUEST_DELAY_MS > 0 && i > 0) {
                await delay(REQUEST_DELAY_MS);
            }

            const features = computeFeatures(stock);
            const baseScores = {
                intraday: scoreByStyle("intraday", features, [], []),
                short: scoreByStyle("short", features, [], []),
                swing: scoreByStyle("swing", features, [], []),
                mid: scoreByStyle("mid", features, [], [])
            };

            return {
                symbol: stock.symbol,
                name: stock.name,
                features,
                baseScores
            };

        } catch (err) {
            // 忽略单个错误
        }
        return null;
    }, CONCURRENCY);

    const filtered = baseResults.filter(Boolean);

    const styles = ["intraday", "short", "swing", "mid"];
    const candidates = new Map();
    for (const style of styles) {
        const top = [...filtered]
            .sort((a, b) => b.baseScores[style] - a.baseScores[style])
            .slice(0, CANDIDATE_PER_STYLE);
        for (const item of top) {
            candidates.set(item.symbol, item);
        }
    }

    const newsNowIndex = await newsService.buildNewsNowIndex([...candidates.values()]);

    const withNews = await runPool([...candidates.values()], async (item, i) => {
        try {
            if (REQUEST_DELAY_MS > 0 && i > 0) {
                await delay(REQUEST_DELAY_MS);
            }
            let news = [];
            let announcements = [];
            const needNews = Object.values(item.baseScores).some(s => s >= NEWS_MIN_SCORE_THRESHOLD);
            if (needNews) {
                [news, announcements] = await Promise.all([
                    newsService.getNews(item.symbol),
                    newsService.getAnnouncements(item.symbol)
                ]);
            }
            const extraNews = newsNowIndex.get(item.symbol) || [];
            news = newsService.mergeNewsLists(news, extraNews);
            return {
                ...item,
                news,
                announcements
            };
        } catch (e) {
            return { ...item, news: [], announcements: [] };
        }
    }, CONCURRENCY);

    const enrichedMap = new Map(withNews.map(x => [x.symbol, x]));

    const fullLists = {};
    const strictCounts = {};
    const relaxedCounts = {};
    console.log(`📊 股票池数量: ${filtered.length}`);

    function buildListWithScorer(style, scorer) {
        return filtered
            .map(item => {
                const enriched = enrichedMap.get(item.symbol) || item;
                const score = scorer(style, item.features, enriched.news || [], enriched.announcements || []);
                if (score === null) return null;
                return {
                    symbol: item.symbol,
                    name: item.name,
                    score,
                    gap: (item.features.gap * 100).toFixed(2) + "%",
                    volume: item.features.volume,
                    newsCount: (enriched.news || []).length,
                    annCount: (enriched.announcements || []).length,
                    news: (enriched.news || []).slice(0, 3),
                    announcements: (enriched.announcements || []).slice(0, 3)
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);
    }
    for (const style of styles) {
        let list = buildListWithScorer(style, scoreByStyle);
        strictCounts[style] = list.length;
        if (list.length === 0) {
            list = buildListWithScorer(style, scoreByStyleRelaxed);
            relaxedCounts[style] = list.length;
        } else {
            relaxedCounts[style] = 0;
        }
        fullLists[style] = list;
    }

    const picked = pickByStyle(fullLists, STYLE_ORDER, PICKS_PER_STYLE);
    for (const style of styles) {
        if (strictCounts[style] === 0 && relaxedCounts[style] > 0) {
            console.log(`\n⚠️ ${style} 严格条件为空，已启用放宽规则（数量: ${relaxedCounts[style]}）`);
        }
        if (picked[style].length === 0) {
            console.log(`\n⚠️ ${style} 严格/放宽条件均无可用标的（或已归入其他分类），本类留空`);
            continue;
        }
        console.log(`\n🔥 ${style} 入选：`);
        console.table(picked[style].map(({ news, announcements, ...rest }) => rest));
    }

    // 拉取日K生成技术分析与交易计划；盘中运行时剔除尚未收定的当日K线
    const today = chinaDateString();
    const settled = isAfterChinaClose();
    const pickedList = STYLE_ORDER.flatMap(style => picked[style].map(item => ({ style, item })));
    const analyzed = await runPool(pickedList, async ({ style, item }, i) => {
        if (REQUEST_DELAY_MS > 0 && i > 0) await delay(REQUEST_DELAY_MS);
        try {
            const raw = await marketService.getDailyKline(item.symbol, KLINE_DAYS);
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
        } catch (e) {
            console.log(`⚠️ ${item.symbol} 日K分析失败:`, formatError(e) || e);
            return { style, item, report: null };
        }
    }, CONCURRENCY);
    const picksByStyle = Object.fromEntries(STYLE_ORDER.map(style => [
        style,
        analyzed.filter(pick => pick.style === style).map(({ item, report }) => ({ item, report }))
    ]));

    // =====================
    // 获取龙虎榜数据
    // =====================
    let longhiData = {};
    try {
        const [boardList, movers] = await Promise.all([
            longhuService.getLonghiBoardList(),
            getMovers()
        ]);
        const [riseStocks, declineStocks] = await Promise.all([
            longhuService.getContinuousRiseStocks(movers.gainers.rows),
            longhuService.getContinuousDeclineStocks(movers.losers.rows)
        ]);
        longhiData = {
            boardList,
            riseStocks,
            declineStocks,
            riseCapped: movers.gainers.capped,
            declineCapped: movers.losers.capped
        };
        console.log(`\n🎯 龙虎榜上榜个股: ${boardList.length}`);
        console.log(`\n📈 涨停个股: ${riseStocks.length}${movers.gainers.capped ? "+" : ""}`);
        console.log(`\n📉 跌停个股: ${declineStocks.length}${movers.losers.capped ? "+" : ""}`);
    } catch (e) {
        console.log("⚠️ 龙虎榜数据获取失败:", formatError(e) || e);
    }

    const now = nowChinaString();
    const summary = formatScanSummary({ now, picksByStyle, longhiData });
    const delivery = formatScanDelivery({ picksByStyle, date: today });

    if (DRY_RUN) {
        console.log(`\n===== 扫描结论（${summary.length}字符）=====\n${summary}`);
        for (const item of delivery.overviews) {
            const png = generateOverviewChart(item.reports, today, item.title);
            console.log(`\n===== 总览图 ${item.filename}（${png.length} bytes）=====\n${item.caption}`);
        }
        for (const item of delivery.stocks) {
            const png = generateStockChart(item.report);
            console.log(`\n===== 个股图 ${item.filename}（${png.length} bytes）=====\n${item.caption}`);
        }
        return { picksByStyle, longhiData };
    }

    // 每条消息独立发送：单张图失败（限流、绘图异常）不影响其余内容
    let sent = 0;
    let failed = 0;
    async function sendStep(label, fn) {
        try {
            await fn();
            sent++;
        } catch (e) {
            failed++;
            console.log(`⚠️ ${label} 发送失败:`, formatError(e) || e);
        }
    }
    await sendStep("扫描结论", () => sendTelegram(summary));
    for (const item of delivery.overviews) {
        await delay(350);
        await sendStep(item.filename, () =>
            sendTelegramPhoto(generateOverviewChart(item.reports, today, item.title), item.caption, item.filename)
        );
    }
    for (const item of delivery.stocks) {
        await delay(350);
        await sendStep(item.filename, () =>
            sendTelegramPhoto(generateStockChart(item.report), item.caption, item.filename)
        );
    }
    console.log(`✅ 已发送${sent}条消息（结论、${delivery.overviews.length}张分类总览图、${delivery.stocks.length}张个股图），失败${failed}条`);
    if (failed) process.exitCode = 1;

    return { picksByStyle, longhiData };
}

runScanner().catch(e => {
    console.log("❌ 扫描失败:", formatError(e) || e);
    process.exitCode = 1;
});
