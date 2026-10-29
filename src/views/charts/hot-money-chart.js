const { signedAmount } = require("../fund-flow-view");
const { boughtStocks, statsText, summaryText, titleText } = require("../hot-money-view");
const { shortSeatName } = require("../longhu-view");
const { COLORS, generateRankedChart } = require("./ranked-chart");

// 游资动向图表：高胜率游资（金色）与游资净买入排行（红色）两段，第二行为胜率与买入的股票（营业部名称较长，胜率不放名称后）。
// 图表字体不含emoji，名称不带🏆
function generateHotMoneyChart(content) {
    return generateRankedChart({
        title: titleText(content),
        subtitle: `高胜率游资${(content.highWinSeats || []).length}家出手｜${summaryText(content).replace(/（.*）/, "")}｜条形与数字为当日净买入`,
        footer: "胜率为该营业部近一年买入上榜后3日上涨比例（东方财富统计）；仅供参考，不构成投资建议。",
        sections: [
            { title: "高胜率游资今日出手", rows: (content.highWinSeats || []).map(seat => ({ ...seat, name: shortSeatName(seat.name) })), color: COLORS.gold },
            { title: "游资净买入", rows: content.seats.map(seat => ({ ...seat, name: shortSeatName(seat.name) })), up: true }
        ],
        nameMaxWidth: Infinity,
        badge: () => null,
        detail: seat => [statsText(seat.stats).replace(/（.*）/, ""), ...boughtStocks(seat).map(stock => `${stock.name}${signedAmount(stock.net)}`)].join("  ")
            + (boughtStocks(seat).length ? "" : "  以卖出为主"),
        value: seat => signedAmount(seat.net),
        magnitude: seat => Math.abs(seat.net)
    });
}

module.exports = { generateHotMoneyChart };
