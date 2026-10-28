const { createCanvas } = require("@napi-rs/canvas");
const { font } = require("./cjk-font");

// 排行条形图（资金异动、量价异动共用）：上下两段横向条形图；每行第一行为名称+当日涨跌幅，第二行为代码+说明，右侧为数值
const WIDTH = 1080;
const PADDING = 48;
const HEADER_HEIGHT = 150;
const SECTION_TITLE_HEIGHT = 56;
const ROW_HEIGHT = 72;
const SECTION_GAP = 24;
const FOOTER_HEIGHT = 70;
const NAME_LEFT = PADDING + 56;
const BAR_LEFT = 500;
const BAR_MAX_WIDTH = 330;

const COLORS = {
    background: "#0a1220",
    panel: "#111d31",
    grid: "#2b394e",
    text: "#e2e8f0",
    muted: "#8b97ab",
    up: "#f55252",
    down: "#22c55e"
};

function signColor(value) {
    if (!Number.isFinite(value) || value === 0) return COLORS.muted;
    return value > 0 ? COLORS.up : COLORS.down;
}

function pctText(value) {
    return Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "--";
}

function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let value = text;
    while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) value = value.slice(0, -1);
    return `${value}…`;
}

function drawSection(ctx, { title, rows, color, top, scale, detail, value, magnitude }) {
    ctx.fillStyle = color;
    ctx.fillRect(PADDING, top + 14, 8, 28);
    ctx.fillStyle = COLORS.text;
    ctx.font = font(28, "bold");
    ctx.fillText(title, PADDING + 22, top + 39);

    rows.forEach((row, index) => {
        const y = top + SECTION_TITLE_HEIGHT + index * ROW_HEIGHT;
        if (index % 2 === 0) {
            ctx.fillStyle = COLORS.panel;
            ctx.fillRect(PADDING, y, WIDTH - PADDING * 2, ROW_HEIGHT - 6);
        }
        ctx.fillStyle = COLORS.muted;
        ctx.font = font(20);
        ctx.fillText(String(index + 1), PADDING + 14, y + 40);

        ctx.fillStyle = COLORS.text;
        ctx.font = font(27, "bold");
        const name = fitText(ctx, row.name, 190);
        ctx.fillText(name, NAME_LEFT, y + 32);
        const nameWidth = ctx.measureText(name).width;
        ctx.fillStyle = signColor(row.changePct);
        ctx.font = font(23, "bold");
        ctx.fillText(pctText(row.changePct), NAME_LEFT + nameWidth + 14, y + 31);

        ctx.fillStyle = COLORS.muted;
        ctx.font = font(18);
        ctx.fillText(fitText(ctx, `${row.symbol}  ${detail(row)}`, BAR_LEFT - NAME_LEFT - 20), NAME_LEFT, y + 58);

        const barWidth = Math.max(4, magnitude(row) / scale * BAR_MAX_WIDTH);
        ctx.fillStyle = color;
        ctx.fillRect(BAR_LEFT, y + 22, barWidth, 26);

        ctx.fillStyle = color;
        ctx.font = font(28, "bold");
        ctx.textAlign = "right";
        ctx.fillText(value(row), WIDTH - PADDING - 12, y + 45);
        ctx.textAlign = "left";
    });
    return top + SECTION_TITLE_HEIGHT + rows.length * ROW_HEIGHT;
}

// 通用排行条形图：上段红色、下段绿色，条长按 magnitude 统一比例；
// sections：[{ title, rows, up }]，detail(row)：代码后的说明，value(row)：右侧数字，subtitle/footer：标题下与底部的说明
function generateRankedChart({ title, subtitle, footer, sections: input, detail, value, magnitude }) {
    const sections = input
        .filter(section => section.rows.length)
        .map(section => ({ title: section.title, rows: section.rows, color: section.up ? COLORS.up : COLORS.down }));
    const height = HEADER_HEIGHT
        + sections.reduce((sum, section) => sum + SECTION_TITLE_HEIGHT + section.rows.length * ROW_HEIGHT + SECTION_GAP, 0)
        + FOOTER_HEIGHT;
    const scale = Math.max(1e-9, ...sections.flatMap(section => section.rows.map(magnitude)));

    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, WIDTH, height);

    ctx.fillStyle = COLORS.text;
    ctx.font = font(40, "bold");
    ctx.fillText(title, PADDING, 66);
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(22);
    ctx.fillText(subtitle, PADDING, 108);
    ctx.fillStyle = COLORS.grid;
    ctx.fillRect(PADDING, HEADER_HEIGHT - 20, WIDTH - PADDING * 2, 2);

    let top = HEADER_HEIGHT;
    for (const section of sections) {
        top = drawSection(ctx, { ...section, top, scale, detail, value, magnitude }) + SECTION_GAP;
    }

    ctx.fillStyle = COLORS.muted;
    ctx.font = font(17);
    ctx.fillText(footer, PADDING, height - 30);
    return canvas.toBuffer("image/png");
}

module.exports = { generateRankedChart, pctText };
