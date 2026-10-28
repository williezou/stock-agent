const { config } = require("../../../config");
const { BROWSER_USER_AGENT } = require("./common");

// 东方财富龙虎榜明细（JSON）：按“股票×上榜原因”逐条返回，同一股票按代码合并
const URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const PAGE_SIZE = 500; // 单日上榜明细通常不足200条，极端行情可能更多
const MAX_PAGES = 5;
const NO_DATA_CODE = 9201; // “返回数据为空”：当日榜单尚未发布
const HEADERS = { "User-Agent": BROWSER_USER_AGENT, "Referer": "https://data.eastmoney.com/" };
const SEAT_PAGE_SIZE = 50; // 单只股票每个上榜原因买卖各前5营业部，多原因时也远不足50条

function mergeRows(rows) {
    const bySymbol = new Map();
    for (const item of rows) {
        const symbol = item.SECURITY_CODE || "";
        if (!symbol) continue;
        const reason = item.EXPLANATION || item.EXPLAIN || "";
        const existing = bySymbol.get(symbol);
        if (existing) {
            if (reason && !existing.reason.includes(reason)) {
                existing.reason = existing.reason ? `${existing.reason}；${reason}` : reason;
            }
            continue;
        }
        bySymbol.set(symbol, {
            symbol,
            name: item.SECURITY_NAME_ABBR || "",
            price: Number(item.CLOSE_PRICE) || 0,
            changePct: Number(item.CHANGE_RATE) || 0,
            turnoverRate: Number(item.TURNOVERRATE) || 0,
            boardDate: (item.TRADE_DATE || "").toString().slice(0, 10),
            reason,
            netAmount: Number(item.BILLBOARD_NET_AMT) || 0,
            dealAmount: Number(item.BILLBOARD_DEAL_AMT) || 0
        });
    }
    return [...bySymbol.values()];
}

function toSeat(item) {
    return {
        name: item.OPERATEDEPT_NAME || "",
        buy: Number(item.BUY) || 0,
        sell: Number(item.SELL) || 0,
        net: Number(item.NET) || 0
    };
}

// 同一股票每个上榜原因是一条记录（TRADE_ID），席位表按 TRADE_ID 归组，与同花顺“每个上榜原因一组”一致；金额单位为元
function groupSeatDetails(symbol, boardRows, buyRows, sellRows) {
    if (!boardRows.length) return null;
    const seatsOf = (rows, tradeId, field) => rows
        .filter(item => String(item.TRADE_ID) === String(tradeId))
        .map(toSeat)
        .sort((x, y) => y[field] - x[field]);
    const first = boardRows[0];
    return {
        symbol,
        name: first.SECURITY_NAME_ABBR || "",
        changePct: Number(first.CHANGE_RATE),
        groups: boardRows.map(item => ({
            reason: item.EXPLANATION || item.EXPLAIN || "",
            dealAmount: Number(item.BILLBOARD_DEAL_AMT) || 0,
            buyTotal: Number(item.BILLBOARD_BUY_AMT) || 0,
            sellTotal: Number(item.BILLBOARD_SELL_AMT) || 0,
            netAmount: Number(item.BILLBOARD_NET_AMT) || 0,
            buyers: seatsOf(buyRows, item.TRADE_ID, "buy"),
            sellers: seatsOf(sellRows, item.TRADE_ID, "sell")
        }))
    };
}

function createEastmoneyLonghuSource({ httpClient, requestWithRetry }) {
    async function query(params) {
        const res = await requestWithRetry(() =>
            httpClient.get(URL, {
                params: { columns: "ALL", source: "WEB", client: "WEB", ...params },
                headers: HEADERS
            })
        );
        // 东财失败时仍返回 HTTP 200 但 success=false，需显式校验，否则会静默变空
        if (res.data && res.data.success === false && res.data.code !== NO_DATA_CODE) {
            throw new Error(`东方财富龙虎榜接口业务失败: ${res.data.message || "未知原因"}`);
        }
        return { rows: res.data?.result?.data || [], pages: Number(res.data?.result?.pages) || 1 };
    }

    function fetchPage(dateStr, pageNumber) {
        return query({
            reportName: "RPT_DAILYBILLBOARD_DETAILS",
            pageNumber,
            pageSize: PAGE_SIZE,
            // 按净买入额降序：同一股票多次上榜时，合并后保留净买入最大的一条
            sortColumns: "BILLBOARD_NET_AMT",
            sortTypes: "-1",
            filter: `(TRADE_DATE<='${dateStr}')(TRADE_DATE>='${dateStr}')`
        });
    }

    // 某只股票当日的买卖席位；未上榜或未发布时返回null。
    // 三个报表依次请求而不并发，降低对东方财富的瞬时压力；未上榜时只发一个请求
    async function getSeatDetails(dateStr, symbol) {
        const filter = `(TRADE_DATE='${dateStr}')(SECURITY_CODE="${symbol}")`;
        const board = await query({ reportName: "RPT_DAILYBILLBOARD_DETAILS", pageSize: SEAT_PAGE_SIZE, filter });
        if (!board.rows.length) return null;
        const buys = await query({ reportName: "RPT_BILLBOARD_DAILYDETAILSBUY", pageSize: SEAT_PAGE_SIZE, filter });
        const sells = await query({ reportName: "RPT_BILLBOARD_DAILYDETAILSSELL", pageSize: SEAT_PAGE_SIZE, filter });
        return groupSeatDetails(symbol, board.rows, buys.rows, sells.rows);
    }

    async function getBoardByDate(dateStr) {
        const first = await fetchPage(dateStr, 1);
        const rows = [...first.rows];
        for (let page = 2; page <= Math.min(first.pages, MAX_PAGES); page++) {
            rows.push(...(await fetchPage(dateStr, page)).rows);
        }
        if (first.pages > MAX_PAGES) {
            console.log(`⚠️ ${dateStr}龙虎榜明细超过${MAX_PAGES}页，仅统计前${MAX_PAGES * PAGE_SIZE}条`);
        }
        if (config.debug && rows[0]) console.log("🧪 Longhu raw keys:", Object.keys(rows[0]));
        return mergeRows(rows);
    }

    return { name: "东方财富", getBoardByDate, getSeatDetails };
}

module.exports = { createEastmoneyLonghuSource, groupSeatDetails };
