const { escapeHtml, signed } = require("./format");
const { signedAmount } = require("./fund-flow-view");
const { STOCK_LINK_LEGEND, StockLink } = require("./stock-link");

// 量价异动推送：图表（回看时段内的涨跌幅变化与成交额）+ 图片说明（概况与股票列表，名称可跳转App）；图表生成失败时退回文字版
const OPT_OUT_NOTE = "发送 /flow off 可关闭盘中异动提醒。";

// 回看时段内的成交额（总为正，不带符号）
function amountText(value) {
    return signedAmount(value).replace(/^\+/, "");
}

// 沪市为上交所官方行情，深市为新浪财经行情
function sourceNote(sources = {}) {
    const parts = [sources["上交所"] && "沪市：上交所行情", sources["新浪"] && "深市：新浪财经行情"].filter(Boolean);
    return `数据来源：${parts.join("，") || "交易所行情"}；仅供参考，不构成投资建议。`;
}

function titleText({ label, time }) {
    return `${label}量价异动｜${time}`;
}

function summaryText({ minutes, up, down }) {
    return `近${minutes}分钟：急涨放量${up.length}只、急跌放量${down.length}只`;
}

// 每只股票一行：自选股加 ⭐，名称可跳转东方财富，回看时段内的涨跌幅变化加粗，附这段时间的成交额；detailed 时附当日涨跌幅
function stockLine(row, watchSymbols, detailed) {
    const star = watchSymbols.has(row.symbol) ? "⭐" : "";
    const stock = new StockLink(row.symbol, row.name.replace(/\s+/g, "")).html({ code: false });
    return `${star}${stock} <b>${signed(row.windowChange)}</b> 成交${amountText(row.windowAmount)}${detailed ? `（现${signed(row.changePct)}）` : ""}`;
}

function formatVolumeSpikeText(content, detailed) {
    const { up, down, watchSymbols = new Set() } = content;
    const lines = [`<b>⚡ ${escapeHtml(titleText(content))}</b>`, summaryText(content)];
    if (up.length) lines.push("", "<b>🔺 急涨放量</b>", ...up.map(row => stockLine(row, watchSymbols, detailed)));
    if (down.length) lines.push("", "<b>🔻 急跌放量</b>", ...down.map(row => stockLine(row, watchSymbols, detailed)));
    lines.push("", `<i>${STOCK_LINK_LEGEND}。${sourceNote(content.sources)}${OPT_OUT_NOTE}</i>`);
    return lines.join("\n");
}

function formatVolumeSpikeCaption(content) {
    return formatVolumeSpikeText(content, false);
}

function formatVolumeSpikeAlert(content) {
    return formatVolumeSpikeText(content, true);
}

module.exports = { amountText, formatVolumeSpikeAlert, formatVolumeSpikeCaption, sourceNote, summaryText, titleText };
