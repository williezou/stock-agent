const { escapeHtml, signed } = require("./format");
const { STOCK_LINK_LEGEND, StockLink } = require("./stock-link");

// 资金异动推送：图表（区间主力净额变化条形图）+ 图片说明（概况与股票列表，名称可跳转App）；
// 图表生成失败时退回文字版
const SOURCE_NOTE = "主力净流入为东方财富按超大单、大单估算的数据，非交易所官方口径；仅供参考，不构成投资建议。";
const OPT_OUT_NOTE = "发送 /flow off 可关闭资金异动提醒。";

// 金额紧凑写法：+8.75亿 / -7951万
function signedAmount(value) {
    if (!Number.isFinite(value)) return "—";
    const sign = value >= 0 ? "+" : "-";
    const abs = Math.abs(value);
    return abs >= 1e8 ? `${sign}${(abs / 1e8).toFixed(2)}亿` : `${sign}${Math.round(abs / 1e4)}万`;
}

// 区间变化：起点不在榜单内时是估算的边界（实际变化幅度只会更大）
function deltaText(row) {
    const bound = row.estimated ? (row.delta >= 0 ? "≥" : "≤") : "";
    return `${bound}${signedAmount(row.delta)}`;
}

function titleText({ label, time }) {
    return `${label}资金异动｜${time}`;
}

function summaryText({ since, inflow, outflow }) {
    return `较${since}：主力加速流入${inflow.length}只、加速流出${outflow.length}只`;
}

// 每只股票一行：自选股加 ⭐，名称后的 🔴 🌸 可跳转App，区间变化加粗；detailed 时附当日涨跌幅（文字版没有图表可看）。
// 东方财富的名称里有补齐用的空格（如“五 粮 液”），去掉以免占宽
function stockLine(row, watchSymbols, detailed) {
    const star = watchSymbols.has(row.symbol) ? "⭐" : "";
    const stock = new StockLink(row.symbol, row.name.replace(/\s+/g, "")).html({ code: false });
    return `${star}${stock} <b>${deltaText(row)}</b>${detailed ? ` ${signed(row.changePct)}` : ""}`;
}

function formatFundFlowText(content, detailed) {
    const { inflow, outflow, watchSymbols = new Set() } = content;
    const lines = [`<b>🚨 ${escapeHtml(titleText(content))}</b>`, summaryText(content)];
    if (inflow.length) lines.push("", "<b>🔺 主力加速流入</b>", ...inflow.map(row => stockLine(row, watchSymbols, detailed)));
    if (outflow.length) lines.push("", "<b>🔻 主力加速流出</b>", ...outflow.map(row => stockLine(row, watchSymbols, detailed)));
    lines.push("", `<i>${STOCK_LINK_LEGEND}。${SOURCE_NOTE}${OPT_OUT_NOTE}</i>`);
    return lines.join("\n");
}

// 图片说明：股票列表与图中顺序一致，涨跌幅等明细看图
function formatFundFlowCaption(content) {
    return formatFundFlowText(content, false);
}

// 文字版（图表生成失败时的后备）
function formatFundFlowAlert(content) {
    return formatFundFlowText(content, true);
}

module.exports = {
    SOURCE_NOTE,
    deltaText,
    formatFundFlowAlert,
    formatFundFlowCaption,
    signedAmount,
    summaryText,
    titleText
};
