const zlib = require("node:zlib");

// 零依赖的RGBA画布与PNG编码；内置5x7像素字体只含数字、部分大写字母（无J/Q）与常用符号

// 浅色主题（与排行图一致）；白底上黄色看不清，MA5用橙色
const COLORS = {
    background: [255, 255, 255, 255],
    panel: [244, 246, 249, 255],
    grid: [226, 232, 240, 255],
    text: [30, 41, 59, 255],
    muted: [100, 116, 139, 255],
    up: [224, 49, 49, 255],
    down: [22, 163, 74, 255],
    ma5: [234, 88, 12, 255],
    ma20: [37, 99, 235, 255],
    boll: [148, 163, 184, 255],
    support: [13, 148, 136, 255],
    resistance: [225, 29, 72, 255],
    volume: [59, 130, 246, 255]
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

module.exports = { COLORS, Raster, encodePng };
