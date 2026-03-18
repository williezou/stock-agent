require("dotenv").config();
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { sendTelegram } = require("./telegram");

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
const EM_NEWS_URL = "https://so.eastmoney.com/news/s";
const EM_DC_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const NEWS_MIN_SCORE_THRESHOLD = 4; // 只有接近阈值的才拉新闻，减少请求量
const CANDIDATE_PER_STYLE = 20;

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
        // 代码/名称/最新价/涨跌幅/涨跌额/成交量/昨收
        fields: "f12,f14,f2,f3,f4,f5,f18",
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

    return diff.map(d => ({
        symbol: d.f12,
        name: d.f14,
        price: Number(d.f2) || 0,
        changePct: Number(d.f3) || 0,
        change: Number(d.f4) || 0,
        volume: Number(d.f5) || 0,
        prevClose: Number(d.f18) || 0
    }));
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

function decodeHtml(text) {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'");
}

// =====================
// 获取新闻（东方财富搜索）
// =====================
async function getNews(symbol) {
    const res = await requestWithRetry(() =>
        httpClient.get(EM_NEWS_URL, {
            params: { keyword: symbol },
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://so.eastmoney.com/"
            }
        })
    );

    const html = res.data || "";
    const titleRegex = /<div class="news_item_t">\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g;
    const timeRegex = /<span class="news_item_time">([^<]+)<\/span>/g;

    const titles = [];
    const times = [];
    let m;

    while ((m = titleRegex.exec(html)) !== null) {
        const url = m[1];
        const title = decodeHtml(m[2].replace(/<[^>]+>/g, "").trim());
        titles.push({ title, url });
    }

    while ((m = timeRegex.exec(html)) !== null) {
        times.push(m[1].trim());
    }

    const count = Math.min(titles.length, times.length);
    return titles.slice(0, count).map((t, i) => ({
        ...t,
        time: times[i]
    }));
}

// =====================
// 获取公告（东方财富数据中心）
// =====================
async function getAnnouncements(symbol) {
    const res = await requestWithRetry(() =>
        httpClient.get(EM_DC_URL, {
            params: {
                reportName: "RPT_PUBLIC_ANNOUNCEMENT",
                columns: "ALL",
                filter: `(SECURITY_CODE="${symbol}")`,
                pageNumber: 1,
                pageSize: 5,
                sortColumns: "NOTICE_DATE",
                sortTypes: "-1",
                source: "WEB",
                client: "WEB"
            },
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://data.eastmoney.com/"
            }
        })
    );

    const data = (res.data && res.data.result && res.data.result.data) || [];
    return data.map(item => {
        const title =
            item.TITLE ||
            item.ANNOUNCEMENT_TITLE ||
            item.NOTICE_TITLE ||
            "";
        const date = (item.NOTICE_DATE || item.PUBLISH_DATE || item.ANNOUNCE_DATE || "")
            .toString()
            .slice(0, 10);
        const infoCode = item.INFOCODE || item.ART_CODE || item.NOTICE_ID || "";
        const url = infoCode
            ? `https://data.eastmoney.com/notices/detail/${symbol}/${infoCode}.html`
            : "";

        return { title, date, url };
    });
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
        // 日内：波动 + 量能 + 催化剂
        score += Math.min(features.volatility * 120, 6);
        score += Math.min(features.volumeScore, 4);
        if (Math.abs(features.gap) >= GAP_THRESHOLD) score += 2;
        if (hasCatalyst) score += 2;
    } else if (style === "short") {
        // 短线：动量 + 量能 + 催化剂
        score += Math.min(Math.max(features.changePct, 0) * 120, 6);
        score += Math.min(features.volumeScore, 3);
        if (features.trendUp) score += 1;
        if (hasCatalyst) score += 2;
    } else if (style === "swing") {
        // 波段：中等动量 + 量能
        score += Math.min(Math.max(features.changePct, 0) * 80, 4);
        score += Math.min(features.volumeScore, 3);
        if (hasCatalyst) score += 1;
    } else if (style === "mid") {
        // 中线：偏稳健，惩罚过大波动
        score += Math.min(Math.max(features.changePct, 0) * 50, 3);
        score += Math.min(features.volumeScore, 2);
        if (hasCatalyst) score += 1;
        if (features.volatility > 0.08) score -= 1; // 过度波动扣分
    }

    return score;
}

// =====================
// 主流程
// =====================
async function runScanner() {
    console.log("🚀 开始扫描...");

    let stocks;
    try {
        stocks = await getStocks();
    } catch (e) {
        console.log("❌ 拉取A股列表失败:", e.code || e.message || e);
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
                    getNews(item.symbol),
                    getAnnouncements(item.symbol)
                ]);
            }
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
    for (const style of styles) {
        const list = filtered.map(item => {
            const enriched = enrichedMap.get(item.symbol) || item;
            const score = scoreByStyle(style, item.features, enriched.news || [], enriched.announcements || []);
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
        });
        list.sort((a, b) => b.score - a.score);
        resultsByStyle[style] = list.slice(0, 5);
    }

    for (const style of styles) {
        console.log(`\n🔥 ${style} Top 5：`);
        console.table(resultsByStyle[style]);
    }

    const now = new Date().toLocaleString("zh-CN", { hour12: false });

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
                const title = (n.title || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                const url = n.url || "";
                return url ? `- <a href="${url}">${title}</a>` : `- ${title}`;
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
        console.log("⚠️ Telegram 发送失败:", e.message || e);
    }

    return resultsByStyle;
}

runScanner();
