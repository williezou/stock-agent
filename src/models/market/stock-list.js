const { delay } = require("../../lib/async");
const { HEADERS } = require("./sources/eastmoney");

// 东方财富沪深A股行情列表（全市场快照）
const LIST_URL = "https://push2.eastmoney.com/api/qt/clist/get";
const A_SHARE_MARKETS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23";
const SORT_FIELD = { turnover: "f6", changePct: "f3" };

const POOL_SIZE = 200;
const POOL_FALLBACK_SIZE = 100;
const MOVERS_PAGE_SIZE = 100;
const MOVERS_MAX_PAGES = 5;
const MOVERS_PAGE_GAP_MS = 120;
const MIN_LIMIT_MOVE_PCT = 4.9; // 最小涨跌停幅度（ST ±5%），低于此值不可能再有涨跌停

function toStock(d) {
    return {
        symbol: d.f12,
        name: d.f14,
        price: Number(d.f2) || 0,
        changePct: Number(d.f3) || 0,
        change: Number(d.f4) || 0,
        volume: Number(d.f5) || 0,
        prevClose: Number(d.f18) || 0,
        listingDate: d.f26 || ""
    };
}

function createStockListService({ httpClient, requestWithRetry }) {
    // descending=true 为降序
    async function fetchPage({ page = 1, size, sortBy, descending }) {
        const res = await requestWithRetry(
            () => httpClient.get(LIST_URL, {
                params: {
                    pn: page,
                    pz: size,
                    po: descending ? 1 : 0,
                    np: 1,
                    fltt: 2,
                    invt: 2,
                    fid: SORT_FIELD[sortBy],
                    fs: A_SHARE_MARKETS,
                    // 代码/名称/最新价/涨跌幅/涨跌额/成交量/昨收/上市日期
                    fields: "f12,f14,f2,f3,f4,f5,f18,f26",
                    _: Date.now()
                },
                headers: HEADERS
            }),
            5
        );
        const diff = (res.data && res.data.data && res.data.data.diff) || [];
        return diff.map(toStock);
    }

    // 按成交额取流动性最好的股票作为选股池，避免只在当日涨幅榜里挑选导致各分类重叠
    async function getLiquidPool() {
        try {
            return await fetchPage({ size: POOL_SIZE, sortBy: "turnover", descending: true });
        } catch (error) {
            console.log("⚠️ 拉取股票池超时，尝试降低数量重试...");
            return fetchPage({ size: POOL_FALLBACK_SIZE, sortBy: "turnover", descending: true });
        }
    }

    // 按涨跌幅逐页拉取，直到越过涨跌停区间；翻到上限仍未越过时标记为触顶（计数只是下限）
    async function getMoversSide(descending) {
        const rows = [];
        for (let page = 1; page <= MOVERS_MAX_PAGES; page++) {
            const pageRows = await fetchPage({ page, size: MOVERS_PAGE_SIZE, sortBy: "changePct", descending });
            rows.push(...pageRows);
            const last = pageRows.at(-1);
            if (pageRows.length < MOVERS_PAGE_SIZE || !last || Math.abs(last.changePct) < MIN_LIMIT_MOVE_PCT) {
                return { rows, capped: false };
            }
            await delay(MOVERS_PAGE_GAP_MS);
        }
        return { rows, capped: true };
    }

    // 涨跌幅两端的榜单，用于统计涨停/跌停与市场情绪
    async function getMovers() {
        const [gainers, losers] = await Promise.all([getMoversSide(true), getMoversSide(false)]);
        return { gainers, losers };
    }

    return { getLiquidPool, getMovers };
}

module.exports = { createStockListService };
