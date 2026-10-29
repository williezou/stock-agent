const { COLORS, Raster, encodePng } = require("./raster");

// 股票图表：个股30日K线详图（右侧为筹码分布）与每页两只股票的总览卡片图
function rollingAverage(rows, period, field) {
    return rows.map((_, index) => {
        if (index + 1 < period) return null;
        const window = rows.slice(index - period + 1, index + 1);
        return window.reduce((sum, row) => sum + row[field], 0) / period;
    });
}

function rollingBollinger(rows, period = 20) {
    return rows.map((_, index) => {
        if (index + 1 < period) return null;
        const values = rows.slice(index - period + 1, index + 1).map(row => row.close);
        const middle = values.reduce((sum, value) => sum + value, 0) / values.length;
        const variance = values.reduce((sum, value) => sum + (value - middle) ** 2, 0) / values.length;
        const deviation = Math.sqrt(variance);
        return { upper: middle + 2 * deviation, lower: middle - 2 * deviation };
    });
}

// 筹码分布：每个价位一条横向柱（收盘价以下为获利盘红色、以上为套牢盘蓝灰），橙色虚线为平均成本；
// 只画K线价格范围内的部分，下方标平均成本与获利盘比例
function drawChips(image, chips, { left, right, top, bottom, minPrice, maxPrice, yAt }) {
    const visible = chips.prices.map((price, i) => ({ price, weight: chips.weights[i] })).filter(item => item.price >= minPrice && item.price <= maxPrice);
    const maxWeight = Math.max(...visible.map(item => item.weight), 1e-9);
    // 柱高等于相邻两档在图上的间距，柱子刚好铺满、不留缝也不重叠
    const rowHeight = Math.max(2, Math.ceil(Math.abs(yAt(chips.prices[0]) - yAt(chips.prices[1]))));
    image.text("CHIPS", left, top - 22, 2, COLORS.muted);
    for (const item of visible) {
        const width = (item.weight / maxWeight) * (right - left);
        if (width < 1) continue;
        image.fillRect(left, yAt(item.price) - rowHeight / 2, width, rowHeight, item.price <= chips.close ? COLORS.up : COLORS.boll);
    }
    if (chips.avgCost >= minPrice && chips.avgCost <= maxPrice) image.line(left - 8, yAt(chips.avgCost), right, yAt(chips.avgCost), COLORS.ma5, 2, true);
    image.text(`AVG ${chips.avgCost.toFixed(2)}`, left - 4, bottom + 26, 2, COLORS.ma5);
    image.text(`PROFIT ${Math.round(chips.profitRatio * 100)}%`, left - 4, bottom + 48, 2, COLORS.muted);
}

