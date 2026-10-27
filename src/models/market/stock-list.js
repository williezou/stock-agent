const { delay } = require("../../lib/async");
const { formatError } = require("../../lib/http");
const { BROWSER_USER_AGENT } = require("./sources/common");
const { HEADERS: EASTMONEY_HEADERS } = require("./sources/eastmoney");

// 沪深A股全市场行情快照（选股池与涨跌停统计用）。主源东方财富，失败时切换新浪财经；
// 本次运行中主源失败一次后，后续分页直接使用新浪，避免在封禁期间反复超时
const PAGE_SIZE = 100; // 两个数据源单页上限均为100
const POOL_SIZE = 200;
const MOVERS_MAX_PAGES = 5;
const PAGE_GAP_MS = 120;
const MIN_LIMIT_MOVE_PCT = 4.9; // 最小涨跌停幅度（ST ±5%），低于此值不可能再有涨跌停

function createEastmoneyListSource({ httpClient, requestWithRetry }) {
    const url = "https://push2.eastmoney.com/api/qt/clist/get";
    const sortField = { turnover: "f6", changePct: "f3" };
    return {
        name: "东方财富",
        async fetchPage({ page, sortBy, descending }) {
            const res = await requestWithRetry(() => httpClient.get(url, {
                params: {
                    pn: page,
                    pz: PAGE_SIZE,
                    po: descending ? 1 : 0,
                    np: 1,
                    fltt: 2,
                    invt: 2,
                    fid: sortField[sortBy],
                    fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
                    // 代码/名称/最新价/涨跌幅/涨跌额/成交量(手)/昨收/上市日期
                    fields: "f12,f14,f2,f3,f4,f5,f18,f26",
                    _: Date.now()
                },
                headers: EASTMONEY_HEADERS
            }), 2);
            const diff = (res.data && res.data.data && res.data.data.diff) || [];
            return diff.map(d => ({
                symbol: d.f12,
                name: d.f14,
                price: Number(d.f2) || 0,
                changePct: Number(d.f3) || 0,
                change: Number(d.f4) || 0,
                volume: Number(d.f5) || 0,
                prevClose: Number(d.f18) || 0,
                listingDate: d.f26 || ""
            }));
        }
    };
}

// 新浪财经沪深A股行情中心；成交量单位为股，换算为手。不提供上市日期，次新股过滤在此源下不生效
function createSinaListSource({ httpClient, requestWithRetry }) {
    const url = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData";
    const sortField = { turnover: "amount", changePct: "changepercent" };
    return {
        name: "新浪",
        async fetchPage({ page, sortBy, descending }) {
            const res = await requestWithRetry(() => httpClient.get(url, {
                params: { page, num: PAGE_SIZE, sort: sortField[sortBy], asc: descending ? 0 : 1, node: "hs_a", symbol: "", _s_r_a: "page" },
                headers: { "User-Agent": BROWSER_USER_AGENT, "Referer": "https://finance.sina.com.cn/" }
            }), 2);
            const parsed = typeof res.data === "string" ? JSON.parse(res.data || "null") : res.data;
            // 页码越界等情况下新浪返回null，视为空页
            const rows = parsed === null ? [] : parsed;
            if (!Array.isArray(rows)) throw new Error("新浪行情列表返回格式无法解析");
            return rows.map(d => ({
                symbol: d.code,
                name: d.name,
                price: Number(d.trade) || 0,
                changePct: Number(d.changepercent) || 0,
                change: Number(d.pricechange) || 0,
                volume: (Number(d.volume) || 0) / 100,
                prevClose: Number(d.settlement) || 0,
                listingDate: ""
            }));
        }
    };
}

// 跨页累积时按代码去重：中途切换数据源后两源排序略有差异，同一股票可能在相邻页重复出现
function appendUnique(rows, seen, pageRows) {
    for (const row of pageRows) {
        if (seen.has(row.symbol)) continue;
        seen.add(row.symbol);
        rows.push(row);
    }
}

function createStockListService({ httpClient, requestWithRetry, sources }) {
    const [primary, fallback] = sources || [
        createEastmoneyListSource({ httpClient, requestWithRetry }),
        createSinaListSource({ httpClient, requestWithRetry })
    ];
    let primaryDown = false;

    async function fetchPage(query) {
        if (!primaryDown) {
            try {
                return await primary.fetchPage(query);
            } catch (error) {
                primaryDown = true;
                console.log(`⚠️ ${primary.name}行情列表获取失败（${formatError(error)}），切换${fallback.name}`);
            }
        }
        return fallback.fetchPage(query);
    }

    // 按成交额取流动性最好的股票作为选股池，避免只在当日涨幅榜里挑选导致各分类重叠
    async function getLiquidPool() {
        const rows = [];
        const seen = new Set();
        for (let page = 1; page <= POOL_SIZE / PAGE_SIZE; page++) {
            if (page > 1) await delay(PAGE_GAP_MS);
            const pageRows = await fetchPage({ page, sortBy: "turnover", descending: true });
            appendUnique(rows, seen, pageRows);
            if (pageRows.length < PAGE_SIZE) break;
        }
        return rows;
    }

    // 按涨跌幅逐页拉取，直到越过涨跌停区间；翻到上限仍未越过时标记为触顶（计数只是下限）
    async function getMoversSide(descending) {
        const rows = [];
        const seen = new Set();
        for (let page = 1; page <= MOVERS_MAX_PAGES; page++) {
            if (page > 1) await delay(PAGE_GAP_MS);
            const pageRows = await fetchPage({ page, sortBy: "changePct", descending });
            appendUnique(rows, seen, pageRows);
            const last = pageRows.at(-1);
            if (pageRows.length < PAGE_SIZE || !last || Math.abs(last.changePct) < MIN_LIMIT_MOVE_PCT) {
                return { rows, capped: false };
            }
        }
        return { rows, capped: true };
    }

    // 涨跌幅两端的榜单，用于统计涨停/跌停与市场情绪；两端依次拉取以降低并发请求
    async function getMovers() {
        const gainers = await getMoversSide(true);
        const losers = await getMoversSide(false);
        return { gainers, losers };
    }

    return { getLiquidPool, getMovers };
}

module.exports = { createEastmoneyListSource, createSinaListSource, createStockListService };
