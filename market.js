const KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get";

function toSecId(symbol) {
    const s = String(symbol || "");
    if (s.startsWith("6")) return `1.${s}`; // SH
    return `0.${s}`; // SZ
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

function createMarketService({ httpClient, requestWithRetry }) {
    async function getDailyKline(symbol, limit = 120) {
        const secid = toSecId(symbol);
        const res = await requestWithRetry(() =>
            httpClient.get(KLINE_URL, {
                params: {
                    fields1: "f1,f2,f3,f4,f5,f6",
                    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
                    klt: 101,
                    fqt: 1,
                    end: 20500101,
                    lmt: limit,
                    secid
                },
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Referer": "https://quote.eastmoney.com/"
                }
            })
        );
        return parseKlines(res.data || {});
    }

    async function getStockProfile(symbol) {
        const secid = toSecId(symbol);
        const res = await requestWithRetry(() =>
            httpClient.get(QUOTE_URL, {
                params: {
                    secid,
                    fields: "f57,f58"
                },
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Referer": "https://quote.eastmoney.com/"
                }
            })
        );
        const data = res.data && res.data.data;
        if (!data || !data.f57 || !data.f58) throw new Error(`无法识别股票代码${symbol}`);
        return { symbol: String(data.f57), name: String(data.f58) };
    }

    return { getDailyKline, getStockProfile };
}

module.exports = { createMarketService, toSecId };
