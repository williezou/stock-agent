const zlib = require("node:zlib");

const COLORS = {
    background: [10, 18, 32, 255],
    panel: [17, 29, 49, 255],
    grid: [43, 57, 78, 255],
    text: [226, 232, 240, 255],
    muted: [139, 151, 171, 255],
    up: [245, 82, 82, 255],
    down: [34, 197, 94, 255],
    ma5: [250, 204, 21, 255],
    ma20: [56, 189, 248, 255],
    boll: [148, 163, 184, 255],
    support: [45, 212, 191, 255],
    resistance: [251, 113, 133, 255],
    volume: [96, 165, 250, 255]
};

const FONT = {
    " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
    "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "G": ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
    ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
    ",": ["00000", "00000", "00000", "00000", "00110", "00100", "01000"],
    ":": ["00000", "00110", "00110", "00000", "00110", "00110", "00000"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
    "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
    "%": ["11001", "11010", "00100", "01000", "10110", "00110", "00000"]
};

class Raster {
    constructor(width, height, background) {
        this.width = width;
        this.height = height;
        this.data = Buffer.alloc(width * height * 4);
        this.fillRect(0, 0, width, height, background);
    }

    pixel(x, y, color) {
        const px = Math.round(x);
        const py = Math.round(y);
        if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
        const index = (py * this.width + px) * 4;
        this.data[index] = color[0];
        this.data[index + 1] = color[1];
        this.data[index + 2] = color[2];
        this.data[index + 3] = color[3];
    }

    fillRect(x, y, width, height, color) {
        const startX = Math.max(0, Math.floor(x));
        const startY = Math.max(0, Math.floor(y));
        const endX = Math.min(this.width, Math.ceil(x + width));
        const endY = Math.min(this.height, Math.ceil(y + height));
        for (let py = startY; py < endY; py++) {
            for (let px = startX; px < endX; px++) this.pixel(px, py, color);
        }
    }

    line(x0, y0, x1, y1, color, thickness = 1, dashed = false) {
        let startX = Math.round(x0);
        let startY = Math.round(y0);
        const endX = Math.round(x1);
        const endY = Math.round(y1);
        const dx = Math.abs(endX - startX);
        const sx = startX < endX ? 1 : -1;
        const dy = -Math.abs(endY - startY);
        const sy = startY < endY ? 1 : -1;
        let error = dx + dy;
        let step = 0;
        while (true) {
            if (!dashed || Math.floor(step / 7) % 2 === 0) {
                const radius = Math.max(0, Math.floor(thickness / 2));
                this.fillRect(startX - radius, startY - radius, Math.max(1, thickness), Math.max(1, thickness), color);
            }
            if (startX === endX && startY === endY) break;
            const twice = 2 * error;
            if (twice >= dy) {
                error += dy;
                startX += sx;
            }
            if (twice <= dx) {
                error += dx;
                startY += sy;
            }
            step++;
        }
    }

    polyline(points, color, thickness = 2) {
        let previous = null;
        for (const point of points) {
            if (!point) {
                previous = null;
                continue;
            }
            if (previous) this.line(previous[0], previous[1], point[0], point[1], color, thickness);
            previous = point;
        }
    }

    text(value, x, y, scale = 2, color = COLORS.text) {
        let cursor = x;
        for (const char of String(value).toUpperCase()) {
            const glyph = FONT[char] || FONT[" "];
            for (let row = 0; row < glyph.length; row++) {
                for (let column = 0; column < glyph[row].length; column++) {
                    if (glyph[row][column] === "1") {
                        this.fillRect(cursor + column * scale, y + row * scale, scale, scale, color);
                    }
                }
            }
            cursor += 6 * scale;
        }
    }
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
    const typeBuffer = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
    return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodePng(raster) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(raster.width, 0);
    header.writeUInt32BE(raster.height, 4);
    header[8] = 8;
    header[9] = 6;
    const rows = [];
    for (let y = 0; y < raster.height; y++) {
        rows.push(Buffer.from([0]));
        rows.push(raster.data.subarray(y * raster.width * 4, (y + 1) * raster.width * 4));
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
        pngChunk("IEND")
    ]);
}

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
    const plot = { left: 84, right: 1040, top: 98, bottom: 470 };
    const volumePlot = { left: 84, right: 1040, top: 535, bottom: 660 };
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
    image.text("VOLUME", 48, 688, 2, COLORS.muted);
    image.text(`MAX ${(maxVolume / 10000).toFixed(1)}W`, 876, 688, 2, COLORS.muted);

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

module.exports = { COLORS, encodePng, generateOverviewChart, generateStockChart };
