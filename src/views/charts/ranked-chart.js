const { createCanvas } = require("@napi-rs/canvas");
const { font } = require("./cjk-font");

// 排行条形图（资金异动、量价异动、游资动向共用）：上下两段横向条形图；每行第一行为名称+当日涨跌幅，第二行为代码+说明，右侧为数值
const WIDTH = 1080;
const PADDING = 48;
const HEADER_HEIGHT = 176;
const SECTION_TITLE_HEIGHT = 68;
const ROW_HEIGHT = 96;
const SECTION_GAP = 24;
const FOOTER_HEIGHT = 84;
const NAME_LEFT = PADDING + 56;
const BAR_LEFT = 600;
const BAR_MAX_WIDTH = 240;

// 浅色主题
const COLORS = {
    background: "#ffffff",
    panel: "#f4f6f9",
    grid: "#e2e8f0",
    text: "#1e293b",
    muted: "#64748b",
    up: "#e03131",
    gold: "#d97706",
    down: "#16a34a"
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

function drawSection(ctx, { title, rows, color, top, scale, detail, value, magnitude, badge, nameMaxWidth }) {
    ctx.fillStyle = color;
    ctx.fillRect(PADDING, top + 16, 8, 34);
    ctx.fillStyle = COLORS.text;
    ctx.font = font(34, "bold");
    ctx.fillText(title, PADDING + 22, top + 46);

    rows.forEach((row, index) => {
        const y = top + SECTION_TITLE_HEIGHT + index * ROW_HEIGHT;
        if (index % 2 === 0) {
            ctx.fillStyle = COLORS.panel;
            ctx.fillRect(PADDING, y, WIDTH - PADDING * 2, ROW_HEIGHT - 6);
        }
        ctx.fillStyle = COLORS.muted;
        ctx.font = font(26);
        ctx.fillText(String(index + 1), PADDING + 14, y + 54);

        // 名称与标签都不能压到条形图：先量出标签宽度，名称在剩余空间内截断
        const tag = badge(row);
        ctx.font = font(28, "bold");
        const tagWidth = tag ? ctx.measureText(tag.text).width + 14 : 0;
        ctx.fillStyle = COLORS.text;
        ctx.font = font(34, "bold");
        const name = fitText(ctx, row.name, Math.min(nameMaxWidth, BAR_LEFT - NAME_LEFT - 20 - tagWidth));
        ctx.fillText(name, NAME_LEFT, y + 42);
        const nameWidth = ctx.measureText(name).width;
        if (tag) {
            ctx.fillStyle = tag.color || COLORS.text;
            ctx.font = font(28, "bold");
            ctx.fillText(tag.text, NAME_LEFT + nameWidth + 14, y + 41);
        }

        ctx.fillStyle = COLORS.muted;
        ctx.font = font(24);
        ctx.fillText(fitText(ctx, detail(row), BAR_LEFT - NAME_LEFT - 20), NAME_LEFT, y + 78);

        const barWidth = Math.max(4, magnitude(row) / scale * BAR_MAX_WIDTH);
        ctx.fillStyle = color;
        ctx.fillRect(BAR_LEFT, y + 29, barWidth, 32);

        ctx.fillStyle = color;
        ctx.font = font(36, "bold");
        ctx.textAlign = "right";
        ctx.fillText(value(row), WIDTH - PADDING - 12, y + 58);
        ctx.textAlign = "left";
    });
    return top + SECTION_TITLE_HEIGHT + rows.length * ROW_HEIGHT;
}

// 当日涨跌幅标签（股票排行默认）
function changeBadge(row) {
    return { text: pctText(row.changePct), color: signColor(row.changePct) };
}

// 通用排行条形图：上段红色、下段绿色，条长按 magnitude 统一比例；
// sections：[{ title, rows, up, color }]（color 可覆盖红/绿），detail(row)：第二行说明（股票排行默认以代码开头），value(row)：右侧数字，
// badge(row)：名称后的彩色标签（默认当日涨跌幅，返回null不显示），subtitle/footer：标题下与底部的说明
function generateRankedChart({
    title,
    subtitle,
    footer,
    sections: input,
    detail,
    value,
    magnitude,
    badge = changeBadge,
    nameMaxWidth = 260
}) {
    const sections = input
        .filter(section => section.rows.length)
        .map(section => ({ title: section.title, rows: section.rows, color: section.color || (section.up ? COLORS.up : COLORS.down) }));
    const height = HEADER_HEIGHT
        + sections.reduce((sum, section) => sum + SECTION_TITLE_HEIGHT + section.rows.length * ROW_HEIGHT + SECTION_GAP, 0)
        + FOOTER_HEIGHT;
    const scale = Math.max(1e-9, ...sections.flatMap(section => section.rows.map(magnitude)));

    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, WIDTH, height);

    ctx.fillStyle = COLORS.text;
    ctx.font = font(48, "bold");
    ctx.fillText(fitText(ctx, title, WIDTH - PADDING * 2), PADDING, 76);
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(28);
    ctx.fillText(fitText(ctx, subtitle, WIDTH - PADDING * 2), PADDING, 128);
    ctx.fillStyle = COLORS.grid;
    ctx.fillRect(PADDING, HEADER_HEIGHT - 20, WIDTH - PADDING * 2, 2);

    let top = HEADER_HEIGHT;
    for (const section of sections) {
        top = drawSection(ctx, { ...section, top, scale, detail, value, magnitude, badge, nameMaxWidth }) + SECTION_GAP;
    }

    ctx.fillStyle = COLORS.muted;
    ctx.font = font(22);
    ctx.fillText(fitText(ctx, footer, WIDTH - PADDING * 2), PADDING, height - 34);
    return canvas.toBuffer("image/png");
}

module.exports = { COLORS, generateRankedChart, pctText };
