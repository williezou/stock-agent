const { HEADERS, push2NodeUrl } = require("./sources/eastmoney");

// 东方财富沪深A股「主力净流入」排行：每次只取净流入、净流出两头各一页，不拉全市场。
// 主力净流入 = 超大单 + 大单净额，是东方财富按逐笔成交估算的数据，非交易所官方口径。
// 盘中轮询频率高，固定走编号节点分散限流
const RANK_SIZE = 100;

function toFlowRow(d) {
    return {
        symbol: d.f12,
        name: d.f14,
        price: Number(d.f2),
        changePct: Number(d.f3),
        amount: Number(d.f6), // 成交额（元）
        mainNet: Number(d.f62), // 主力净流入（元）
        mainRatio: Number(d.f184), // 主力净占比（%，占成交额）
        superNet: Number(d.f66), // 超大单净额（元）
        bigNet: Number(d.f72) // 大单净额（元）
    };
}

// 停牌股的资金字段为“-”，不参与比较
function parseFlowRows(data) {
    const diff = (data && data.data && data.data.diff) || [];
    return diff.map(toFlowRow).filter(row => row.symbol && Number.isFinite(row.mainNet) && Number.isFinite(row.amount));
}

function createFundFlowService({ httpClient, requestWithRetry }) {
    async function fetchSide(descending) {
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
                fields: "f12,f14,f2,f3,f6,f62,f184,f66,f72",
                _: Date.now()
            },
            headers: HEADERS
        }), 2);
        return parseFlowRows(res.data);
    }

    // 两头依次拉取，降低并发请求
    async function getRanking() {
        const inflow = await fetchSide(true);
        const outflow = await fetchSide(false);
        return { inflow, outflow, size: RANK_SIZE };
    }

    return { getRanking };
}

module.exports = { RANK_SIZE, createFundFlowService, parseFlowRows };
