const { PHOTO_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } = require("../constants");
const { visibleLength } = require("../lib/telegram-text");
const { escapeHtml, linkLine, signed } = require("./format");
const { QuoteApp } = require("./quote-app");
const { StockLink, stockButtonLegend, stockButtonMarkup, stockLinkLegend } = require("./stock-link");
const { amountText } = require("./volume-spike-view");

// 涨停复盘推送：连板梯队图（每个连板层级一段，按封单金额排序）+ 图片说明（涨跌停与炸板家数、封板率、昨日涨停今日表现、
// 梯队与行业概况）+ 图片下方的连板股按钮（打开所选App）与每日总结网页按钮；图表生成失败时退回文字版
const OPT_OUT_NOTE = "/limit off 关闭";
const NOTE = "数据：东方财富涨停板行情；相关公告/新闻为最新一条，不一定是涨停原因；仅供参考，不构成投资建议";
const TOP_INDUSTRIES = 5;
const FIRST_BOARD_IN_CHART = 5;
const MAX_STOCK_BUTTONS = 24;

function percent(value) {
    return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

function bySeal(a, b) {
    return (b.sealAmount || 0) - (a.sealAmount || 0);
}

// 连板梯队：二板及以上按连板数分层（高的在前），层内按封单金额排序；首板单独列出
function ladderOf(limitUp) {
    const levels = new Map();
    for (const stock of limitUp.filter(row => row.boards >= 2)) {
        if (!levels.has(stock.boards)) levels.set(stock.boards, []);
        levels.get(stock.boards).push(stock);
    }
    return [...levels.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([boards, stocks]) => ({ boards, stocks: stocks.sort(bySeal) }));
}

function industriesOf(stocks) {
    const counts = new Map();
    for (const stock of stocks) {
        if (stock.industry) counts.set(stock.industry, (counts.get(stock.industry) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([industry, count]) => ({ industry, count }))
        .sort((a, b) => b.count - a.count || a.industry.localeCompare(b.industry, "zh"));
}

// 复盘统计：封板率 = 涨停 /（涨停 + 炸板）；昨日涨停今日平均涨跌幅反映打板的赚钱效应
function summarizeLimitUp({ limitUp, limitDown, broken, yesterday }) {
    const ladder = ladderOf(limitUp);
    const yesterdayChanges = yesterday.map(row => row.changePct).filter(Number.isFinite);
    return {
        limitUpCount: limitUp.length,
        limitDownCount: limitDown.length,
        brokenCount: broken.length,
        sealRate: limitUp.length + broken.length ? limitUp.length / (limitUp.length + broken.length) : null,
        yesterdayCount: yesterdayChanges.length,
        yesterdayUp: yesterdayChanges.filter(value => value > 0).length,
        yesterdayAvg: yesterdayChanges.length ? yesterdayChanges.reduce((sum, value) => sum + value, 0) / yesterdayChanges.length : null,
        ladder,
        firstBoard: limitUp.filter(row => row.boards < 2).sort(bySeal),
        industries: industriesOf(limitUp)
    };
}

function titleText({ date }) {
    return `涨停复盘｜${String(date).slice(5)}`;
}

function countsText(summary) {
    return `涨停${summary.limitUpCount} 跌停${summary.limitDownCount} 炸板${summary.brokenCount}｜封板率${percent(summary.sealRate)}`;
}

function yesterdayText(summary) {
    if (!summary.yesterdayCount) return "";
    return `昨日涨停今日平均${signed(summary.yesterdayAvg)}（上涨${summary.yesterdayUp}/${summary.yesterdayCount}只）`;
}

function ladderText(summary, nameLimit = 3) {
    if (!summary.ladder.length) return "今日没有连板股";
    const levels = summary.ladder.map(level => `${level.boards}板${level.stocks.length}只`).join(" ");
    const top = summary.ladder[0];
    const names = top.stocks.slice(0, nameLimit).map(stock => stock.name).join("、") + (top.stocks.length > nameLimit ? "等" : "");
    return `连板梯队：${levels}｜最高${top.boards}板：${names}`;
}

function industriesText(summary) {
    const top = summary.industries.slice(0, TOP_INDUSTRIES);
    return top.length ? `涨停行业：${top.map(item => `${item.industry}${item.count}`).join("、")}` : "";
}

function headLines(content) {
    const summary = summarizeLimitUp(content);
    return [
        `<b>🔥 ${escapeHtml(titleText(content))}</b>`,
        countsText(summary),
        yesterdayText(summary),
        escapeHtml(ladderText(summary)),
        escapeHtml(industriesText(summary))
    ].filter(Boolean);
}

// 图片说明：概况，股票在图片下方的按钮里
function formatLimitUpCaption(content, { app = QuoteApp.DEFAULT } = {}) {
    const caption = [...headLines(content), `<i>图为连板股（按封单金额排序）；${stockButtonLegend(app)}。${OPT_OUT_NOTE}</i>`].join("\n");
    return visibleLength(caption) <= PHOTO_CAPTION_LIMIT ? caption : headLines(content).slice(0, 4).join("\n");
}

// 图片下方：连板股按钮（标几板，顺序与图一致）+ 每日总结网页按钮
function limitUpKeyboard(content, { app = QuoteApp.DEFAULT, pageUrl = null } = {}) {
    const groups = [];
    let remaining = MAX_STOCK_BUTTONS;
    for (const level of summarizeLimitUp(content).ladder) {
        const rows = level.stocks.slice(0, remaining);
        if (!rows.length) break;
        groups.push({ mark: `${level.boards}板`, rows });
        remaining -= rows.length;
    }
    const markup = stockButtonMarkup(groups, { app, columns: 3 });
    if (pageUrl) markup.inline_keyboard.push([{ text: "📄 打开今日总结", url: pageUrl }]);
    return markup;
}

// 连板股一行：名称（可跳转）、首次封板时间、炸板次数、封单金额；下一行为相关公告/新闻
function stockLine(stock, { app, catalysts }) {
    const breaks = stock.breaks ? ` 炸板${stock.breaks}次` : "";
    const line = `${new StockLink(stock.symbol, stock.name, app).html({ code: false })} ${escapeHtml(stock.industry)} 首封${stock.firstTime}${breaks} 封单${amountText(stock.sealAmount)}`;
    const catalyst = catalysts && catalysts[stock.symbol];
    return catalyst ? `${line}\n　📰 ${linkLine(catalyst)}` : line;
}

// 文字版（图表生成失败时的后备）：概况 + 连板梯队（附相关公告/新闻）；超长时去掉公告/新闻
function formatLimitUpText(content, { app = QuoteApp.DEFAULT } = {}) {
    const summary = summarizeLimitUp(content);
    const build = catalysts => [
        ...headLines(content),
        ...summary.ladder.flatMap(level => ["", `<b>${level.boards}连板（${level.stocks.length}只）</b>`, ...level.stocks.map(stock => stockLine(stock, { app, catalysts }))]),
        "",
        `<i>${stockLinkLegend(app)}。${NOTE}。${OPT_OUT_NOTE}</i>`
    ].join("\n");
    const text = build(content.catalysts);
    return visibleLength(text) <= TELEGRAM_TEXT_LIMIT ? text : build(null);
}

module.exports = {
    FIRST_BOARD_IN_CHART,
    NOTE,
    countsText,
    formatLimitUpCaption,
    formatLimitUpText,
    industriesText,
    ladderText,
    limitUpKeyboard,
    stockLine,
    summarizeLimitUp,
    titleText,
    yesterdayText
};
