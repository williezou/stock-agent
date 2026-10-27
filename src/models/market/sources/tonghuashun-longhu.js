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

// 营业部全称在链接的 title 属性里（显示文字可能被截断）；金额单位为万元
function parseSeatTable(tableHtml) {
    const seats = [];
    for (const row of tableHtml.split("<tr").slice(1)) {
        const name = /title="([^"]+)"/.exec(row)?.[1];
        const amounts = [...row.matchAll(/<td[^>]*>\s*(-?[\d.]+)\s*<\/td>/g)].map(match => toYuan(match[1], "万"));
        if (!name || amounts.length < 3) continue;
        const [buy, sell, net] = amounts;
        seats.push({ name: decodeHtmlEntities(name), buy, sell, net });
    }
    return seats;
}

function seatTableAfter(block, heading) {
    const start = block.indexOf(heading);
    if (start < 0) return [];
    const end = block.indexOf("</table>", start);
    return parseSeatTable(block.slice(start, end < 0 ? undefined : end));
}

// 某只股票当日的龙虎榜席位：每个上榜原因一组（成交额、合计买卖、净额、买入/卖出前5营业部）
function parseThsSeatDetails(html, symbol) {
    const change = new RegExp(`stockcode="${symbol}">[^<]*</a>\\s*<i class="[^"]*">\\s*(-?[\\d.]+)%`).exec(html);
    let name = "";
    const groups = [];
    for (const block of html.split('<div class="stockcont"').slice(1)) {
        const head = block.match(/stockcode="(\d{6})"[\s\S]*?<p>([^<]*?)\((\d{6})\)明细：([^<]*)<\/p>/);
        if (!head || head[1] !== symbol) continue;
        name = name || decodeHtmlEntities(head[2]);
        groups.push({
            reason: decodeHtmlEntities(head[4]),
            dealAmount: amountIn(block, "成交额"),
            buyTotal: amountIn(block, "合计买入"),
            sellTotal: amountIn(block, "合计卖出"),
            netAmount: amountIn(block, "净额"),
            buyers: seatTableAfter(block, "买入金额最大的前5名营业部"),
            sellers: seatTableAfter(block, "卖出金额最大的前5名营业部")
        });
    }
    if (!groups.length) return null;
    return { symbol, name, changePct: change ? Number(change[1]) : NaN, groups };
}

const REPORT_CACHE_TTL_MS = 10 * 60 * 1000;
const REPORT_CACHE_MAX = 5;

function createTonghuashunLonghuSource({ httpClient, requestWithRetry, now = () => Date.now() }) {
    // 按日期缓存页面：席位查询由用户点击触发，多人点击同一天的榜单时不重复下载
    const cache = new Map();

    async function fetchReport(dateStr) {
        const hit = cache.get(dateStr);
        if (hit && now() - hit.at < REPORT_CACHE_TTL_MS) return hit.html;
        const res = await requestWithRetry(() =>
            httpClient.get(`${URL}/${dateStr}/`, {
                responseType: "arraybuffer",
                headers: { "User-Agent": BROWSER_USER_AGENT, "Referer": "https://data.10jqka.com.cn/market/longhu/" }
            })
        );
        // 按响应头声明的字符集解码，同花顺页面为GBK
        const charset = /charset=([\w-]+)/i.exec(res.headers?.["content-type"] || "")?.[1] || "gbk";
        const html = new TextDecoder(charset).decode(Buffer.from(res.data || []));
        // 未发布（null）不缓存，以便发布后能立即取到；既非“无数据”页面也没有明细块，多半是改版或被拦截
        if (html.includes(NO_DATA_TEXT)) return null;
        if (!html.includes("stockcont")) throw new Error("同花顺龙虎榜页面无法识别");
        cache.set(dateStr, { html, at: now() });
        while (cache.size > REPORT_CACHE_MAX) cache.delete(cache.keys().next().value);
        return html;
    }

    async function getBoardByDate(dateStr) {
        const html = await fetchReport(dateStr);
        return html ? parseThsLonghuReport(html, dateStr) : [];
    }

    // 返回null表示该股当日未上榜（或榜单未发布）
    async function getSeatDetails(dateStr, symbol) {
        const html = await fetchReport(dateStr);
        return html ? parseThsSeatDetails(html, symbol) : null;
    }

    return { name: "同花顺", getBoardByDate, getSeatDetails };
}

module.exports = { createTonghuashunLonghuSource, parseThsLonghuReport, parseThsSeatDetails };
