const KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get";
// 备用源一：同花顺前复权日K（含成交额、换手率；成交量单位为股）
const THS_BASE_URL = "https://d.10jqka.com.cn/v6/line";
// 备用源二：腾讯前复权日K（成交量单位为手，历史成交额/换手率缺失）
const TENCENT_KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const SOURCE_FAILURE_THRESHOLD = 2; // 某数据源连续失败达到次数后暂停访问，避免在封禁期间持续请求
const SOURCE_COOLDOWN_MS = 30 * 60 * 1000;

function toSecId(symbol) {
    const s = String(symbol || "");
    if (s.startsWith("6")) return `1.${s}`; // SH
    return `0.${s}`; // SZ
}

function toTencentCode(symbol) {
    const s = String(symbol || "");
    return `${s.startsWith("6") ? "sh" : "sz"}${s}`;
}

// 代码不存在、无日K等数据层面的“查无此股”，不代表数据源故障，不计入熔断
function notFound(message) {
    return Object.assign(new Error(message), { notFound: true });
}

function isNotFound(error) {
    return Boolean(error && (error.notFound || error.response?.status === 404));
}

// 由相邻两根K线的收盘价推算振幅、涨跌幅、涨跌额（备用源不直接提供这些字段）
function withPrevCloseFields(row, prevClose) {
    return {
        ...row,
        amp: prevClose ? ((row.high - row.low) / prevClose) * 100 : NaN,
        changePct: prevClose ? (row.close / prevClose - 1) * 100 : NaN,
        change: row.close - prevClose
    };
}

function parseJsonp(text) {
    const body = String(text || "");
    const start = body.indexOf("(");
    const end = body.lastIndexOf(")");
    if (start < 0 || end <= start) throw new Error("同花顺返回格式无法解析");
    return JSON.parse(body.slice(start + 1, end));
}

function formatDate(yyyymmdd) {
    const s = String(yyyymmdd || "");
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// 同花顺历史日K（last.js，截至上一交易日）+ 当日K（today.js）；成交量由股换算为手，与东方财富一致
function parseThsKlines(history, today, symbol) {
    const raw = String((history && history.data) || "")
        .split(";")
        .filter(Boolean)
        .map(line => {
            const [date, open, high, low, close, volume, amount, turnover] = line.split(",");
            return { date: formatDate(date), open, high, low, close, volume, amount, turnover };
        });
    const todayBar = today && today[`hs_${symbol}`];
    if (todayBar && todayBar["1"] && todayBar["11"]) {
        const date = formatDate(todayBar["1"]);
        if (!raw.length || date > raw.at(-1).date) {
            raw.push({
                date,
                open: todayBar["7"],
                high: todayBar["8"],
                low: todayBar["9"],
                close: todayBar["11"],
                volume: todayBar["13"],
                amount: todayBar["19"],
                turnover: todayBar["1968584"]
            });
        }
    }
    const klines = [];
    for (let i = 1; i < raw.length; i++) {
        const row = raw[i];
        klines.push(withPrevCloseFields({
            date: row.date,
            open: Number(row.open),
            close: Number(row.close),
            high: Number(row.high),
            low: Number(row.low),
            volume: Number(row.volume) / 100,
            amount: Number(row.amount),
            turnover: row.turnover === "" ? NaN : Number(row.turnover)
        }, Number(raw[i - 1].close)));
    }
    return klines;
}

// 腾讯日K只有OHLCV；涨跌幅由前一日收盘推算，历史成交额/换手率不可得（仅最新一日取自实时行情）
function parseTencentKlines(data, symbol) {
    const code = toTencentCode(symbol);
    const entry = data && data.data && data.data[code];
    const rows = (entry && (entry.qfqday || entry.day)) || [];
    const quote = entry && entry.qt && entry.qt[code];
    const klines = [];
    for (let i = 1; i < rows.length; i++) {
        const [date, open, close, high, low, volume] = rows[i];
        klines.push(withPrevCloseFields({
            date,
            open: Number(open),
            close: Number(close),
            high: Number(high),
            low: Number(low),
            volume: Number(volume),
            amount: NaN,
            turnover: NaN
        }, Number(rows[i - 1][2])));
    }
    const latest = klines.at(-1);
    // 实时行情：[30]时间戳yyyyMMddHHmmss、[37]成交额(万元)、[38]换手率(%)
    if (latest && Array.isArray(quote) && String(quote[30] || "").startsWith(latest.date.replace(/-/g, ""))) {
        latest.amount = Number(quote[37]) * 10000;
        latest.turnover = Number(quote[38]);
    }
    return klines;
}

function parseKlines(data) {
    const klines = (data && data.data && data.data.klines) || [];
    return klines.map(line => {
        const [
            date,
            open,
            close,
            high,
            low,
            volume,
            amount,
            amp,
            changePct,
            change,
            turnover
        ] = line.split(",");
        return {
            date,
            open: Number(open),
            close: Number(close),
            high: Number(high),
            low: Number(low),
            volume: Number(volume),
            amount: Number(amount),
            amp: Number(amp),
            changePct: Number(changePct),
            change: Number(change),
            turnover: Number(turnover)
        };
    });
}

const EASTMONEY_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://quote.eastmoney.com/"
};

