const { escapeHtml, signed } = require("./format");
const { signedAmount } = require("./fund-flow-view");
const { StockLink } = require("./stock-link");

// 量价异动推送（纯文字）：每只股票一行，含触发时间、回看时段内的涨跌幅变化与成交额、当日涨跌幅；名称可跳转东方财富App
const OPT_OUT_NOTE = "/spike off 关闭提醒";

// 回看时段内的成交额（总为正，不带符号）
function amountText(value) {
    return signedAmount(value).replace(/^\+/, "");
}

// 沪市为上交所官方行情，深市为新浪财经行情
function sourceNote(sources = {}) {
    const parts = [sources["上交所"] && "沪市上交所", sources["新浪"] && "深市新浪财经"].filter(Boolean);
    return `行情：${parts.join("、") || "交易所"}；仅供参考，不构成投资建议`;
}

function titleText({ label, since, time }) {
    return `${label}量价异动｜${since}-${time}`;
}

// 分段标题带只数，超过推送上限时注明只列前几只
function sectionTitle(emoji, title, total, rows) {
    return `<b>${emoji} ${title}</b> ${total > rows.length ? `${total}只（列前${rows.length}）` : `${total}只`}`;
}

// 每只股票一行：触发时间、名称（自选股加 ⭐）、回看时段内的涨跌幅变化（加粗）、这段时间的成交额、当日涨跌幅
function stockLine(row, watchSymbols) {
    const star = watchSymbols.has(row.symbol) ? "⭐" : "";
    const stock = new StockLink(row.symbol, row.name).html({ code: false });
    return `<code>${row.time}</code> ${star}${stock} <b>${signed(row.windowChange)}</b> 成交${amountText(row.windowAmount)} 今日${signed(row.changePct)}`;
}

function formatVolumeSpikeAlert(content) {
    const { up, down, upTotal = up.length, downTotal = down.length, watchSymbols = new Set() } = content;
    const lines = [`<b>⚡ ${escapeHtml(titleText(content))}</b>`];
    if (up.length) lines.push("", sectionTitle("🔺", "急涨放量", upTotal, up), ...up.map(row => stockLine(row, watchSymbols)));
    if (down.length) lines.push("", sectionTitle("🔻", "急跌放量", downTotal, down), ...down.map(row => stockLine(row, watchSymbols)));
    lines.push("", `<i>加粗为${content.lookbackMinutes}分钟内涨跌幅变化，成交额为这段时间的成交，点名称打开东方财富。${sourceNote(content.sources)}。${OPT_OUT_NOTE}</i>`);
    return lines.join("\n");
}

module.exports = { formatVolumeSpikeAlert };
