const { visibleLength } = require("../lib/telegram-text");
const { PHOTO_CAPTION_LIMIT } = require("../constants");
const { escapeHtml } = require("./format");
const { signedAmount } = require("./fund-flow-view");
const { shortSeatName } = require("./longhu-view");
const { StockLink } = require("./stock-link");

// 今日游资动向：游资（不含机构、沪深股通）净买入排行，附营业部近一年上榜后3日的表现
const HIGH_WIN_RATE = 60; // 上涨概率（%）
const HIGH_WIN_MIN_TIMES = 20; // 样本太少的胜率不可靠
const STOCKS_PER_SEAT = 3;
const RANK_MARKS = ["🥇", "🥈", "🥉"];
const NOTE = `胜率＝近一年买入上榜后3日上涨的比例（东方财富统计），🏆为胜率≥${HIGH_WIN_RATE}%且上榜≥${HIGH_WIN_MIN_TIMES}次；不含机构与沪深股通。仅供参考，不构成投资建议。/longhu off 可关闭`;

function isHighWinRate(stats) {
    return Boolean(stats) && stats.riseProbability >= HIGH_WIN_RATE && stats.times >= HIGH_WIN_MIN_TIMES;
}

function seatLabel(seat) {
    return `${isHighWinRate(seat.stats) ? "🏆" : ""}${shortSeatName(seat.name)}`;
}

// 胜率62%（85次）：次数让人判断样本大小；新营业部没有统计
function statsText(stats) {
    if (!stats || !Number.isFinite(stats.riseProbability)) return "暂无近一年统计";
    return `胜率${Math.round(stats.riseProbability)}%（${stats.times}次）`;
}

function boughtStocks(seat, limit = STOCKS_PER_SEAT) {
    return seat.stocks.filter(stock => stock.net > 0).slice(0, limit);
}

function titleText({ date }) {
    return `今日游资动向｜${date}`;
}

function summaryText({ seats, totalSeats }) {
    return `游资净买入前${seats.length}（共${totalSeats}家游资营业部上榜，不含机构与沪深股通）`;
}

// 手机上每家固定两行：① 名次 营业部 净买入；② 胜率 · 买入的股票（名称可跳转App，金额看图）。
// 高胜率一段本身都是🏆，名称前不再重复标注
function seatLines(seat, index, { links, app, stockLimit, trophy = true }) {
    const mark = RANK_MARKS[index] || `${index + 1}.`;
    const stocks = boughtStocks(seat, stockLimit)
        .map(stock => (links ? new StockLink(stock.symbol, stock.name, app).html({ code: false }) : escapeHtml(stock.name)))
        .join("、");
    return [
        `${mark} <b>${escapeHtml(trophy ? seatLabel(seat) : shortSeatName(seat.name))}</b>  ${signedAmount(seat.net)}`,
        `　${statsText(seat.stats)}${stocks ? ` · ${stocks}` : ""}`
    ].join("\n");
}

// 高胜率游资放在前面（参考价值更大）；当天没有时注明，避免以为漏推
function formatHotMoneyText(content, { links = true, app, stockLimit = STOCKS_PER_SEAT, highWinStockLimit = STOCKS_PER_SEAT, highWinCount = Infinity } = {}) {
    const highWin = (content.highWinSeats || []).slice(0, highWinCount);
    return [
        `<b>🐯 今日游资动向｜${escapeHtml(String(content.date).slice(5))}</b>`,
        "",
        "<b>🏆 高胜率游资出手</b>",
        ...(highWin.length
            ? highWin.map((seat, index) => seatLines(seat, index, { links, app, stockLimit: highWinStockLimit, trophy: false }))
            : ["今日没有高胜率游资净买入"]),
        "",
        `<b>💰 游资净买入 Top${content.seats.length}</b>（${content.totalSeats}家上榜）`,
        ...content.seats.map((seat, index) => seatLines(seat, index, { links, app, stockLimit })),
        "",
        `<i>${NOTE}</i>`
    ].join("\n");
}

// 图片说明有1024字上限：超长时先减少净买入排行每家列出的股票数，再减少高胜率游资的股票数，最后减少高胜率游资家数
function formatHotMoneyCaption(content, { app } = {}) {
    const attempts = [];
    for (let stockLimit = STOCKS_PER_SEAT; stockLimit >= 0; stockLimit--) attempts.push({ stockLimit, highWinStockLimit: STOCKS_PER_SEAT });
    for (let highWinStockLimit = STOCKS_PER_SEAT - 1; highWinStockLimit >= 1; highWinStockLimit--) attempts.push({ stockLimit: 0, highWinStockLimit });
    for (let highWinCount = (content.highWinSeats || []).length - 1; highWinCount >= 0; highWinCount--) attempts.push({ stockLimit: 0, highWinStockLimit: 1, highWinCount });
    for (const options of attempts) {
        const caption = formatHotMoneyText(content, { ...options, app });
        if (visibleLength(caption) <= PHOTO_CAPTION_LIMIT) return caption;
    }
    return formatHotMoneyText(content, { app, stockLimit: 0, highWinStockLimit: 0, highWinCount: 0 });
}

module.exports = {
    boughtStocks,
    formatHotMoneyCaption,
    formatHotMoneyText,
    isHighWinRate,
    seatLabel,
    statsText,
    summaryText,
    titleText
};