function createMarketService({ httpClient, requestWithRetry, now = () => Date.now() }) {
    const health = { primaryFailures: 0, fallbackUsed: 0, fallbackFailures: 0, lastPrimaryError: "", sources: {} };
    const breakers = new Map();

    function breaker(name) {
        if (!breakers.has(name)) breakers.set(name, { consecutive: 0, pausedUntil: 0 });
        const state = breakers.get(name);
        // 冷却结束后重新计数，给数据源完整的恢复机会，而不是一次偶发失败就再次暂停
        if (state.pausedUntil && now() >= state.pausedUntil) {
            state.pausedUntil = 0;
            state.consecutive = 0;
        }
        return state;
    }

    function recordFailure(name, index, error) {
        const state = breaker(name);
        state.consecutive++;
        if (state.consecutive >= SOURCE_FAILURE_THRESHOLD) state.pausedUntil = now() + SOURCE_COOLDOWN_MS;
        if (index === 0) {
            health.primaryFailures++;
            health.lastPrimaryError = error.code || error.message || String(error);
        }
    }

    // 按顺序尝试各数据源：东方财富 → 同花顺 → 腾讯；连续失败的数据源进入冷却期，期间直接跳过
    async function withSources(sources) {
        let lastError;
        let notFoundError;
        for (const [index, { name, fetch }] of sources.entries()) {
            if (now() < breaker(name).pausedUntil) continue;
            try {
                const result = await fetch();
                breaker(name).consecutive = 0;
                if (index > 0) health.fallbackUsed++;
                health.sources[name] = (health.sources[name] || 0) + 1;
                return result;
            } catch (error) {
                if (isNotFound(error)) {
                    // 数据源正常响应但查无此股：不计入熔断，继续向下一个源确认
                    breaker(name).consecutive = 0;
                    notFoundError = notFoundError || error;
                    continue;
                }
                lastError = error;
                recordFailure(name, index, error);
            }
        }
        // 所有可用源都确认查无此股时按“代码无效”处理，不算数据源故障
        if (notFoundError && !lastError) throw notFoundError;
        health.fallbackFailures++;
        throw lastError || new Error("所有行情数据源均处于冷却期");
    }

    async function getEastmoneyKline(symbol, limit) {
        const res = await requestWithRetry(() =>
            httpClient.get(KLINE_URL, {
                params: {
                    fields1: "f1,f2,f3,f4,f5,f6",
                    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
                    klt: 101,
                    fqt: 1,
                    end: 20500101,
                    lmt: limit,
                    secid: toSecId(symbol)
                },
                headers: EASTMONEY_HEADERS
            })
        );
        const klines = parseKlines(res.data || {});
        if (!klines.length) throw notFound(`东方财富未返回${symbol}日K`);
        return klines;
    }

    async function fetchThs(symbol, file) {
        const res = await requestWithRetry(() =>
            httpClient.get(`${THS_BASE_URL}/hs_${symbol}/01/${file}`, {
                responseType: "text",
                transformResponse: [data => data],
                headers: {
                    "User-Agent": EASTMONEY_HEADERS["User-Agent"],
                    "Referer": "https://stockpage.10jqka.com.cn/"
                }
            })
        );
        return parseJsonp(res.data);
    }

    async function getThsKline(symbol, limit) {
        const [history, today] = await Promise.all([
            fetchThs(symbol, "last.js"),
            fetchThs(symbol, "today.js").catch(() => null)
        ]);
        const klines = parseThsKlines(history, today, symbol).slice(-limit);
        if (!klines.length) throw notFound(`同花顺未返回${symbol}日K`);
        return klines;
    }

    async function fetchTencent(symbol, limit) {
        const res = await requestWithRetry(() =>
            httpClient.get(TENCENT_KLINE_URL, {
                params: { param: `${toTencentCode(symbol)},day,,,${limit},qfq` },
                headers: { "User-Agent": EASTMONEY_HEADERS["User-Agent"] }
            })
        );
        return res.data || {};
    }

    async function getTencentKline(symbol, limit) {
        // 多取一根用于推算首日涨跌幅
        const klines = parseTencentKlines(await fetchTencent(symbol, limit + 1), symbol).slice(-limit);
        if (!klines.length) throw notFound(`腾讯未返回${symbol}日K`);
        return klines;
    }

    async function getDailyKline(symbol, limit = 120) {
        return withSources([
            { name: "东方财富", fetch: () => getEastmoneyKline(symbol, limit) },
            { name: "同花顺", fetch: () => getThsKline(symbol, limit) },
            { name: "腾讯", fetch: () => getTencentKline(symbol, limit) }
        ]);
    }

    async function getStockProfile(symbol) {
        return withSources([
            {
                name: "东方财富",
                fetch: async () => {
                    const res = await requestWithRetry(() =>
                        httpClient.get(QUOTE_URL, {
                            params: { secid: toSecId(symbol), fields: "f57,f58" },
                            headers: EASTMONEY_HEADERS
                        })
                    );
                    const data = res.data && res.data.data;
                    if (!data || !data.f57 || !data.f58) throw notFound(`无法识别股票代码${symbol}`);
                    return { symbol: String(data.f57), name: String(data.f58) };
                }
            },
            {
                name: "同花顺",
                fetch: async () => {
                    const history = await fetchThs(symbol, "last.js");
                    if (!history.name || !history.data) throw notFound(`无法识别股票代码${symbol}`);
                    return { symbol: String(symbol), name: String(history.name) };
                }
            },
            {
                name: "腾讯",
                fetch: async () => {
                    const code = toTencentCode(symbol);
                    const data = await fetchTencent(symbol, 1);
                    const quote = data.data && data.data[code] && data.data[code].qt && data.data[code].qt[code];
                    if (!Array.isArray(quote) || !quote[1] || !quote[2]) throw notFound(`无法识别股票代码${symbol}`);
                    return { symbol: String(quote[2]), name: String(quote[1]) };
                }
            }
        ]);
    }

    return { getDailyKline, getStockProfile, health: () => ({ ...health, sources: { ...health.sources } }) };
}

module.exports = { createMarketService, parseJsonp, parseTencentKlines, parseThsKlines, toSecId };
