const { BROWSER_USER_AGENT, notFound } = require("./common");

// 主数据源：东方财富前复权日K（fqt=1），字段完整；成交量单位为手
const KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get";
const HEADERS = {
    "User-Agent": BROWSER_USER_AGENT,
    "Referer": "https://quote.eastmoney.com/"
};

function toSecId(symbol) {
    return String(symbol || "").startsWith("6") ? `1.${symbol}` : `0.${symbol}`;
}

function parseKlines(data) {
    const klines = (data && data.data && data.data.klines) || [];
    return klines.map(line => {
        const [date, open, close, high, low, volume, amount, amp, changePct, change, turnover] = line.split(",");
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

function createEastmoneySource({ httpClient, requestWithRetry }) {
    async function getDailyKline(symbol, limit) {
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
                headers: HEADERS
            })
        );
        const klines = parseKlines(res.data || {});
        if (!klines.length) throw notFound(`东方财富未返回${symbol}日K`);
        return klines;
    }

    async function getStockProfile(symbol) {
        const res = await requestWithRetry(() =>
            httpClient.get(QUOTE_URL, {
                params: { secid: toSecId(symbol), fields: "f57,f58" },
                headers: HEADERS
            })
        );
        const data = res.data && res.data.data;
        if (!data || !data.f57 || !data.f58) throw notFound(`无法识别股票代码${symbol}`);
        return { symbol: String(data.f57), name: String(data.f58) };
    }

    return { name: "东方财富", getDailyKline, getStockProfile };
}

module.exports = { HEADERS, createEastmoneySource, parseKlines, toSecId };
