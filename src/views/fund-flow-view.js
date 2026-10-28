const { escapeHtml, signed } = require("./format");
const { StockLink } = require("./stock-link");

// 资金异动推送：图表（区间主力净额变化条形图）+ 图片说明（概况、命中的自选股）+ 股票名称按钮；
// 图表生成失败时退回文字版
const SOURCE_NOTE = "主力净流入为东方财富按超大单、大单估算的数据，非交易所官方口径；仅供参考，不构成投资建议。";
const OPT_OUT_NOTE = "发送 /flow off 可关闭资金异动提醒。";
const KEYBOARD_COLUMNS = 4;

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

function watchedRows({ inflow, outflow, watchSymbols = new Set() }) {
    return [...inflow, ...outflow].filter(row => watchSymbols.has(row.symbol));
}

function formatFundFlowCaption(content) {
    const lines = [`<b>🚨 ${escapeHtml(titleText(content))}</b>`, summaryText(content)];
    const watched = watchedRows(content);
    if (watched.length) {
        lines.push(`⭐ 自选股：${watched.map(row => `${escapeHtml(row.name)} <b>${deltaText(row)}</b>`).join("，")}`);
    }
    lines.push(`<i>点下方股票名称打开东方财富行情（🔺流入 🔻流出）。${SOURCE_NOTE}${OPT_OUT_NOTE}</i>`);
    return lines.join("\n");
}

function chunk(items, size) {
    const rows = [];
    for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
    return rows;
}

// 图片下方的股票按钮：流入在前、流出另起一行，顺序与图中一致；自选股名称前加 ⭐
function formatFundFlowKeyboard({ inflow, outflow, watchSymbols = new Set() }) {
    const button = mark => row => ({
        text: `${watchSymbols.has(row.symbol) ? "⭐" : mark}${row.name}`,
        url: StockLink.of(row).appUrl("eastmoney")
    });
    return {
        inline_keyboard: [
            ...chunk(inflow.map(button("🔺")), KEYBOARD_COLUMNS),
            ...chunk(outflow.map(button("🔻")), KEYBOARD_COLUMNS)
        ]
    };
}

// 文字版（图表生成失败时的后备）：每只股票一行，区间变化放在最前面
function textLine(row, index, watchSymbols) {
    const star = watchSymbols.has(row.symbol) ? "⭐" : "";
    return `${index + 1}. <b>${deltaText(row)}</b> ${star}${StockLink.of(row).html()} ${signed(row.changePct)}`;
}

function formatFundFlowAlert(content) {
    const { inflow, outflow, watchSymbols = new Set() } = content;
    const lines = [`<b>🚨 ${escapeHtml(titleText(content))}</b>`, summaryText(content)];
    if (inflow.length) lines.push("", "<b>🔺 主力加速流入</b>", ...inflow.map((row, index) => textLine(row, index, watchSymbols)));
    if (outflow.length) lines.push("", "<b>🔻 主力加速流出</b>", ...outflow.map((row, index) => textLine(row, index, watchSymbols)));
    lines.push("", `<i>${SOURCE_NOTE}${OPT_OUT_NOTE}</i>`);
    return lines.join("\n");
}

module.exports = {
    SOURCE_NOTE,
    deltaText,
    formatFundFlowAlert,
    formatFundFlowCaption,
    formatFundFlowKeyboard,
    signedAmount,
    summaryText,
    titleText
};
