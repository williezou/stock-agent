const { runPool } = require("../../lib/async");
const { formatError } = require("../../lib/http");
const { BROWSER_USER_AGENT } = require("./sources/common");

// 沪深A股全市场实时快照（量价异动用）：沪市取上交所官方行情（一次请求覆盖全部沪市股票），
// 深市交易所没有可批量获取的实时行情，取新浪财经深市A股列表（每页最多100只，约30页）。
// 某一边失败时只返回另一边，缺席的股票本轮不参与比较
const SSE_LIST_URL = "https://yunhq.sse.com.cn:32042/v1/sh1/list/exchange/equity";
const SINA_BASE_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php";
const SINA_HEADERS = { "User-Agent": BROWSER_USER_AGENT, "Referer": "https://finance.sina.com.cn/" };
const SINA_PAGE_SIZE = 100;
const SINA_CONCURRENCY = 3;
const SSE_MAX_ROWS = 5000;

function validRows(rows) {
    return rows.filter(row => /^\d{6}$/.test(row.symbol) && row.price > 0 && Number.isFinite(row.changePct) && Number.isFinite(row.amount));
}

// 上交所：[代码, 名称, 最新价, 涨跌幅(%), 成交额(元)]；停牌股最新价为0
function parseSseList(data) {
    const list = (data && Array.isArray(data.list)) ? data.list : [];
    return validRows(list.map(([symbol, name, price, changePct, amount]) => ({
        symbol: String(symbol),
        name: String(name || "").trim(),
        price: Number(price),
        changePct: Number(changePct),
        amount: Number(amount)
    })));
}

// 新浪：changepercent 为%，amount 为元；停牌股 trade 为0
function parseSinaList(data) {
    const parsed = typeof data === "string" ? JSON.parse(data || "null") : data;
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) throw new Error("新浪行情列表返回格式无法解析");
    return validRows(parsed.map(row => ({
        symbol: String(row.code || ""),
        name: String(row.name || "").trim(),
        price: Number(row.trade),
        changePct: Number(row.changepercent),
        amount: Number(row.amount)
    })));
}

function createMarketSnapshotService({ httpClient, requestWithRetry }) {
    async function fetchShanghai() {
        const res = await requestWithRetry(() => httpClient.get(SSE_LIST_URL, {
            params: { select: "code,name,last,chg_rate,amount", order: "", begin: 0, end: SSE_MAX_ROWS },
            headers: { "User-Agent": BROWSER_USER_AGENT }
        }), 2);
        return parseSseList(res.data);
    }

    async function fetchSinaPage(page) {
        const res = await requestWithRetry(() => httpClient.get(`${SINA_BASE_URL}/Market_Center.getHQNodeData`, {
            params: { page, num: SINA_PAGE_SIZE, sort: "symbol", asc: 1, node: "sz_a", symbol: "", _s_r_a: "page" },
            headers: SINA_HEADERS
        }), 1);
        return parseSinaList(res.data);
    }

    // 先查深市总数再按页并发拉取；任一页失败则本轮放弃深市，避免只拿到部分股票
    async function fetchShenzhen() {
        const res = await requestWithRetry(() => httpClient.get(`${SINA_BASE_URL}/Market_Center.getHQNodeStockCount`, {
            params: { node: "sz_a" },
            headers: SINA_HEADERS
        }), 1);
        const total = Number(String(res.data).replace(/"/g, ""));
        if (!Number.isFinite(total) || total <= 0) throw new Error("新浪深市股票数量无法解析");
        const pages = Array.from({ length: Math.ceil(total / SINA_PAGE_SIZE) }, (_, index) => index + 1);
        const results = await runPool(pages, page => fetchSinaPage(page), SINA_CONCURRENCY);
        return results.flat();
    }

    async function getSnapshot() {
        const [shanghai, shenzhen] = await Promise.allSettled([fetchShanghai(), fetchShenzhen()]);
        const errors = [];
        const rows = [];
        const sources = {};
        for (const [label, result] of [["上交所", shanghai], ["新浪", shenzhen]]) {
            if (result.status === "fulfilled") {
                rows.push(...result.value);
                sources[label] = result.value.length;
            } else {
                errors.push(`${label}：${formatError(result.reason)}`);
            }
        }
        if (!rows.length) throw new Error(errors.join("；") || "行情快照为空");
        return { rows, sources, errors };
    }

    return { getSnapshot };
}

module.exports = { createMarketSnapshotService, parseSinaList, parseSseList };
