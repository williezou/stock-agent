const { deltaText, signedAmount, sourceNote, summaryText, titleText } = require("../fund-flow-view");
const { generateRankedChart, pctText } = require("./ranked-chart");

// 资金异动图表：主力加速流入/加速流出，条长与右侧数字为区间主力净额变化，第二行为全天主力净额与占比
function generateFundFlowChart(content) {
    return generateRankedChart({
        title: titleText(content),
        subtitle: `${summaryText(content)}｜数值为区间主力净额变化`,
        footer: sourceNote(content.source),
        sections: [
            { title: "主力加速流入", rows: content.inflow, up: true },
            { title: "主力加速流出", rows: content.outflow, up: false }
        ],
        detail: row => `${row.symbol}  全天${signedAmount(row.mainNet)}${Number.isFinite(row.mainRatio) ? `（${pctText(row.mainRatio)}）` : ""}`,
        value: deltaText,
        magnitude: row => Math.abs(row.delta)
    });
}

module.exports = { generateFundFlowChart };