function generateStockChart(report) {
    const width = 1080;
    const height = 720;
    const image = new Raster(width, height, COLORS.background);
    const allRows = report.klines || [];
    const rows = allRows.slice(-30);
    if (rows.length < 20) throw new Error("绘图至少需要20个交易日数据");

    const ma5 = rollingAverage(rows, 5, "close");
    const ma20 = rollingAverage(rows, 20, "close");
    const boll = rollingBollinger(rows, 20);
    // 有筹码数据时K线与成交量收窄，右侧留给筹码分布（与K线共用价格刻度）
    const chips = report.analysis.chips;
    const chartRight = chips ? 900 : 1040;
    const plot = { left: 84, right: chartRight, top: 98, bottom: 470 };
    const volumePlot = { left: 84, right: chartRight, top: 535, bottom: 660 };
    const rangeValues = rows.flatMap(row => [row.low, row.high]);
    for (const item of boll) {
        if (item) rangeValues.push(item.lower, item.upper);
    }
    rangeValues.push(report.analysis.support, report.analysis.resistance);
    const rawMin = Math.min(...rangeValues.filter(Number.isFinite));
    const rawMax = Math.max(...rangeValues.filter(Number.isFinite));
    const padding = Math.max((rawMax - rawMin) * 0.08, rawMax * 0.01);
    const minPrice = rawMin - padding;
    const maxPrice = rawMax + padding;
    const xAt = index => plot.left + index * ((plot.right - plot.left) / Math.max(rows.length - 1, 1));
    const yAt = price => plot.bottom - ((price - minPrice) / (maxPrice - minPrice)) * (plot.bottom - plot.top);

    image.fillRect(48, 76, 1008, 412, COLORS.panel);
    image.fillRect(48, 516, 1008, 164, COLORS.panel);
    for (let line = 0; line <= 4; line++) {
        const y = plot.top + line * ((plot.bottom - plot.top) / 4);
        image.line(plot.left, y, plot.right, y, COLORS.grid, 1);
        const price = maxPrice - line * ((maxPrice - minPrice) / 4);
        image.text(price.toFixed(2), 8, y - 7, 2, COLORS.muted);
    }
    for (let line = 0; line <= 5; line++) {
        const x = plot.left + line * ((plot.right - plot.left) / 5);
        image.line(x, plot.top, x, plot.bottom, COLORS.grid, 1);
    }

    const step = (plot.right - plot.left) / Math.max(rows.length - 1, 1);
    const candleWidth = Math.max(5, Math.min(18, Math.floor(step * 0.55)));
    rows.forEach((row, index) => {
        const x = xAt(index);
        const color = row.close >= row.open ? COLORS.up : COLORS.down;
        image.line(x, yAt(row.high), x, yAt(row.low), color, 2);
        const top = Math.min(yAt(row.open), yAt(row.close));
        const bodyHeight = Math.max(3, Math.abs(yAt(row.open) - yAt(row.close)));
        image.fillRect(x - candleWidth / 2, top, candleWidth, bodyHeight, color);
    });

    image.polyline(ma5.map((value, index) => value == null ? null : [xAt(index), yAt(value)]), COLORS.ma5, 3);
    image.polyline(ma20.map((value, index) => value == null ? null : [xAt(index), yAt(value)]), COLORS.ma20, 3);
    image.polyline(boll.map((value, index) => value == null ? null : [xAt(index), yAt(value.upper)]), COLORS.boll, 1);
    image.polyline(boll.map((value, index) => value == null ? null : [xAt(index), yAt(value.lower)]), COLORS.boll, 1);
    image.line(plot.left, yAt(report.analysis.support), plot.right, yAt(report.analysis.support), COLORS.support, 2, true);
    image.line(plot.left, yAt(report.analysis.resistance), plot.right, yAt(report.analysis.resistance), COLORS.resistance, 2, true);

    const maxVolume = Math.max(...rows.map(row => row.volume));
    rows.forEach((row, index) => {
        const x = xAt(index);
        const barHeight = (row.volume / maxVolume) * (volumePlot.bottom - volumePlot.top);
        const color = row.close >= row.open ? COLORS.up : COLORS.down;
        image.fillRect(x - candleWidth / 2, volumePlot.bottom - barHeight, candleWidth, barHeight, color);
    });
    const volumeMa5 = rollingAverage(rows, 5, "volume");
    image.polyline(volumeMa5.map((value, index) => value == null
        ? null
        : [xAt(index), volumePlot.bottom - (value / maxVolume) * (volumePlot.bottom - volumePlot.top)]), COLORS.ma5, 2);

    const latest = rows.at(-1);
    image.text(`${report.meta.exchangeCode}  30D PRICE  ${latest.close.toFixed(2)}`, 48, 24, 3, COLORS.text);
    image.text(`${rows[0].date.slice(5)} - ${latest.date.slice(5)}`, 825, 34, 2, COLORS.muted);
    image.fillRect(52, 493, 16, 5, COLORS.up);
    image.text("UP", 76, 488, 2, COLORS.muted);
    image.fillRect(126, 493, 16, 5, COLORS.down);
    image.text("DOWN", 150, 488, 2, COLORS.muted);
    image.fillRect(242, 493, 22, 4, COLORS.ma5);
    image.text("MA5", 274, 488, 2, COLORS.muted);
    image.fillRect(350, 493, 22, 4, COLORS.ma20);
    image.text("MA20", 382, 488, 2, COLORS.muted);
    image.fillRect(474, 493, 22, 4, COLORS.support);
    image.text("SUPPORT", 506, 488, 2, COLORS.muted);
    image.fillRect(674, 493, 22, 4, COLORS.resistance);
    image.text("RESIST", 706, 488, 2, COLORS.muted);
    if (chips) drawChips(image, chips, { left: 918, right: 1040, top: plot.top, bottom: plot.bottom, minPrice, maxPrice, yAt });
    image.text("VOLUME", 48, 688, 2, COLORS.muted);
    image.text(`MAX ${(maxVolume / 10000).toFixed(1)}W`, chips ? 736 : 876, 688, 2, COLORS.muted);

    return encodePng(image);
}

