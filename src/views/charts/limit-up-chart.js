const { signed } = require("../format");
const { FIRST_BOARD_IN_CHART, countsText, summarizeLimitUp, titleText } = require("../limit-up-view");
const { amountText } = require("../volume-spike-view");
const { COLORS, generateRankedChart } = require("./ranked-chart");

// 涨停复盘图表：每个连板层级一段（最高板金色，其余红色），最后是首板封单前几名；
// 第二行为代码、行业、首次封板时间与炸板次数，条形与右侧数字为收盘封单金额（涨跌幅都是涨停价，不再标注）
function generateLimitUpChart(content) {
    const summary = summarizeLimitUp(content);
    const sections = summary.ladder.map((level, index) => ({
        title: `${level.boards}连板（${level.stocks.length}只）`,
        rows: level.stocks,
        ...(index === 0 ? { color: COLORS.gold } : { up: true })
    }));
    if (summary.firstBoard.length) {
        sections.push({ title: `首板封单前${Math.min(FIRST_BOARD_IN_CHART, summary.firstBoard.length)}（共${summary.firstBoard.length}只）`, rows: summary.firstBoard.slice(0, FIRST_BOARD_IN_CHART), up: true });
    }
    return generateRankedChart({
        title: titleText(content),
        // 副标题一行放不下“上涨几只”，图上只留平均涨跌幅
        subtitle: [countsText(summary), summary.yesterdayCount ? `昨日涨停今日均${signed(summary.yesterdayAvg)}` : ""].filter(Boolean).join("｜"),
        footer: "数据：东方财富涨停板行情；条形与数字为收盘封单金额；仅供参考，不构成投资建议。",
        sections,
        badge: () => null,
        detail: stock => `${stock.symbol}  ${stock.industry}  首封${stock.firstTime}${stock.breaks ? `  炸板${stock.breaks}次` : ""}`,
        value: stock => amountText(stock.sealAmount),
        magnitude: stock => stock.sealAmount || 0
    });
}

module.exports = { generateLimitUpChart };
