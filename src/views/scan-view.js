const { STYLE_LABELS, STYLE_ORDER, TELEGRAM_TEXT_LIMIT } = require("../constants");
const { MAX_ENTITIES, entityCount, visibleLength } = require("../lib/telegram-text");
const { formatOverviewRow, formatStockCaption } = require("./daily-report-view");
const { escapeHtml, number, signed } = require("./format");
const { STOCK_LINK_LEGEND, StockLink } = require("./stock-link");

// A股扫描的展示：结论文字、分类总览图说明、可操作标的个股图
// 图表字体仅含部分ASCII字母（无J/Q），标题需避开这些字符
const STYLE_CHART_TITLES = {
    intraday: "INTRADAY PICKS",
    short: "SHORT TERM PICKS",
    swing: "SWING PICKS",
    mid: "MID TERM PICKS"
};
const SIGNAL_RANK = {
    "条件性试仓": 2,
    "等待企稳后试仓": 1
};

function isActionable(report) {
    return Boolean(report && SIGNAL_RANK[report.plan.recommendation]);
}

function rankActionable(reports) {
    return reports
        .filter(isActionable)
        .sort((a, b) =>
            SIGNAL_RANK[b.plan.recommendation] - SIGNAL_RANK[a.plan.recommendation] ||
            b.plan.rewardRisk - a.plan.rewardRisk
        );
}

function marketTone(longhiData) {
    const up = (longhiData.riseStocks || []).length;
    const down = (longhiData.declineStocks || []).length;
    // 涨跌停榜单按页拉取有上限，触顶时只能给出下限
    const upText = `${longhiData.riseCapped ? "≥" : ""}${up}`;
    const downText = `${longhiData.declineCapped ? "≥" : ""}${down}`;
    if (!up && !down) return null;
    let tone = "中性";
    if (up >= Math.max(down, 1) * 3) tone = "偏强，可适度参与";
    else if (down >= up) tone = "偏弱，宜轻仓防守";
    return `涨停${upText}家／跌停${downText}家，情绪${tone}`;
}

function adviceLines(picksByStyle, longhiData, withReasons = true) {
    const reports = STYLE_ORDER.flatMap(style => picksByStyle[style] || []).map(pick => pick.report).filter(Boolean);
    const actionable = rankActionable(reports);
    const lines = ["<b>🧭 今日结论</b>"];
    const tone = marketTone(longhiData);
    if (tone) lines.push(`市场：${tone}`);
    if (!actionable.length) {
        lines.push(reports.length
            ? `入选${reports.length}只均未出现入场信号，建议观望、控制仓位，等待回踩企稳或放量突破。`
            : "今日没有符合条件的标的，建议观望。");
        return lines;
    }
    lines.push(`可操作${actionable.length}只（按信号强度、盈亏比排序）：`);
    actionable.forEach((report, index) => {
        const { meta, plan } = report;
        lines.push(
            `${index + 1}. ${StockLink.of(meta).html()}［${STYLE_LABELS[report.style]}］<b>${plan.recommendation}</b>`,
            `　回踩 ${number(plan.entryLow)}～${number(plan.entryHigh)}｜突破 ${number(plan.breakoutTrigger)}｜止损 ${number(plan.stop)}｜目标 ${number(plan.target)}｜盈亏比 ${number(plan.rewardRisk)}:1`,
            ...(withReasons ? [`　${escapeHtml(plan.reason)}`] : [])
        );
    });
    const watching = reports.length - actionable.length;
    if (watching) lines.push(`其余${watching}只暂以观望为主。`);
    return lines;
}

function pickLine(pick, index) {
    const { item, report } = pick;
    const head = `${index + 1}. ${StockLink.of(item).html()}`;
    if (!report) return `${head} ${item.gap}｜K线数据不足，未生成建议`;
    const { analysis, plan } = report;
    const heat = plan.overheated ? "｜⚠️偏热" : "";
    return `${head} ${signed(analysis.latest.changePct)}｜量比${number(analysis.volumeRatio)}x｜<b>${plan.recommendation}</b>${heat}`;
}

function marketListLine(title, items, pickedSymbols, limit) {
    const rest = (items || []).filter(item => !pickedSymbols.has(item.symbol));
    if (!rest.length) return null;
    // 热点只是行情概览，名称用纯文本，避免每只股票两个链接撑满Telegram的格式实体上限
    const names = rest.slice(0, limit).map(item => `${StockLink.of(item).text()}${signed(item.changePct)}`);
    const more = rest.length > limit ? ` 等${rest.length}只` : "";
    return `${title}：${names.join("、")}${more}`;
}

function formatScanSummary({ now, picksByStyle, longhiData = {} }) {
    const pickedSymbols = new Set(
        STYLE_ORDER.flatMap(style => picksByStyle[style] || []).map(pick => pick.item.symbol)
    );
    const styleLines = ["<b>📋 分类入选</b>"];
    for (const style of STYLE_ORDER) {
        const picks = picksByStyle[style] || [];
        styleLines.push(`<b>${STYLE_LABELS[style]}</b>`);
        styleLines.push(picks.length ? picks.map(pickLine).join("\n") : "无符合条件标的");
    }
    const marketLines = [
        marketListLine("📈 涨停", longhiData.riseStocks, pickedSymbols, 6),
        marketListLine("📉 跌停", longhiData.declineStocks, pickedSymbols, 6)
    ].filter(Boolean);
    const build = ({ withReasons, withMarket }) => [
        `<b>A股扫描</b>｜${escapeHtml(now)}`,
        adviceLines(picksByStyle, longhiData, withReasons).join("\n"),
        styleLines.join("\n"),
        ...(withMarket && marketLines.length ? [["<b>🔥 市场热点（不含已入选）</b>", ...marketLines].join("\n")] : []),
        `<i>${STOCK_LINK_LEGEND}。以上由程序按公开行情规则生成，仅供参考，不构成投资建议；请结合自身风险承受能力决策。</i>`
    ].join("\n\n");

    // 超长或格式实体过多时按整段舍弃次要内容，避免截断HTML标签导致Telegram解析失败
    for (const options of [
        { withReasons: true, withMarket: true },
        { withReasons: true, withMarket: false },
        { withReasons: false, withMarket: false }
    ]) {
        const text = build(options);
        if (visibleLength(text) <= TELEGRAM_TEXT_LIMIT && entityCount(text) <= MAX_ENTITIES) return text;
    }
    throw new Error("扫描结论超过Telegram 4096字符或100个格式实体的限制");
}

function formatScanOverviewCaption(style, reports, date) {
    return [`<b>${STYLE_LABELS[style]}入选｜${escapeHtml(date)}</b>`, ...reports.map(formatOverviewRow)].join("\n");
}

function formatScanDelivery({ picksByStyle, date }) {
    const overviews = [];
    for (const style of STYLE_ORDER) {
        const reports = (picksByStyle[style] || []).map(pick => pick.report).filter(Boolean);
        if (!reports.length) continue;
        overviews.push({
            style,
            title: STYLE_CHART_TITLES[style],
            caption: formatScanOverviewCaption(style, reports, date),
            filename: `scan-${style}-${date}.png`,
            reports
        });
    }
    const reports = STYLE_ORDER.flatMap(style => picksByStyle[style] || []).map(pick => pick.report).filter(Boolean);
    const stocks = rankActionable(reports).map(report => ({
        caption: formatStockCaption(report, date),
        filename: `scan-${report.meta.symbol}-${date}.png`,
        report
    }));
    return { overviews, stocks };
}

module.exports = {
    STYLE_LABELS,
    formatScanDelivery,
    formatScanSummary,
    rankActionable
};
