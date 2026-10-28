const { formatError } = require("../../lib/http");
const { BROWSER_USER_AGENT } = require("./sources/common");
const { HEADERS: EASTMONEY_HEADERS, push2NodeUrl } = require("./sources/eastmoney");

// 沪深A股「主力净流入」排行：每次只取净流入、净流出两头各一页，不拉全市场。
// 主源东方财富，失败时切换新浪财经。两家的“主力”口径不同（同一只股票的数值可相差一倍），
// 所以排行带上来源名，比较前后两次数据时必须来自同一家（见 FundFlowMonitor）
const RANK_SIZE = 100;
const A_SHARE_SYMBOL = /^\d{6}$/;

// 停牌股的资金字段为“-”，不参与比较
function validRows(rows) {
    return rows.filter(row => A_SHARE_SYMBOL.test(row.symbol) && Number.isFinite(row.mainNet) && Number.isFinite(row.amount));
}

// 东方财富：主力净流入 = 超大单 + 大单净额，按逐笔成交估算。盘中轮询频率高，固定走编号节点分散限流
function toEastmoneyRow(d) {
    return {
        symbol: d.f12,
        name: d.f14,
        price: Number(d.f2),
        changePct: Number(d.f3),
        amount: Number(d.f6), // 成交额（元）
        mainNet: Number(d.f62), // 主力净流入（元）
        mainRatio: Number(d.f184) // 主力净占比（%，占成交额）
    };
}

function parseFlowRows(data) {
    const diff = (data && data.data && data.data.diff) || [];
    return validRows(diff.map(toEastmoneyRow));
}

function createEastmoneyFlowSource({ httpClient, requestWithRetry }) {
    return {
        name: "东方财富",
        async fetchSide(descending) {
            const res = await requestWithRetry(() => httpClient.get(push2NodeUrl("/api/qt/clist/get"), {
                params: {
                    pn: 1,
                    pz: RANK_SIZE,
                    po: descending ? 1 : 0,
                    np: 1,
                    fltt: 2,
                    invt: 2,
                    fid: "f62",
                    fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
                    fields: "f12,f14,f2,f3,f6,f62,f184",
                    _: Date.now()
                },
                headers: EASTMONEY_HEADERS
            }), 2);
            return parseFlowRows(res.data);
        }
    };
}

// 新浪财经实时个股资金流向：r0_net 为主力净流入（元），r0_ratio、changeratio 为小数；bankuai=hs_a 只取沪深A股（不含ETF）
function toSinaRow(d) {
    return {
        symbol: String(d.symbol || "").replace(/^(sh|sz|bj)/, ""),
        name: d.name,
        price: Number(d.trade),
        changePct: Number(d.changeratio) * 100,
        amount: Number(d.amount),
        mainNet: Number(d.r0_net),
        mainRatio: Number(d.r0_ratio) * 100
    };
}

function parseSinaFlowRows(data) {
    const parsed = typeof data === "string" ? JSON.parse(data || "null") : data;
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) throw new Error("新浪资金流向返回格式无法解析");
    return validRows(parsed.map(toSinaRow));
}

function createSinaFlowSource({ httpClient, requestWithRetry }) {
    const url = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_ssggzj";
    return {
        name: "新浪",
        async fetchSide(descending) {
            const res = await requestWithRetry(() => httpClient.get(url, {
                params: { page: 1, num: RANK_SIZE, sort: "r0_net", asc: descending ? 0 : 1, bankuai: "hs_a", shichang: "" },
                headers: { "User-Agent": BROWSER_USER_AGENT, "Referer": "https://finance.sina.com.cn/" }
            }), 2);
            return parseSinaFlowRows(res.data);
        }
    };
}

function createFundFlowService({ httpClient, requestWithRetry, sources }) {
    const all = sources || [
        createEastmoneyFlowSource({ httpClient, requestWithRetry }),
        createSinaFlowSource({ httpClient, requestWithRetry })
    ];

    // 两头依次拉取，降低并发请求
    async function fetchRanking(source) {
        const inflow = await source.fetchSide(true);
        const outflow = await source.fetchSide(false);
        if (!inflow.length && !outflow.length) throw new Error(`${source.name}资金流排行为空`);
        return { source: source.name, inflow, outflow, size: RANK_SIZE };
    }

    // prefer：优先使用的来源（监控起点所用的那一家），避免两家数据混用；失败时依次换下一家
    async function getRanking({ prefer } = {}) {
        const ordered = [...all].sort((a, b) => (b.name === prefer) - (a.name === prefer));
        const errors = [];
        for (const source of ordered) {
            try {
                return await fetchRanking(source);
            } catch (error) {
                errors.push(`${source.name}：${formatError(error)}`);
                if (source !== ordered.at(-1)) console.log(`⚠️ ${source.name}资金流排行获取失败（${formatError(error)}），改用下一个来源`);
            }
        }
        throw new Error(errors.join("；"));
    }

    return { getRanking };
}

module.exports = {
    RANK_SIZE,
    createEastmoneyFlowSource,
    createFundFlowService,
    createSinaFlowSource,
    parseFlowRows,
    parseSinaFlowRows
};