function overviewHeatScore(report) {
    const { analysis } = report;
    return Math.min(100, Math.max(
        analysis.rsi || 0,
        analysis.kdj ? analysis.kdj.j : 0,
        Math.min((analysis.latest.turnover || 0) * 5, 100)
    ));
}

function chartNumber(value, digits = 2) {
    return Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function drawGauge(image, x, y, width, ratio, color) {
    image.fillRect(x, y, width, 12, COLORS.grid);
    image.fillRect(x, y, Math.max(4, Math.min(width, width * ratio)), 12, color);
}

const CARD_LABELS = { "600887": "YILI", "002380": "SCIYON" };

function drawOverviewCard(image, report, y) {
    const cardX = 48;
    const cardWidth = 984;
    const cardHeight = 270;
    const latest = report.analysis.latest;
    const accent = latest.changePct >= 0 ? COLORS.up : COLORS.down;
    const rows = (report.klines || []).slice(-20);
    // 字体只支持ASCII，中文名无法绘制；已知股票用英文简称，其余显示代码
    const label = CARD_LABELS[report.meta.symbol] || report.meta.symbol;
    const status = report.plan.recommendation === "观望" ? "WATCH" : "TRIAL";

    image.fillRect(cardX, y, cardWidth, cardHeight, COLORS.panel);
    image.fillRect(cardX, y, 7, cardHeight, accent);
    image.text(label, 80, y + 24, 3, COLORS.text);
    image.text(report.meta.exchangeCode, 80, y + 56, 2, COLORS.muted);
    image.text("PRICE", 80, y + 94, 2, COLORS.muted);
    image.text(latest.close.toFixed(2), 80, y + 122, 4, accent);
    image.text("CHANGE", 80, y + 172, 2, COLORS.muted);
    image.text(`${latest.changePct >= 0 ? "+" : ""}${latest.changePct.toFixed(2)}%`, 80, y + 198, 3, accent);
    image.fillRect(80, y + 237, 112, 24, COLORS.grid);
    image.text(status, 90, y + 242, 2, COLORS.text);

    const graph = { left: 318, right: 738, top: y + 38, bottom: y + 174 };
    const volumeGraph = { left: 318, right: 738, top: y + 194, bottom: y + 226 };
    const values = rows.flatMap(row => [row.low, row.high]);
    values.push(report.analysis.support, report.analysis.resistance);
    const rawMin = Math.min(...values.filter(Number.isFinite));
    const rawMax = Math.max(...values.filter(Number.isFinite));
    const pad = Math.max((rawMax - rawMin) * 0.12, rawMax * 0.01);
    const min = rawMin - pad;
    const max = rawMax + pad;
    const xAt = index => graph.left + index * ((graph.right - graph.left) / Math.max(rows.length - 1, 1));
    const yAt = value => graph.bottom - ((value - min) / (max - min)) * (graph.bottom - graph.top);
    for (let line = 0; line <= 3; line++) {
        const gridY = graph.top + line * ((graph.bottom - graph.top) / 3);
        image.line(graph.left, gridY, graph.right, gridY, COLORS.grid, 1);
    }
    image.line(graph.left, yAt(report.analysis.support), graph.right, yAt(report.analysis.support), COLORS.support, 2, true);
    image.line(graph.left, yAt(report.analysis.resistance), graph.right, yAt(report.analysis.resistance), COLORS.resistance, 2, true);
    const candleStep = (graph.right - graph.left) / Math.max(rows.length - 1, 1);
    const candleWidth = Math.max(4, Math.min(10, Math.floor(candleStep * 0.5)));
    rows.forEach((row, index) => {
        const x = xAt(index);
        const color = row.close >= row.open ? COLORS.up : COLORS.down;
        image.line(x, yAt(row.high), x, yAt(row.low), color, 1);
        const bodyTop = Math.min(yAt(row.open), yAt(row.close));
        const bodyHeight = Math.max(2, Math.abs(yAt(row.open) - yAt(row.close)));
        image.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight, color);
    });
    const ma5 = rollingAverage(rows, 5, "close");
    image.polyline(ma5.map((value, index) => value == null ? null : [xAt(index), yAt(value)]), COLORS.ma5, 2);

    const maxVolume = Math.max(...rows.map(row => row.volume));
    rows.forEach((row, index) => {
        const x = xAt(index);
        const height = (row.volume / maxVolume) * (volumeGraph.bottom - volumeGraph.top);
        const color = row.close >= row.open ? COLORS.up : COLORS.down;
        image.fillRect(x - candleWidth / 2, volumeGraph.bottom - height, candleWidth, height, color);
    });
    image.line(volumeGraph.left, volumeGraph.top, volumeGraph.right, volumeGraph.top, COLORS.grid, 1);
    image.text("20D KLINE", graph.left, y + 12, 2, COLORS.muted);
    image.text("VOL", graph.left, y + 178, 2, COLORS.muted);
    image.text(rows[0].date.slice(5), graph.left, y + 239, 2, COLORS.muted);
    image.text(rows.at(-1).date.slice(5), graph.right - 56, y + 239, 2, COLORS.muted);

    const metricsX = 780;
    image.text("VOL RATIO", metricsX, y + 24, 2, COLORS.muted);
    image.text(`${chartNumber(report.analysis.volumeRatio)}X`, 942, y + 24, 2, COLORS.text);
    drawGauge(image, metricsX, y + 50, 220, Math.min(report.analysis.volumeRatio / 2.5, 1), COLORS.volume);
    image.text("HEAT", metricsX, y + 80, 2, COLORS.muted);
    image.text(overviewHeatScore(report).toFixed(0), 966, y + 80, 2, COLORS.text);
    drawGauge(image, metricsX, y + 106, 220, overviewHeatScore(report) / 100, accent);
    image.text("TURN", metricsX, y + 138, 2, COLORS.muted);
    image.text(`${chartNumber(latest.turnover)}%`, 918, y + 138, 2, COLORS.text);
    image.text("RSI", metricsX, y + 170, 2, COLORS.muted);
    image.text(chartNumber(report.analysis.rsi, 1), 942, y + 170, 2, COLORS.text);
    image.text("SUPPORT", metricsX, y + 202, 2, COLORS.support);
    image.text(chartNumber(report.analysis.support), 930, y + 202, 2, COLORS.text);
    image.text("RESIST", metricsX, y + 234, 2, COLORS.resistance);
    image.text(chartNumber(report.analysis.resistance), 930, y + 234, 2, COLORS.text);
}

