const { BROWSER_USER_AGENT, formatError } = require("../../lib/http");

// 自选股事件（东方财富数据中心，IPv6 可用）：一批股票每张报表只查一次。
// 提前提醒：未来7天的限售解禁、未来3天的财报披露预约（每天都提醒，直到当天）；
// 新发生：上一交易日以来发布的业绩预告与股东增减持、上一交易日的大宗交易与融资余额明显变化（各只提醒一次）。
// 大宗交易收盘后陆续发布、融资融券次日早上发布，生成收盘报告时都还取不全当天的，所以都取上一交易日
const DC_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const LIFT_DAYS = 7;
const REPORT_DAYS = 3;
// 融资净买入占前一日融资余额的比例达到这个值才提醒
const MARGIN_MIN_RATIO = 0.03;
const MAX_HOLDER_EVENTS = 3;

function addDays(dateStr, days) {
    return new Date(Date.parse(`${dateStr}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

// 上一个工作日（节假日不另外处理：节后第一天取到的是假期中的日期，查不到数据就不提醒）
function previousWeekday(dateStr) {
    let date = addDays(dateStr, -1);
    while ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) date = addDays(date, -1);
    return date;
}

function day(value) {
    return String(value || "").slice(0, 10);
}

// 报告期 2026-09-30 → 2026年三季报
function reportName(reportDate) {
    const date = day(reportDate);
    const names = { "03": "一季报", "06": "中报", "09": "三季报", "12": "年报" };
    return `${date.slice(0, 4)}年${names[date.slice(5, 7)] || "定期报告"}`;
}

function inFilter(column, symbols) {
    return `(${column} in (${symbols.map(symbol => `"${symbol}"`).join(",")}))`;
}

const PARSERS = {
    // 限售解禁：解禁股数（万股）、占已流通股比例、解禁市值（万元）
    lift: (symbols, today) => ({
        reportName: "RPT_LIFT_STAGE",
        columns: "SECURITY_CODE,FREE_DATE,FREE_SHARES_TYPE,CURRENT_FREE_SHARES,FREE_RATIO,LIFT_MARKET_CAP",
        filter: `${inFilter("SECURITY_CODE", symbols)}(FREE_DATE>'${today}')(FREE_DATE<='${addDays(today, LIFT_DAYS)}')`,
        sortColumns: "FREE_DATE",
        sortTypes: "1",
        map: row => ({
            type: "lift",
            symbol: row.SECURITY_CODE,
            date: day(row.FREE_DATE),
            shares: row.CURRENT_FREE_SHARES,
            floatRatio: row.FREE_RATIO,
            marketCap: row.LIFT_MARKET_CAP * 10000,
            sharesType: row.FREE_SHARES_TYPE || ""
        })
    }),
    // 财报披露预约：取改期后的最新预约日，已披露的不提醒
    report: (symbols, today) => ({
        reportName: "RPT_PUBLIC_BS_APPOIN",
        columns: "SECURITY_CODE,REPORT_DATE,APPOINT_PUBLISH_DATE,ACTUAL_PUBLISH_DATE",
        filter: `${inFilter("SECURITY_CODE", symbols)}(APPOINT_PUBLISH_DATE>'${today}')(APPOINT_PUBLISH_DATE<='${addDays(today, REPORT_DAYS)}')`,
        sortColumns: "APPOINT_PUBLISH_DATE",
        sortTypes: "1",
        map: row => (row.ACTUAL_PUBLISH_DATE ? null : {
            type: "report",
            symbol: row.SECURITY_CODE,
            date: day(row.APPOINT_PUBLISH_DATE),
            name: reportName(row.REPORT_DATE)
        })
    }),
    // 业绩预告：预告类型（预增/预减/扭亏等）、指标、同比变动区间（%）
    forecast: (symbols, today, since) => ({
        reportName: "RPT_PUBLIC_OP_NEWPREDICT",
        columns: "SECURITY_CODE,NOTICE_DATE,REPORT_DATE,PREDICT_FINANCE,PREDICT_TYPE,ADD_AMP_LOWER,ADD_AMP_UPPER",
        filter: `${inFilter("SECURITY_CODE", symbols)}(NOTICE_DATE>'${since}')(NOTICE_DATE<='${today}')`,
        sortColumns: "NOTICE_DATE",
        sortTypes: "-1",
        map: row => ({
            type: "forecast",
            symbol: row.SECURITY_CODE,
            date: day(row.NOTICE_DATE),
            name: reportName(row.REPORT_DATE),
            finance: row.PREDICT_FINANCE || "",
            predictType: row.PREDICT_TYPE || "",
            lower: row.ADD_AMP_LOWER,
            upper: row.ADD_AMP_UPPER
        })
    }),
    // 股东增减持：股东、方向、变动股数（万股）、占流通股比例（%）
    holder: (symbols, today, since) => ({
        reportName: "RPT_SHARE_HOLDER_INCREASE",
        columns: "SECURITY_CODE,NOTICE_DATE,HOLDER_NAME,DIRECTION,CHANGE_NUM,CHANGE_FREE_RATIO",
        filter: `${inFilter("SECURITY_CODE", symbols)}(NOTICE_DATE>'${since}')(NOTICE_DATE<='${today}')`,
        sortColumns: "NOTICE_DATE",
        sortTypes: "-1",
        map: row => ({
            type: "holder",
            symbol: row.SECURITY_CODE,
            date: day(row.NOTICE_DATE),
            holder: row.HOLDER_NAME || "",
            direction: row.DIRECTION || "",
            shares: Math.abs(row.CHANGE_NUM),
            floatRatio: row.CHANGE_FREE_RATIO
        })
    }),
    // 大宗交易：每笔成交额与溢价率，按股票汇总
    block: (symbols, _today, since) => ({
        reportName: "RPT_DATA_BLOCKTRADE",
        columns: "SECURITY_CODE,TRADE_DATE,DEAL_AMT,PREMIUM_RATIO",
        filter: `${inFilter("SECURITY_CODE", symbols)}(TRADE_DATE='${since}')`,
        sortColumns: "DEAL_AMT",
        sortTypes: "-1",
        map: row => ({ type: "block", symbol: row.SECURITY_CODE, date: day(row.TRADE_DATE), amount: row.DEAL_AMT, premium: row.PREMIUM_RATIO })
    }),
    // 融资融券：融资净买入与融资余额（元）
    margin: (symbols, _today, since) => ({
        reportName: "RPTA_WEB_RZRQ_GGMX",
        columns: "SCODE,DATE,RZYE,RZJME",
        filter: `${inFilter("SCODE", symbols)}(DATE='${since}')`,
        sortColumns: "SCODE",
        sortTypes: "1",
        map: row => {
            const before = row.RZYE - row.RZJME;
            const ratio = before > 0 ? row.RZJME / before : null;
            if (!Number.isFinite(ratio) || Math.abs(ratio) < MARGIN_MIN_RATIO) return null;
            return { type: "margin", symbol: row.SCODE, date: day(row.DATE), net: row.RZJME, balance: row.RZYE, ratio };
        }
    })
};

// 同一只股票当天的多笔大宗交易合并为一条：笔数、合计成交额、按成交额加权的平均溢价率
function mergeBlockTrades(events) {
    const merged = new Map();
    for (const event of events) {
        const current = merged.get(event.symbol) || { type: "block", symbol: event.symbol, date: event.date, count: 0, amount: 0, weighted: 0 };
        current.count++;
        current.amount += event.amount || 0;
        current.weighted += (event.amount || 0) * (event.premium || 0);
        merged.set(event.symbol, current);
    }
    return [...merged.values()].map(({ weighted, ...event }) => ({ ...event, premium: event.amount ? weighted / event.amount : 0 }));
}

// 每只股票的事件按提醒顺序排列：先提前提醒（解禁、披露），再新发生的
const TYPE_ORDER = ["lift", "report", "forecast", "holder", "block", "margin"];

function groupEvents(events) {
    const bySymbol = new Map();
    for (const event of events) {
        if (!bySymbol.has(event.symbol)) bySymbol.set(event.symbol, []);
        bySymbol.get(event.symbol).push(event);
    }
    for (const [symbol, list] of bySymbol) {
        const holders = list.filter(event => event.type === "holder").slice(0, MAX_HOLDER_EVENTS);
        const others = list.filter(event => event.type !== "holder");
        bySymbol.set(symbol, [...others, ...holders].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)));
    }
    return bySymbol;
}

function createStockEventService({ httpClient, requestWithRetry }) {
    async function query({ reportName: name, columns, filter, sortColumns, sortTypes }) {
        const response = await requestWithRetry(() => httpClient.get(DC_URL, {
            params: { reportName: name, columns, filter, pageNumber: 1, pageSize: 500, sortColumns, sortTypes, source: "WEB", client: "WEB" },
            headers: { "User-Agent": BROWSER_USER_AGENT, "Referer": "https://data.eastmoney.com/" }
        }), 2, 500);
        const data = response.data || {};
        // 查不到数据时 result 为 null（code 9201），不算失败
        if (!data.result) {
            if (data.success === false && data.code !== 9201) throw new Error(`${name}：${data.message || data.code}`);
            return [];
        }
        return data.result.data || [];
    }

    // 返回 Map(代码 → 事件列表)；某张报表失败只少这一类事件，不影响收盘报告
    async function getEvents(symbols, dateStr) {
        if (!symbols.length) return new Map();
        const since = previousWeekday(dateStr);
        const kinds = Object.keys(PARSERS);
        const results = await Promise.allSettled(kinds.map(async kind => {
            const spec = PARSERS[kind](symbols, dateStr, since);
            return (await query(spec)).map(spec.map).filter(Boolean);
        }));
        const events = [];
        results.forEach((result, index) => {
            if (result.status === "fulfilled") events.push(...(kinds[index] === "block" ? mergeBlockTrades(result.value) : result.value));
            else console.error(`⚠️ 自选股事件（${kinds[index]}）获取失败：${formatError(result.reason)}`);
        });
        return groupEvents(events);
    }

    return { getEvents };
}

module.exports = { MARGIN_MIN_RATIO, createStockEventService, mergeBlockTrades, previousWeekday, reportName };
