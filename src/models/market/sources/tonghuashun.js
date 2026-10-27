const { BROWSER_USER_AGENT, notFound, withPrevCloseFields } = require("./common");

// 备用源一：同花顺前复权日K（含成交额、换手率；成交量单位为股）。非官方接口，取自其行情页面
const BASE_URL = "https://d.10jqka.com.cn/v6/line";

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

// 历史日K（last.js，截至上一交易日）+ 当日K（today.js）；成交量由股换算为手，与东方财富一致
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

function createTonghuashunSource({ httpClient, requestWithRetry }) {
    async function fetchJsonp(symbol, file) {
        const res = await requestWithRetry(() =>
            httpClient.get(`${BASE_URL}/hs_${symbol}/01/${file}`, {
                responseType: "text",
                transformResponse: [data => data],
                headers: {
                    "User-Agent": BROWSER_USER_AGENT,
                    "Referer": "https://stockpage.10jqka.com.cn/"
                }
            })
        );
        return parseJsonp(res.data);
    }

    async function getDailyKline(symbol, limit) {
        const [history, today] = await Promise.all([
            fetchJsonp(symbol, "last.js"),
            fetchJsonp(symbol, "today.js").catch(() => null)
        ]);
        const klines = parseThsKlines(history, today, symbol).slice(-limit);
        if (!klines.length) throw notFound(`同花顺未返回${symbol}日K`);
        return klines;
    }

    async function getStockProfile(symbol) {
        const history = await fetchJsonp(symbol, "last.js");
        if (!history.name || !history.data) throw notFound(`无法识别股票代码${symbol}`);
        return { symbol: String(symbol), name: String(history.name) };
    }

    return { name: "同花顺", getDailyKline, getStockProfile };
}

module.exports = { createTonghuashunSource, parseJsonp, parseThsKlines };
