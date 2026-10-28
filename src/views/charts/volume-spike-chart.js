const { amountText, sourceNote, summaryText, titleText } = require("../volume-spike-view");
const { generateRankedChart, pctText } = require("./ranked-chart");

// 量价异动图表：急涨放量/急跌放量，条长与右侧数字为回看时段内的涨跌幅变化，第二行为这段时间的成交额
function generateVolumeSpikeChart(content) {
    return generateRankedChart({
        title: titleText(content),
        subtitle: `${summaryText(content)}｜条形与右侧数字为近${content.minutes}分钟涨跌幅变化`,
        footer: sourceNote(content.sources),
        sections: [
            { title: "急涨放量", rows: content.up, up: true },
            { title: "急跌放量", rows: content.down, up: false }
        ],
        detail: row => `近${content.minutes}分钟成交${amountText(row.windowAmount)}`,
        value: row => pctText(row.windowChange),
        magnitude: row => Math.abs(row.windowChange)
    });
}

module.exports = { generateVolumeSpikeChart };
