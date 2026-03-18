require("dotenv").config();
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { sendTelegram } = require("./telegram");
const { createNewsService } = require("./news");

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
const GAP_THRESHOLD = 0.03;
const CONCURRENCY = 5;
const REQUEST_DELAY_MS = 120; // 轻微节流，避免触发限流
const EM_BASE_URL = "https://push2.eastmoney.com/api/qt/clist/get";
const HOLIDAY_API = "https://date.nager.at/api/v3/PublicHolidays";
const NEWS_MIN_SCORE_THRESHOLD = 4; // 只有接近阈值的才拉新闻，减少请求量
const CANDIDATE_PER_STYLE = 20;
const CN_TIMEZONE = "Asia/Shanghai";
const DEBUG = process.env.DEBUG === "1";
const NEWS_CONTENT_MAX_CHARS = 120;
const MID_MAX_CHANGE_PCT = 0.04; // 中线：更稳健，排除过度拉升（4%+）
const MID_MAX_VOL = 0.03; // 中线：最大波动
const NEW_STOCK_DAYS = 180; // 次新股排除窗口（天）
const INTRADAY_MIN_MOVE = 0.04; // 日内：高波动
const SHORT_MIN_RISE = 0.02; // 短线最小涨幅
const SHORT_MAX_RISE = 0.06; // 短线最大涨幅
const SWING_MIN_RISE = 0.0; // 波段最小涨幅
const SWING_MAX_RISE = 0.03; // 波段最大涨幅
const SWING_MAX_VOL = 0.05; // 波段最大波动

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

    const today = new Date();
    const cutoff = new Date(today.getTime() - NEW_STOCK_DAYS * 24 * 3600 * 1000);

    return list.filter(s => {
        const code = String(s.symbol || "");
        const name = String(s.name || "");

        // 排除：北交所
        if (code.startsWith("8") || code.startsWith("4")) return false;

        // 排除：科创板（688/689）
        if (code.startsWith("688") || code.startsWith("689")) return false;

        // 排除：ST / 退市
        if (name.includes("ST") || name.includes("退")) return false;

        // 排除：次新股（上市不足 NEW_STOCK_DAYS）
        if (s.listingDate) {
            const d = new Date(s.listingDate);
            if (!isNaN(d) && d > cutoff) return false;
        }

        return true;
    });
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

function getChinaToday() {
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: CN_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(now);
    const weekday = new Intl.DateTimeFormat("en-US", {
        timeZone: CN_TIMEZONE,
        weekday: "short"
    }).format(now);
    return { dateStr, weekday };
}

async function fetchChinaHolidays(year) {
    const res = await requestWithRetry(() =>
        httpClient.get(`${HOLIDAY_API}/${year}/CN`)
    );
    const list = Array.isArray(res.data) ? res.data : [];
    return new Set(list.map(item => item.date));
}

