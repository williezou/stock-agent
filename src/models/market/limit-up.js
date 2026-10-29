const dns = require("dns");
const https = require("https");
const { config } = require("../../config");
const { BROWSER_USER_AGENT } = require("../../lib/http");

// 东方财富涨停板行情（push2ex）：涨停池、跌停池、炸板池、昨日涨停今日表现，直接带连板数、封板时间、炸板次数与行业。
// push2ex.eastmoney.com 的 AAAA 只在国内DNS（按国内网段）返回；纯IPv6网络下改为解析东财给它配的IPv6别名，
// TLS 仍按原域名握手
const BASE_URL = "https://push2ex.eastmoney.com";
const IPV6_ALIAS = "push2exipv6.trafficmanager.cn";
const UT = "7eea3edcaed734bea9cbfc24409ed989";
const PAGE_SIZE = 500;

const POOLS = {
    limitUp: { path: "/getTopicZTPool", sort: "fbt:asc" },
    limitDown: { path: "/getTopicDTPool", sort: "fund:asc" },
    broken: { path: "/getTopicZBPool", sort: "fbt:asc" },
    yesterday: { path: "/getYesterdayZTPool", sort: "zs:desc" }
};

let ipv6Agent;
function getIpv6Agent() {
    if (!ipv6Agent) {
        ipv6Agent = new https.Agent({
            keepAlive: true,
            lookup(_hostname, options, callback) {
                dns.promises.resolve6(IPV6_ALIAS).then(addresses => {
                    if (!addresses.length) throw new Error(`${IPV6_ALIAS}没有IPv6地址`);
                    if (options && options.all) callback(null, addresses.map(address => ({ address, family: 6 })));
                    else callback(null, addresses[0], 6);
                }).catch(error => callback(error));
            }
        });
    }
    return ipv6Agent;
}

// 时间 92500 → "09:25"；价格单位为厘
function clockText(value) {
    const text = String(value || "").padStart(6, "0");
    return value ? `${text.slice(0, 2)}:${text.slice(2, 4)}` : "";
}

function price(value) {
    return Number.isFinite(value) ? value / 1000 : null;
}

function baseRow(item) {
    return {
        symbol: String(item.c),
        name: String(item.n || "").replace(/\s+/g, ""),
        price: price(item.p),
        changePct: item.zdp,
        amount: item.amount,
        turnover: item.hs,
        floatCap: item.ltsz,
        industry: item.hybk || ""
    };
}

// 几天几板：{ days, ct }，如 5天4板
function boardStat(item) {
    return item.zttj ? { days: item.zttj.days, count: item.zttj.ct } : null;
}

const PARSERS = {
    limitUp: item => ({
        ...baseRow(item),
        boards: item.lbc || 1,
        firstTime: clockText(item.fbt),
        lastTime: clockText(item.lbt),
        sealAmount: item.fund,
        breaks: item.zbc || 0,
        stat: boardStat(item)
    }),
    limitDown: item => ({
        ...baseRow(item),
        days: item.days || 1,
        lastTime: clockText(item.lbt),
        sealAmount: item.fba,
        opens: item.oc || 0
    }),
    broken: item => ({
        ...baseRow(item),
        limitPrice: price(item.ztp),
        firstTime: clockText(item.fbt),
        breaks: item.zbc || 0,
        amplitude: item.zf
    }),
    yesterday: item => ({
        ...baseRow(item),
        prevBoards: item.ylbc || 1,
        prevFirstTime: clockText(item.yfbt)
    })
};

// 接口返回的 qdate 为实际数据日期：休市日查询当天得到的是上一交易日，据此判断当天是否有数据
function parsePool(name, data) {
    if (!data || data.rc !== 0) throw new Error(`东方财富涨停板接口返回异常（${name}）：rc=${data && data.rc}`);
    const body = data.data || {};
    return { date: body.qdate ? String(body.qdate) : "", rows: (body.pool || []).map(PARSERS[name]) };
}

function createLimitUpService({ httpClient, requestWithRetry }) {
    async function fetchPool(name, compactDate) {
        const { path, sort } = POOLS[name];
        const response = await requestWithRetry(() => httpClient.get(`${BASE_URL}${path}`, {
            params: { ut: UT, dpt: "wz.ztzt", Pageindex: 0, pagesize: PAGE_SIZE, sort, date: compactDate },
            headers: { "User-Agent": BROWSER_USER_AGENT, "Referer": "https://quote.eastmoney.com/" },
            ...(config.ipv6Only && { httpsAgent: getIpv6Agent(), proxy: false })
        }), 2, 500);
        return parsePool(name, response.data);
    }

    // dateStr：YYYY-MM-DD；返回各池与实际数据日期（与 dateStr 不同说明当天休市或数据未更新）
    async function getDailyPools(dateStr) {
        const compactDate = dateStr.replace(/-/g, "");
        const names = Object.keys(POOLS);
        const results = await Promise.all(names.map(name => fetchPool(name, compactDate)));
        const pools = Object.fromEntries(names.map((name, index) => [name, results[index].rows]));
        const dataDate = results[0].date;
        return { date: dateStr, dataDate: dataDate ? `${dataDate.slice(0, 4)}-${dataDate.slice(4, 6)}-${dataDate.slice(6, 8)}` : "", ...pools };
    }

    return { getDailyPools };
}

module.exports = { clockText, createLimitUpService, parsePool };
