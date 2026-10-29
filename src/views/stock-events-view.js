const { escapeHtml } = require("./format");
const { signedAmount } = require("./fund-flow-view");
const { amountText } = require("./volume-spike-view");

// 自选股事件在收盘报告里的一句话写法（日期写月-日）
function monthDay(date) {
    return String(date || "").slice(5, 10);
}

function ratioText(value, digits = 1) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
}

function rangeText(lower, upper) {
    const pct = value => `${value >= 0 ? "+" : ""}${Math.round(value)}%`;
    if (Number.isFinite(lower) && Number.isFinite(upper)) return lower === upper ? pct(lower) : `${pct(lower)}～${pct(upper)}`;
    if (Number.isFinite(lower)) return pct(lower);
    return Number.isFinite(upper) ? pct(upper) : "";
}

const FORMATTERS = {
    lift: event => `🔓${monthDay(event.date)}解禁${Math.round(event.shares)}万股（占流通${ratioText(event.floatRatio)}，约${amountText(event.marketCap)}）`,
    report: event => `📅${monthDay(event.date)}披露${event.name}`,
    forecast: event => {
        const range = rangeText(event.lower, event.upper);
        return `📈${monthDay(event.date)}发布${event.name}预告：${event.predictType}${range ? `，${event.finance}同比${range}` : ""}`;
    },
    holder: event => `👤${monthDay(event.date)}${event.holder}${event.direction}${Number(event.shares.toFixed(2))}万股${Number.isFinite(event.floatRatio) ? `（占流通${event.floatRatio}%）` : ""}`,
    block: event => `💼${monthDay(event.date)}大宗交易${event.count > 1 ? `${event.count}笔` : ""}${amountText(event.amount)}，${event.premium >= 0 ? "溢价" : "折价"}${ratioText(Math.abs(event.premium))}`,
    margin: event => `💳${monthDay(event.date)}融资净${event.net >= 0 ? "买入" : "偿还"}${signedAmount(Math.abs(event.net)).replace(/^\+/, "")}（余额${event.ratio >= 0 ? "+" : "-"}${ratioText(Math.abs(event.ratio))}）`
};

function eventText(event) {
    const format = FORMATTERS[event.type];
    return format ? format(event) : "";
}

// 报告里的事件行（纯文本，已转义）；没有事件时为空字符串
function eventsLine(events = []) {
    const texts = events.map(eventText).filter(Boolean);
    return texts.length ? `⚠️ ${escapeHtml(texts.join("；"))}` : "";
}

module.exports = { eventText, eventsLine };
