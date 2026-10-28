const { config } = require("../../../config");
const { BROWSER_USER_AGENT, notFound, withPrevCloseFields } = require("./common");

// 备用源二：腾讯前复权日K（成交量单位为手；历史成交额/换手率缺失，仅最新一日取自实时行情）
const KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
// web.ifzq.gtimg.cn 没有IPv6；proxy.finance.qq.com 是同一接口的IPv6可达入口，返回内容一致
const KLINE_URL_IPV6 = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get";

function toTencentCode(symbol) {
    return `${String(symbol || "").startsWith("6") ? "sh" : "sz"}${symbol}`;
}

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

function createTencentSource({ httpClient, requestWithRetry }) {
    async function fetchKlineData(symbol, limit) {
        const res = await requestWithRetry(() =>
            httpClient.get(config.ipv6Only ? KLINE_URL_IPV6 : KLINE_URL, {
                params: { param: `${toTencentCode(symbol)},day,,,${limit},qfq` },
                headers: { "User-Agent": BROWSER_USER_AGENT }
            })
        );
        return res.data || {};
    }

    async function getDailyKline(symbol, limit) {
        // 多取一根用于推算首日涨跌幅
        const klines = parseTencentKlines(await fetchKlineData(symbol, limit + 1), symbol).slice(-limit);
        if (!klines.length) throw notFound(`腾讯未返回${symbol}日K`);
        return klines;
    }

    async function getStockProfile(symbol) {
        const code = toTencentCode(symbol);
        const data = await fetchKlineData(symbol, 1);
        const quote = data.data && data.data[code] && data.data[code].qt && data.data[code].qt[code];
        if (!Array.isArray(quote) || !quote[1] || !quote[2]) throw notFound(`无法识别股票代码${symbol}`);
        return { symbol: String(quote[2]), name: String(quote[1]) };
    }

    return { name: "腾讯", getDailyKline, getStockProfile };
}

module.exports = { createTencentSource, parseTencentKlines };
