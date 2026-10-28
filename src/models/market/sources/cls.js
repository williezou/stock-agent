const { BROWSER_USER_AGENT, notFound } = require("./common");

// 备用源：财联社前复权日K（type=fd1，与东方财富、腾讯的前复权价格一致），有IPv6；
// 字段完整，含成交额与换手率，成交量单位为股，换算为手。北交所股票不支持，返回空数据时按查无此股交给下一个数据源
const BASE_URL = "https://x-quote.cls.cn/quote/stock";
const HEADERS = { "User-Agent": BROWSER_USER_AGENT, "Referer": "https://www.cls.cn/" };

function toClsCode(symbol) {
    return `${String(symbol || "").startsWith("6") ? "sh" : "sz"}${symbol}`;
}

// 20261028 → 2026-10-28
function toDate(value) {
    const text = String(value || "");
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

// 涨跌幅、振幅、换手率为小数，换算为%
function parseClsKlines(data) {
    const rows = (data && Array.isArray(data.data)) ? data.data : [];
    return rows.map(row => {
        const close = Number(row.close_px);
        const prevClose = Number(row.preclose_px);
        return {
            date: toDate(row.date),
            open: Number(row.open_px),
            close,
            high: Number(row.high_px),
            low: Number(row.low_px),
            volume: Number(row.business_amount) / 100,
            amount: Number(row.business_balance),
            amp: Number(row.amp) * 100,
            changePct: Number(row.change) * 100,
            change: close - prevClose,
            turnover: Number(row.tr) * 100
        };
    });
}

function createClsSource({ httpClient, requestWithRetry }) {
    async function getDailyKline(symbol, limit) {
        const res = await requestWithRetry(() =>
            httpClient.get(`${BASE_URL}/kline`, {
                params: { secu_code: toClsCode(symbol), type: "fd1", offset: 0, limit },
                headers: HEADERS
            })
        );
        const klines = parseClsKlines(res.data);
        if (!klines.length) throw notFound(`财联社未返回${symbol}日K`);
        return klines;
    }

    async function getStockProfile(symbol) {
        const res = await requestWithRetry(() =>
            httpClient.get(`${BASE_URL}/basic`, {
                params: { secu_code: toClsCode(symbol), fields: "secu_name,secu_code" },
                headers: HEADERS
            })
        );
        const info = res.data && res.data.data;
        if (!info || !info.secu_name) throw notFound(`无法识别股票代码${symbol}`);
        return { symbol: String(symbol), name: String(info.secu_name) };
    }

    return { name: "财联社", getDailyKline, getStockProfile };
}

module.exports = { createClsSource, parseClsKlines };
