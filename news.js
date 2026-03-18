const EM_NEWS_URL = "https://so.eastmoney.com/news/s";
const EM_F10_NEWS_URL = "https://emweb.securities.eastmoney.com/PC_HSF10/CompanyNewsAjax";
const EM_F10_NOTICE_URL = "https://emweb.securities.eastmoney.com/PC_HSF10/CompanyNoticeAjax";
const EM_DC_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";

const NEWSNOW_BASE_URL = process.env.NEWSNOW_BASE_URL || "https://newsnow.busiyi.world";
const NEWSNOW_SOURCES = [
    "wallstreetcn-quick",
    "wallstreetcn-news",
    "wallstreetcn-hot",
    "cls-telegraph",
    "cls-hot",
    "xueqiu-hotstock",
    "jin10",
    "gelonghui",
    "fastbull-express"
];

const NEWSNOW_SOURCE_LABELS = {
    "wallstreetcn-quick": "华尔街见闻-快讯",
    "wallstreetcn-news": "华尔街见闻-新闻",
    "wallstreetcn-hot": "华尔街见闻-热门",
    "cls-telegraph": "财联社-电报",
    "cls-hot": "财联社-热门",
    "xueqiu-hotstock": "雪球-热门",
    "jin10": "金十数据",
    "gelonghui": "格隆汇",
    "fastbull-express": "FastBull"
};

