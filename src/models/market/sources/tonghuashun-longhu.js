const { BROWSER_USER_AGENT } = require("./common");

// 同花顺龙虎榜日报页面（GBK编码的HTML，非官方接口）。每个“股票×上榜原因”一个 stockcont 明细块，
// 块内有上榜原因、成交额与净额；涨跌幅在页面顶部的股票列表里。
// 当日未发布或非交易日时返回只含“没有符合条件的数据”的页面片段
const URL = "https://data.10jqka.com.cn/ifmarket/lhbggxq/report";
// 页面还包含可转债（如118077）等非股票品种；只保留沪深北A股代码，与东方财富口径一致
const A_SHARE_CODE = /^(?:00|30|60|68|4|8|92)\d+$/;
const NO_DATA_TEXT = "没有符合条件的数据";

function decodeHtmlEntities(text) {
    return String(text || "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .trim();
}

function toYuan(value, unit) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return NaN;
    // 取整到元，避免 1.11×1e8 这类浮点误差
    if (unit === "亿") return Math.round(amount * 1e8);
    if (unit === "万") return Math.round(amount * 1e4);
    return Math.round(amount);
}

// 明细块里“成交额：4.70亿元”“净额：<span>3.01</span>亿元”
function amountIn(block, label) {
    const match = block.match(new RegExp(`${label}：\\s*(?:<span[^>]*>)?\\s*(-?[\\d.]+)\\s*(?:</span>)?\\s*(亿|万)?元`));
    return match ? toYuan(match[1], match[2]) : NaN;
}

function parseThsLonghuReport(html, dateStr) {
    const changeBySymbol = new Map();
    for (const match of html.matchAll(/stockcode="(\d{6})">[^<]*<\/a>\s*<i class="[^"]*">\s*(-?[\d.]+)%\s*<\/i>/g)) {
        changeBySymbol.set(match[1], Number(match[2]));
    }

    const bySymbol = new Map();
    for (const block of html.split('<div class="stockcont"').slice(1)) {
        const head = block.match(/stockcode="(\d{6})"[\s\S]*?<p>([^<]*?)\((\d{6})\)明细：([^<]*)<\/p>/);
        if (!head) continue;
        const [, symbol, rawName, , rawReason] = head;
        if (!A_SHARE_CODE.test(symbol)) continue;
        const reason = decodeHtmlEntities(rawReason);
        const netAmount = amountIn(block, "净额");
        const dealAmount = amountIn(block, "成交额");
        const existing = bySymbol.get(symbol);
        if (existing) {
            if (reason && !existing.reason.includes(reason)) existing.reason = `${existing.reason}；${reason}`;
            // 与东方财富口径一致：多次上榜时保留净买入最大的一条（之前未解析到净额时任何有效值都可替换）
            if (Number.isFinite(netAmount) && (!Number.isFinite(existing.netAmount) || netAmount > existing.netAmount)) {
                existing.netAmount = netAmount;
                existing.dealAmount = dealAmount;
            }
            continue;
        }
        bySymbol.set(symbol, {
            symbol,
            name: decodeHtmlEntities(rawName),
            price: NaN,
            changePct: changeBySymbol.get(symbol) ?? NaN,
            turnoverRate: NaN,
            boardDate: dateStr,
            reason,
            netAmount,
            dealAmount
        });
    }
    // 合并完成后，仍未解析到金额的按0处理，保证排序与展示可用
    return [...bySymbol.values()].map(item => ({
        ...item,
        netAmount: Number.isFinite(item.netAmount) ? item.netAmount : 0,
        dealAmount: Number.isFinite(item.dealAmount) ? item.dealAmount : 0
    }));
}

function createTonghuashunLonghuSource({ httpClient, requestWithRetry }) {
    async function getBoardByDate(dateStr) {
        const res = await requestWithRetry(() =>
            httpClient.get(`${URL}/${dateStr}/`, {
                responseType: "arraybuffer",
                headers: { "User-Agent": BROWSER_USER_AGENT, "Referer": "https://data.10jqka.com.cn/market/longhu/" }
            })
        );
        // 按响应头声明的字符集解码，同花顺页面为GBK
        const charset = /charset=([\w-]+)/i.exec(res.headers?.["content-type"] || "")?.[1] || "gbk";
        const html = new TextDecoder(charset).decode(Buffer.from(res.data || []));
        if (html.includes(NO_DATA_TEXT)) return [];
        // 既不是“无数据”页面也没有明细块，多半是页面改版或被拦截，按失败处理以便切换备用源
        if (!html.includes("stockcont")) throw new Error("同花顺龙虎榜页面无法识别");
        return parseThsLonghuReport(html, dateStr);
    }

    return { name: "同花顺", getBoardByDate };
}

module.exports = { createTonghuashunLonghuSource, parseThsLonghuReport };
