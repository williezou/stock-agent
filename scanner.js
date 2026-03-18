require("dotenv").config();
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { sendTelegram } = require("./telegram");
const { createNewsService } = require("./news");
const { computeFeatures, scoreByStyle, scoreByStyleRelaxed } = require("./scoring");
const { applyStockFilters } = require("./filters");
const { isTradingDay, nowChinaString, chinaDateString } = require("./calendar");
const { formatTelegramMessage } = require("./format");
const { createMarketService } = require("./market");

const PROXY_URL =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;

const httpClient = (() => {
    if (!PROXY_URL) return axios.create({ timeout: 10000 });
    const masked = PROXY_URL.replace(/\/\/.*@/, "//****@");
    console.log(`🧭 使用代理: ${masked}`);
    const agent = new HttpsProxyAgent(PROXY_URL);
    return axios.create({
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: 10000
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
const MID_BREAKOUT_LOOKBACK = 55;
const MID_BREAKOUT_BUFFER = 0.005; // 0.5% 突破
const MID_MIN_VOL_RATIO = 1.3;

// =====================
// 获取A股列表（简化版）
// =====================
async function getStocks() {
    const params = {
        pn: 1,
        pz: 200,
        po: 1,
        np: 1,
        fltt: 2,
        invt: 2,
        fid: "f3",
        // 沪深A股
        fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
        // 代码/名称/最新价/涨跌幅/涨跌额/成交量/昨收/上市日期
        fields: "f12,f14,f2,f3,f4,f5,f18,f26",
        _: Date.now()
    };

    const res = await requestWithRetry(() =>
        httpClient.get(EM_BASE_URL, {
            params,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://quote.eastmoney.com/"
            }
        })
    );
    const diff = (res.data && res.data.data && res.data.data.diff) || [];

    const list = diff.map(d => ({
        symbol: d.f12,
        name: d.f14,
        price: Number(d.f2) || 0,
        changePct: Number(d.f3) || 0,
        change: Number(d.f4) || 0,
        volume: Number(d.f5) || 0,
        prevClose: Number(d.f18) || 0,
        listingDate: d.f26 || ""
    }));

    return applyStockFilters(list);
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

    const resultsByStyle = {};
    const fullLists = {};
    const strictCounts = {};
    const relaxedCounts = {};
    const fallbackCounts = {};
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

        if (list.length === 0) {
            // 最终兜底：按流动性选前5，保证不空
            list = filtered
                .slice()
                .sort((a, b) => b.features.volumeScore - a.features.volumeScore)
                .map(item => ({
                    symbol: item.symbol,
                    name: item.name,
                    score: item.features.volumeScore,
                    gap: (item.features.gap * 100).toFixed(2) + "%",
                    volume: item.features.volume,
                    newsCount: (enrichedMap.get(item.symbol)?.news || []).length,
                    annCount: (enrichedMap.get(item.symbol)?.announcements || []).length,
                    news: (enrichedMap.get(item.symbol)?.news || []).slice(0, 3),
                    announcements: (enrichedMap.get(item.symbol)?.announcements || []).slice(0, 3)
                }))
                .slice(0, 5);
            fallbackCounts[style] = list.length;
        } else {
            fallbackCounts[style] = 0;
        }

        fullLists[style] = list;
    }

    // 去重：同一股票只归入分数最高的风格
    const stylePriority = ["intraday", "short", "swing", "mid"];
    const bestStyleBySymbol = new Map();
    for (const style of styles) {
        for (const item of fullLists[style]) {
            const prev = bestStyleBySymbol.get(item.symbol);
            if (!prev || item.score > prev.score) {
                bestStyleBySymbol.set(item.symbol, { style, score: item.score });
            }
        }
    }

    const assigned = new Set();
    for (const style of stylePriority) {
        const list = fullLists[style] || [];
        const primary = list.filter(it => {
            const best = bestStyleBySymbol.get(it.symbol);
            return best && best.style === style;
        });
        const out = [];
        for (const it of primary) {
            if (out.length >= 5) break;
            if (assigned.has(it.symbol)) continue;
            out.push(it);
            assigned.add(it.symbol);
        }
        if (out.length < 5) {
            for (const it of list) {
                if (out.length >= 5) break;
                if (assigned.has(it.symbol)) continue;
                out.push(it);
                assigned.add(it.symbol);
            }
        }
        // 若去重后仍不足，允许少量重复补足
        if (out.length < 5) {
            for (const it of list) {
                if (out.length >= 5) break;
                if (out.includes(it)) continue;
                out.push(it);
            }
        }
        resultsByStyle[style] = out;
    }

    for (const style of styles) {
        if (strictCounts[style] === 0 && relaxedCounts[style] > 0) {
            console.log(`\n⚠️ ${style} 严格条件为空，已启用放宽规则（数量: ${relaxedCounts[style]}）`);
        }
        if (strictCounts[style] === 0 && relaxedCounts[style] === 0 && fallbackCounts[style] > 0) {
            console.log(`\n⚠️ ${style} 严格/放宽均为空，已启用流动性兜底（数量: ${fallbackCounts[style]}）`);
        }
        console.log(`\n🔥 ${style} Top 5：`);
        console.table(resultsByStyle[style]);
    }

    // 中线买点：突破型
    if (resultsByStyle.mid && resultsByStyle.mid.length > 0) {
        const midWithBuy = await runPool(resultsByStyle.mid, async (item, i) => {
            try {
                if (REQUEST_DELAY_MS > 0 && i > 0) {
                    await delay(REQUEST_DELAY_MS);
                }
                const klines = await marketService.getDailyKline(item.symbol, MID_BREAKOUT_LOOKBACK + 5);
                if (!klines || klines.length < MID_BREAKOUT_LOOKBACK) return item;

                const last = klines[klines.length - 1];
                const today = chinaDateString();
                const hist = last.date === today ? klines.slice(0, -1) : klines;
                const recent = hist.slice(-MID_BREAKOUT_LOOKBACK);
                if (recent.length === 0) return item;

                const maxHigh = Math.max(...recent.map(k => k.high));
                const avgVol = recent.reduce((s, k) => s + k.volume, 0) / recent.length;
                const entry = maxHigh * (1 + MID_BREAKOUT_BUFFER);
                const volRatio = avgVol > 0 ? item.volume / avgVol : 0;
                const stop = Math.max(
                    Math.min(...recent.map(k => k.low)),
                    entry * 0.94
                );
                const trigger = item.price >= entry && volRatio >= MID_MIN_VOL_RATIO;
                if (!trigger) return { ...item, buy: null };

                return {
                    ...item,
                    buy: {
                        entry,
                        stop,
                        volRatio
                    }
                };
            } catch {
                return item;
            }
        }, Math.min(CONCURRENCY, resultsByStyle.mid.length));

        resultsByStyle.mid = midWithBuy;
    }

    const now = nowChinaString();
    const msg = formatTelegramMessage({ resultsByStyle, now, newsService });

    try {
        await sendTelegram(msg);
    } catch (e) {
        console.log("⚠️ Telegram 发送失败:", formatError(e) || e);
    }

    return resultsByStyle;
}

runScanner();