function decodeHtml(text) {
    return String(text || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'");
}

function toEmCode(symbol) {
    if (!symbol) return "";
    const s = symbol.toString().trim();
    if (s.startsWith("SH") || s.startsWith("SZ") || s.startsWith("BJ")) return s.toUpperCase();
    const first = s[0];
    if (first === "6") return `SH${s}`;
    if (first === "0" || first === "2" || first === "3") return `SZ${s}`;
    if (first === "8" || first === "4") return `BJ${s}`;
    return s.toUpperCase();
}

function findFirstArray(obj, depth = 3) {
    if (depth < 0 || !obj) return null;
    if (Array.isArray(obj) && obj.length > 0) return obj;
    if (typeof obj !== "object") return null;
    for (const key of Object.keys(obj)) {
        const val = obj[key];
        const found = findFirstArray(val, depth - 1);
        if (found) return found;
    }
    return null;
}

function pickFirst(obj, keys) {
    for (const k of keys) {
        if (obj && obj[k]) return obj[k];
    }
    return "";
}

function normalizeNewsItem(item) {
    const title = pickFirst(item, [
        "TITLE",
        "Title",
        "title",
        "NEWS_TITLE",
        "NoticeTitle",
        "INFO_TITLE",
        "INFOTITLE"
    ]);
    const time = pickFirst(item, [
        "DATE",
        "PUBLISH_DATE",
        "PUBLISHDATE",
        "NOTICE_DATE",
        "DATETIME",
        "RELEASETIME",
        "time",
        "Time"
    ]);
    const url = pickFirst(item, ["URL", "Url", "url", "LINK", "link", "SOURCEURL"]);
    const source = pickFirst(item, [
        "SOURCE",
        "source",
        "SOURCE_NAME",
        "SOURCENAME",
        "MEDIA",
        "media",
        "ORIGIN",
        "origin"
    ]);
    const content = pickFirst(item, [
        "CONTENT",
        "CONTENT_TEXT",
        "SUMMARY",
        "SUMMARY_TEXT",
        "ABSTRACT",
        "BRIEF",
        "DESC",
        "DESCRIPTION",
        "content",
        "summary",
        "description",
        "digest"
    ]);
    return {
        title: title || "",
        time: time ? time.toString().slice(0, 19) : "",
        url: url || "",
        content: content || "",
        source: source || ""
    };
}

function normalizeNoticeItem(item) {
    const title = pickFirst(item, [
        "TITLE",
        "Title",
        "title",
        "NOTICE_TITLE",
        "ANNOUNCEMENT_TITLE",
        "INFO_TITLE",
        "INFOTITLE"
    ]);
    const date = pickFirst(item, [
        "DATE",
        "NOTICE_DATE",
        "PUBLISH_DATE",
        "PUBLISHDATE",
        "ANNOUNCE_DATE"
    ]);
    const url = pickFirst(item, ["URL", "Url", "url", "LINK", "link", "SOURCEURL"]);
    return {
        title: title || "",
        date: date ? date.toString().slice(0, 10) : "",
        url: url || ""
    };
}

function sourceFromUrl(url) {
    if (!url) return "";
    try {
        const u = new URL(url);
        return u.hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

function mergeNewsLists(a, b) {
    const out = [];
    const seen = new Set();
    for (const item of [...a, ...b]) {
        const key = `${item.url || ""}::${item.title || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function createNewsService({ httpClient, requestWithRetry, runPool, delay, DEBUG, formatError }) {
    async function fetchNewsNowSource(id) {
        const res = await requestWithRetry(() =>
            httpClient.get(`${NEWSNOW_BASE_URL}/api/s`, {
                params: { id },
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Referer": NEWSNOW_BASE_URL
                }
            })
        );
        const data = res.data || {};
        const items = Array.isArray(data.items) ? data.items : [];
        return items.map(it => ({
            title: it.title || "",
            time: (it.pubDate || it.time || "").toString().slice(0, 19),
            url: it.url || "",
            content: it.content || it.summary || it.desc || it.description || "",
            source: NEWSNOW_SOURCE_LABELS[id] || id
        }));
    }

    async function buildNewsNowIndex(candidates) {
        if (!NEWSNOW_BASE_URL) return new Map();
        const symbolSet = new Set(candidates.map(c => c.symbol));
        const nameMap = new Map(candidates.map(c => [c.symbol, c.name || ""]));

        const perSource = await runPool(NEWSNOW_SOURCES, async (source, i) => {
            if (delay && i > 0) {
                await delay(120);
            }
            try {
                return await fetchNewsNowSource(source);
            } catch (e) {
                if (DEBUG) {
                    console.log("🧪 NewsNow source failed:", source, formatError(e));
                }
                return [];
            }
        }, Math.min(NEWSNOW_SOURCES.length, 5));

        const allItems = perSource.flat();
        const index = new Map();

        for (const item of allItems) {
            const title = item.title || "";
            if (!title) continue;

            const codes = title.match(/(?<!\d)\d{6}(?!\d)/g) || [];
            const matched = new Set();
            for (const code of codes) {
                if (symbolSet.has(code)) matched.add(code);
            }

            if (matched.size === 0) {
                for (const sym of symbolSet) {
                    const name = nameMap.get(sym);
                    if (name && title.includes(name)) {
                        matched.add(sym);
                    }
                }
            }

            for (const sym of matched) {
                if (!index.has(sym)) index.set(sym, []);
                const list = index.get(sym);
                if (list.length < 5) list.push(item);
            }
        }

        return index;
    }

    async function getNews(symbol) {
        const emCode = toEmCode(symbol);

        // ① 优先走 F10 JSON 接口
        try {
            const fetchF10 = async code =>
                requestWithRetry(() =>
                    httpClient.get(EM_F10_NEWS_URL, {
                        params: { code },
                        headers: {
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                            "Referer": "https://emweb.securities.eastmoney.com/"
                        }
                    })
                );

            const res = await fetchF10(emCode);
            const raw = res.data || {};
            if (DEBUG) {
                console.log("🧪 News F10 raw keys:", Object.keys(raw));
            }
            let list = raw.data || raw.result || raw.Result || [];
            if (!Array.isArray(list) || list.length === 0) {
                const res2 = await fetchF10(emCode.toLowerCase());
                const raw2 = res2.data || {};
                list = raw2.data || raw2.result || raw2.Result || [];
            }
            if (!Array.isArray(list) || list.length === 0) {
                list = findFirstArray(raw);
            }
            if (Array.isArray(list) && list.length > 0) {
                if (DEBUG) {
                    console.log("🧪 News F10 item keys:", Object.keys(list[0] || {}));
                }
                return list.slice(0, 5).map(normalizeNewsItem);
            }
        } catch (e) {
            // fallback
        }

        // ② 兜底：搜索页 HTML
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
        if (DEBUG) {
            console.log("🧪 News HTML length:", String(html).length);
        }
        const titleRegex = /<div class="news_item_t">\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g;
        const timeRegex = /<span class="news_item_time">([^<]+)<\/span>/g;
        const contentRegexList = [
            /<div class="news_item_c">([\s\S]*?)<\/div>/g,
            /<p class="news_item_des">([\s\S]*?)<\/p>/g
        ];

        const titles = [];
        const times = [];
        const contents = [];
        let m;

        while ((m = titleRegex.exec(html)) !== null) {
            const url = m[1];
            const title = decodeHtml(m[2].replace(/<[^>]+>/g, "").trim());
            titles.push({ title, url });
        }

        while ((m = timeRegex.exec(html)) !== null) {
            times.push(m[1].trim());
        }

        for (const rgx of contentRegexList) {
            while ((m = rgx.exec(html)) !== null) {
                const raw = m[1].replace(/<[^>]+>/g, "").trim();
                if (raw) contents.push(decodeHtml(raw));
            }
            if (contents.length) break;
        }

        const count = Math.min(titles.length, times.length);
        return titles.slice(0, count).map((t, i) => ({
            ...t,
            time: times[i],
            content: contents[i] || ""
        }));
    }

    async function getAnnouncements(symbol) {
        const emCode = toEmCode(symbol);

        // ① 优先走 F10 JSON 接口
        try {
            const fetchF10 = async code =>
                requestWithRetry(() =>
                    httpClient.get(EM_F10_NOTICE_URL, {
                        params: { code },
                        headers: {
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                            "Referer": "https://emweb.securities.eastmoney.com/"
                        }
                    })
                );

            const res = await fetchF10(emCode);
            const raw = res.data || {};
            if (DEBUG) {
                console.log("🧪 Notice F10 raw keys:", Object.keys(raw));
            }
            let list = raw.data || raw.result || raw.Result || [];
            if (!Array.isArray(list) || list.length === 0) {
                const res2 = await fetchF10(emCode.toLowerCase());
                const raw2 = res2.data || {};
                list = raw2.data || raw2.result || raw2.Result || [];
            }
            if (!Array.isArray(list) || list.length === 0) {
                list = findFirstArray(raw);
            }
            if (Array.isArray(list) && list.length > 0) {
                if (DEBUG) {
                    console.log("🧪 Notice F10 item keys:", Object.keys(list[0] || {}));
                }
                return list.slice(0, 5).map(normalizeNoticeItem);
            }
        } catch (e) {
            // fallback
        }

        // ② 兜底：数据中心公告
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

    return {
        getNews,
        getAnnouncements,
        buildNewsNowIndex,
        mergeNewsLists,
        sourceFromUrl
    };
}

module.exports = { createNewsService };