function generateOverviewChart(reports, date, title = "DAILY CLOSE OVERVIEW") {
    if (!Array.isArray(reports) || reports.length < 1 || reports.length > 2) {
        throw new Error("每张总览图需要一至两只股票的数据");
    }
    const footerY = reports.length === 1 ? 394 : 694;
    const height = reports.length === 1 ? 462 : 760;
    const image = new Raster(1080, height, COLORS.background);
    image.text(title, 48, 26, 3, COLORS.text);
    image.text(date, 820, 32, 2, COLORS.muted);
    image.line(48, 68, 1032, 68, COLORS.grid, 2);
    drawOverviewCard(image, reports[0], 92);
    if (reports[1]) drawOverviewCard(image, reports[1], 390);
    image.fillRect(48, footerY, 16, 5, COLORS.up);
    image.text("UP", 74, footerY - 5, 2, COLORS.muted);
    image.fillRect(126, footerY, 16, 5, COLORS.down);
    image.text("DOWN", 152, footerY - 5, 2, COLORS.muted);
    image.fillRect(252, footerY, 22, 4, COLORS.support);
    image.text("SUPPORT", 284, footerY - 5, 2, COLORS.muted);
    image.fillRect(452, footerY, 22, 4, COLORS.resistance);
    image.text("RESIST", 484, footerY - 5, 2, COLORS.muted);
    image.text("3-6M TARGET 15%  MAX LOSS 8%", 680, footerY - 5, 2, COLORS.muted);
    image.text("PUBLIC MARKET DATA  FOR RESEARCH ONLY", 48, footerY + 36, 2, COLORS.muted);
    return encodePng(image);
}

module.exports = { generateOverviewChart, generateStockChart };
