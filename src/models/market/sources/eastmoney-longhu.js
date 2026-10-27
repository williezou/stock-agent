const { config } = require("../../../config");
const { BROWSER_USER_AGENT } = require("./common");

// 东方财富龙虎榜明细（JSON）：按“股票×上榜原因”逐条返回，同一股票按代码合并
const URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const PAGE_SIZE = 500; // 单日上榜明细通常不足200条，极端行情可能更多
const MAX_PAGES = 5;
const NO_DATA_CODE = 9201; // “返回数据为空”：当日榜单尚未发布

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

function createEastmoneyLonghuSource({ httpClient, requestWithRetry }) {
    async function fetchPage(dateStr, pageNumber) {
        const res = await requestWithRetry(() =>
            httpClient.get(URL, {
                params: {
                    reportName: "RPT_DAILYBILLBOARD_DETAILS",
                    columns: "ALL",
                    pageNumber,
                    pageSize: PAGE_SIZE,
                    // 按净买入额降序：同一股票多次上榜时，合并后保留净买入最大的一条
                    sortColumns: "BILLBOARD_NET_AMT",
                    sortTypes: "-1",
                    filter: `(TRADE_DATE<='${dateStr}')(TRADE_DATE>='${dateStr}')`,
                    source: "WEB",
                    client: "WEB"
                },
                headers: { "User-Agent": BROWSER_USER_AGENT, "Referer": "https://data.eastmoney.com/" }
            })
        );
        // 东财失败时仍返回 HTTP 200 但 success=false，需显式校验，否则会静默变空
        if (res.data && res.data.success === false && res.data.code !== NO_DATA_CODE) {
            throw new Error(`东方财富龙虎榜接口业务失败: ${res.data.message || "未知原因"}`);
        }
        return { rows: res.data?.result?.data || [], pages: Number(res.data?.result?.pages) || 1 };
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

    return { name: "东方财富", getBoardByDate };
}

module.exports = { createEastmoneyLonghuSource };
