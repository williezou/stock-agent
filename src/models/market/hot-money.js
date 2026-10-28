const { createDatacenterQuery } = require("./sources/eastmoney-longhu");

// 游资动向：当日龙虎榜全部营业部席位（东方财富数据中心），按营业部汇总买卖的股票，并附营业部的历史上榜统计
const PAGE_SIZE = 500;
const MAX_PAGES = 5;
// 非游资席位：机构与北向资金专用席位
const NON_HOT_MONEY = /机构专用|沪股通专用|深股通专用/;
const STATS_CYCLE = "04"; // 统计周期：01近一月、02近三月、03近六月、04近一年
const STATS_BATCH = 100;

// 同一股票每个上榜原因一条记录（TRADE_ID）。“连续三个交易日”等多日原因给的是累计金额，与单日原因相加会重复计算：
// 每只股票优先取单日原因，没有单日原因时才用多日累计；同一营业部只算一次（买入榜与卖出榜可能都有它）
function pickTradeIds(rows) {
    const byStock = new Map();
    for (const row of rows) {
        const list = byStock.get(row.SECURITY_CODE) || [];
        if (!list.some(item => item.id === String(row.TRADE_ID))) {
            list.push({ id: String(row.TRADE_ID), multiDay: /连续/.test(row.EXPLANATION || "") });
        }
        byStock.set(row.SECURITY_CODE, list);
    }
    const picked = new Map();
    for (const [symbol, list] of byStock) {
        const single = list.filter(item => !item.multiDay);
        picked.set(symbol, new Set((single.length ? single : list.slice(0, 1)).map(item => item.id)));
    }
    return picked;
}

// rows：当日买入榜与卖出榜的全部席位记录；names：股票代码 → 名称（取自龙虎榜榜单）
function aggregateSeats(rows, names = new Map()) {
    const picked = pickTradeIds(rows);
    const seats = new Map();
    const counted = new Set();
    for (const row of rows) {
        const name = row.OPERATEDEPT_NAME || "";
        if (!name || NON_HOT_MONEY.test(name)) continue;
        if (!picked.get(row.SECURITY_CODE)?.has(String(row.TRADE_ID))) continue;
        const key = `${row.OPERATEDEPT_CODE}:${row.SECURITY_CODE}`;
        if (counted.has(key)) continue;
        counted.add(key);
        const seat = seats.get(row.OPERATEDEPT_CODE) || { code: String(row.OPERATEDEPT_CODE), name, net: 0, buy: 0, sell: 0, stocks: [] };
        const stock = {
            symbol: row.SECURITY_CODE,
            name: names.get(row.SECURITY_CODE) || row.SECURITY_CODE,
            changePct: Number(row.CHANGE_RATE),
            buy: Number(row.BUY) || 0,
            sell: Number(row.SELL) || 0,
            net: Number(row.NET) || 0
        };
        seat.stocks.push(stock);
        seat.buy += stock.buy;
        seat.sell += stock.sell;
        seat.net += stock.net;
        seats.set(row.OPERATEDEPT_CODE, seat);
    }
    for (const seat of seats.values()) seat.stocks.sort((a, b) => b.net - a.net);
    return [...seats.values()].sort((a, b) => b.net - a.net);
}

function toStats(row) {
    return {
        times: Number(row.TOTAL_BUYER_SALESTIMES_3DAY) || 0,
        riseProbability: Number(row.RISE_PROBABILITY_3DAY),
        averageIncrease: Number(row.AVERAGE_INCREASE_3DAY)
    };
}

function createHotMoneyService({ httpClient, requestWithRetry }) {
    const query = createDatacenterQuery({ httpClient, requestWithRetry });

    async function fetchAll(reportName, filter) {
        const rows = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const result = await query({ reportName, pageNumber: page, pageSize: PAGE_SIZE, filter });
            rows.push(...result.rows);
            if (page >= result.pages) break;
        }
        return rows;
    }

    // 当日全部营业部席位（买入榜、卖出榜依次请求）
    async function getSeatTrades(dateStr) {
        const filter = `(TRADE_DATE='${dateStr}')`;
        const buys = await fetchAll("RPT_BILLBOARD_DAILYDETAILSBUY", filter);
        const sells = await fetchAll("RPT_BILLBOARD_DAILYDETAILSSELL", filter);
        return [...buys, ...sells];
    }

    // 营业部近一年的上榜统计（上榜后3日上涨概率、平均涨幅、上榜次数）：code → stats；没有统计的营业部不在结果中
    async function getSeatStats(codes) {
        const stats = new Map();
        for (let i = 0; i < codes.length; i += STATS_BATCH) {
            const batch = codes.slice(i, i + STATS_BATCH);
            const result = await query({
                reportName: "RPT_RATEDEPT_RETURNT_RANKING",
                pageSize: STATS_BATCH,
                filter: `(STATISTICSCYCLE="${STATS_CYCLE}")(OPERATEDEPT_CODE in (${batch.map(code => `"${code}"`).join(",")}))`
            });
            for (const row of result.rows) stats.set(String(row.OPERATEDEPT_CODE), toStats(row));
        }
        return stats;
    }

    return { getSeatStats, getSeatTrades };
}

module.exports = { NON_HOT_MONEY, aggregateSeats, createHotMoneyService, pickTradeIds };
