const { amountText, sourceNote, summaryText, titleText } = require("../volume-spike-view");
const { generateRankedChart, pctText } = require("./ranked-chart");

// 量价异动图表：急涨放量/急跌放量，条长与右侧数字为回看时段内的涨跌幅变化；
// 第二行为触发时间、这段时间的成交额与当日涨跌幅（字号大，不放代码以免截断）
function generateVolumeSpikeChart(content) {
    return generateRankedChart({
        title: titleText(content),
        subtitle: `${summaryText(content)}｜条形为${content.lookbackMinutes}分钟内涨跌幅变化`,
        footer: sourceNote(content.sources),
        sections: [
            { title: "急涨放量", rows: content.up, up: true },
            { title: "急跌放量", rows: content.down, up: false }
        ],
        badge: () => null,
        detail: row => `${row.time}  成交${amountText(row.windowAmount)}  今日${pctText(row.changePct)}`,
        value: row => pctText(row.windowChange),
        magnitude: row => Math.abs(row.windowChange)
    });
}

module.exports = { generateVolumeSpikeChart };