async function isTradingDay() {
    const { dateStr, weekday } = getChinaToday();
    if (weekday === "Sat" || weekday === "Sun") {
        return { ok: false, reason: "周末", dateStr };
    }
    try {
        const year = dateStr.slice(0, 4);
        const holidays = await fetchChinaHolidays(year);
        if (holidays.has(dateStr)) {
            return { ok: false, reason: "法定节假日", dateStr };
        }
    } catch (e) {
        console.log("⚠️ 节假日检查失败，将继续执行:", formatError(e));
    }
    return { ok: true, reason: "", dateStr };
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

function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function truncate(text, max) {
    if (!text) return "";
    const t = String(text).trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// =====================
// 打分逻辑
// =====================
function computeFeatures(stock) {
    const gap = stock.prevClose > 0 ? (stock.price - stock.prevClose) / stock.prevClose : 0;
    const changePct = (stock.changePct || 0) / 100;
    const volume = stock.volume || 0;
    const volumeScore = Math.log10(volume + 1); // 粗略流动性
    const volatility = Math.abs(changePct);
    const trendUp = stock.price > stock.prevClose;
    return { gap, changePct, volume, volumeScore, volatility, trendUp };
}

function scoreByStyle(style, features, news, announcements) {
    const hasCatalyst = (news && news.length > 0) || (announcements && announcements.length > 0);
    let score = 0;

    if (style === "intraday") {
        if (features.volatility < INTRADAY_MIN_MOVE) {
            return null;
        }
        // 日内：波动 + 量能 + 催化剂
        score += Math.min(features.volatility * 120, 6);
        score += Math.min(features.volumeScore, 4);
        if (Math.abs(features.gap) >= GAP_THRESHOLD) score += 2;
        if (hasCatalyst) score += 2;
    } else if (style === "short") {
        if (features.changePct < SHORT_MIN_RISE || features.changePct > SHORT_MAX_RISE) {
            return null;
        }
        // 短线：动量 + 量能 + 催化剂
        score += Math.min(Math.max(features.changePct, 0) * 120, 6);
        score += Math.min(features.volumeScore, 3);
        if (features.trendUp) score += 1;
        if (hasCatalyst) score += 2;
    } else if (style === "swing") {
        if (features.volatility > SWING_MAX_VOL || features.changePct < SWING_MIN_RISE || features.changePct > SWING_MAX_RISE) {
            return null;
        }
        // 波段：中等动量 + 量能
        score += Math.min(Math.max(features.changePct, 0) * 80, 4);
        score += Math.min(features.volumeScore, 3);
        if (hasCatalyst) score += 1;
    } else if (style === "mid") {
        // 中线：偏稳健，惩罚过大波动
        if (features.changePct > MID_MAX_CHANGE_PCT || features.volatility > MID_MAX_VOL) {
            return null; // 直接剔除
        }
        score += Math.min(Math.max(features.changePct, 0) * 30, 2.0);
        score += Math.min(features.volumeScore, 3.0);
        if (hasCatalyst) score += 1;
        if (features.changePct < -0.01) score -= 1.5;
    }

    return score;
}

// =====================
// 主流程
// =====================
async function runScanner() {
    console.log("🚀 开始扫描...");

    const trading = await isTradingDay();
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
    for (const style of styles) {
        let list = filtered.map(item => {
            const enriched = enrichedMap.get(item.symbol) || item;
            const score = scoreByStyle(style, item.features, enriched.news || [], enriched.announcements || []);
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
        }).filter(Boolean);
        list.sort((a, b) => b.score - a.score);
        if (style === "mid" && list.length === 0) {
            // 兜底：低涨幅 + 高流动性
            list = filtered
                .filter(item => item.features.changePct <= 0.03 && item.features.changePct >= -0.02)
                .map(item => {
                    const enriched = enrichedMap.get(item.symbol) || item;
                    return {
                        symbol: item.symbol,
                        name: item.name,
                        score: item.features.volumeScore,
                        gap: (item.features.gap * 100).toFixed(2) + "%",
                        volume: item.features.volume,
                        newsCount: (enriched.news || []).length,
                        annCount: (enriched.announcements || []).length,
                        news: (enriched.news || []).slice(0, 3),
                        announcements: (enriched.announcements || []).slice(0, 3)
                    };
                });
            list.sort((a, b) => b.score - a.score);
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
        resultsByStyle[style] = out;
    }

    for (const style of styles) {
        console.log(`\n🔥 ${style} Top 5：`);
        console.table(resultsByStyle[style]);
    }

    const now = new Date().toLocaleString("zh-CN", {
        timeZone: CN_TIMEZONE,
        hour12: false
    });

    const styleLabels = {
        intraday: "日内",
        short: "短线",
        swing: "波段",
        mid: "中线"
    };

    const sections = [];
    for (const style of styles) {
        const top5 = resultsByStyle[style];
        const symbolLine = top5.length
            ? `代码: <code>${top5.map(r => r.symbol).join(" ")}</code>`
            : "";
        const lines = top5.map((r, i) =>
            `${i + 1}. <code>${r.symbol}</code> ${r.name || ""} | 分数:${r.score.toFixed(2)} | 涨幅:${r.gap} | 量:${r.volume} | 新闻:${r.newsCount || 0} | 公告:${r.annCount || 0}`
        );
        const newsLines = top5.flatMap(r => {
            if (!r.news || r.news.length === 0) return [];
            const head = `${r.symbol} ${r.name || ""} 新闻:`;
            const items = r.news.map(n => {
                const title = escapeHtml(n.title || "");
                const url = n.url || "";
                const content = truncate(n.content || "", NEWS_CONTENT_MAX_CHARS);
                const contentText = content ? `（${escapeHtml(content)}）` : "（无摘要）";
                const source = escapeHtml(n.source || newsService.sourceFromUrl(url) || "来源未知");
                const prefix = `［${source}］`;
                return url ? `- ${prefix} <a href="${url}">${title}</a> ${contentText}` : `- ${prefix} ${title} ${contentText}`;
            });
            return [head, ...items];
        });
        const annLines = top5.flatMap(r => {
            if (!r.announcements || r.announcements.length === 0) return [];
            const head = `${r.symbol} ${r.name || ""} 公告:`;
            const items = r.announcements.map(a => {
                const title = (a.title || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                const url = a.url || "";
                return url ? `- <a href="${url}">${title}</a>` : `- ${title}`;
            });
            return [head, ...items];
        });

        const block =
            `<b>${styleLabels[style]} Top5</b>\n` +
            (lines.length ? lines.join("\n") : "无符合条件标的") +
            (symbolLine ? `\n${symbolLine}` : "") +
            (newsLines.length ? `\n<b>新闻详情</b>\n${newsLines.join("\n")}` : "") +
            (annLines.length ? `\n<b>公告详情</b>\n${annLines.join("\n")}` : "");
        sections.push(block);
    }

    const msg =
        `<b>A股扫描</b>\n` +
        `${now}\n\n` +
        sections.join("\n\n");

    try {
        await sendTelegram(msg);
    } catch (e) {
        console.log("⚠️ Telegram 发送失败:", formatError(e) || e);
    }

    return resultsByStyle;
}

runScanner();
