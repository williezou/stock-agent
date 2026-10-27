const { escapeHtml, money, shortText, signed } = require("./format");

// 每日龙虎榜推送：上榜概况 + 净买入/净卖出排行
const TOP_BUY = 10;
const TOP_SELL = 5;
const REASON_MAX_CHARS = 30;

// 交易所上榜原因措辞冗长且沪深北写法不一：先统一措辞，再压缩常见句式，
// 例如“有价格涨跌幅限制的连续3个交易日内收盘价格涨幅偏离值累计达到30%的证券”→“3日涨幅偏离30%”
const REASON_NORMALIZE = [
    [/^.*?(?=连续|当日|日[涨跌换振价收]|日均|严重异常)/, ""], // 去掉“有价格涨跌幅限制的”“非ST、*ST和S证券”“北交所股票”等前缀
    [/连续三个/, "连续3个"],
    [/股票/, "证券"],
    [/的前[五5]只证券/, "的证券"], // 东方财富“前5只证券”与同花顺“的证券”统一
    [/当日/, "日"],
    [/收盘价格?/, ""],
    [/较基准指数/, ""], // 同花顺“涨幅较基准指数偏离值”
    [/价格振幅|振幅值/, "振幅"],
    [/\([+-]?\d+%\)/, ""], // 北交所“+40%(-40%)”写法
    [/[+-](\d+%)/g, "$1"]
];
const REASON_RULES = [
    [/连续(\d+)个交易日内[，,]?日?(涨跌|涨|跌)幅偏离值累计达到?(\d+%)(?:的?证券)?/, "$1日$2幅偏离$3"],
    [/连续(\d+)个交易日内[，,]?日均换手率与前五个交易日的日均换手率的比值达到(\d+)倍.*/, "$1日换手放大$2倍"],
    [/严重异常期间日?(涨|跌)幅偏离值累计达到?(\d+%)(?:的?证券)?/, "严重异常$1幅偏离$2"],
    [/日(涨|跌)幅偏离值达到?(\d+%)的证券/, "日$1幅偏离$2"],
    [/日换手率达到?(\d+%)的证券/, "换手率$1"],
    [/日(涨|跌)幅达到?(\d+%)的证券/, "日$1幅$2"],
    [/日振幅达到?(\d+%)的证券/, "振幅$1"],
    [/退市整理期/, "退市整理"]
];

function rewrite(text, rules) {
    return rules.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

function compactReason(reason) {
    return String(reason || "")
        .split(/[；;]/) // 东方财富用全角分号，同花顺单条原因内用半角分号
        .map(part => rewrite(rewrite(part.trim(), REASON_NORMALIZE), REASON_RULES))
        .filter((part, index, parts) => part && parts.indexOf(part) === index)
        .join("、");
}

function exchangeOf(symbol) {
    const code = String(symbol || "");
    if (code.startsWith("6")) return "沪";
    if (/^[03]/.test(code)) return "深";
    return "北";
}

// 净买入额带符号，单位亿/万元
function signedMoney(value) {
    return `${value >= 0 ? "+" : "-"}${money(Math.abs(value))}`;
}

function boardLine(item, index) {
    const reason = escapeHtml(shortText(compactReason(item.reason), REASON_MAX_CHARS)) || "—";
    return `${index + 1}. <code>${item.symbol}</code> ${escapeHtml(item.name)} ${signed(item.changePct)}｜净额 ${signedMoney(item.netAmount)}\n　${reason}`;
}

function formatLonghuMessage({ date, board }) {
    const counts = { 沪: 0, 深: 0, 北: 0 };
    for (const item of board) counts[exchangeOf(item.symbol)]++;
    const totalNet = board.reduce((sum, item) => sum + item.netAmount, 0);
    const buyers = board.filter(item => item.netAmount > 0).slice(0, TOP_BUY);
    const sellers = board.filter(item => item.netAmount < 0).sort((a, b) => a.netAmount - b.netAmount).slice(0, TOP_SELL);
    const upCount = board.filter(item => item.changePct > 0).length;

    const sections = [
        `<b>🐉 龙虎榜｜${escapeHtml(date)}</b>\n` +
        `上榜${board.length}只（沪${counts.沪} 深${counts.深} 北${counts.北}），上涨${upCount}只｜榜单合计净买入 ${signedMoney(totalNet)}`
    ];
    if (buyers.length) sections.push([`<b>💰 净买入前${buyers.length}</b>`, ...buyers.map(boardLine)].join("\n"));
    if (sellers.length) sections.push([`<b>📉 净卖出前${sellers.length}</b>`, ...sellers.map(boardLine)].join("\n"));
    sections.push(
        "<i>数据来源：沪深北交易所当日公开信息（东方财富整理），仅供参考，不构成投资建议。</i>\n" +
        "<i>发送 /longhu off 可关闭龙虎榜推送。</i>"
    );
    // 最多15行明细，长度远低于Telegram 4096字符上限
    return sections.join("\n\n");
}

module.exports = { compactReason, formatLonghuMessage };
