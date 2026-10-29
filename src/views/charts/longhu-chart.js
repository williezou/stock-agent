const { createCanvas } = require("@napi-rs/canvas");
const { compactReason, SOURCE_NOTE, signedMoney, summarizeBoard } = require("../longhu-view");
const { font } = require("./cjk-font");

// 龙虎榜图表：概况 + 净买入前10（红）/净卖出前5（绿）横向条形图，条长按净额绝对值统一比例
const WIDTH = 1080;
const PADDING = 48;
const HEADER_HEIGHT = 150;
const SECTION_TITLE_HEIGHT = 56;
const ROW_HEIGHT = 66;
const SECTION_GAP = 24;
const FOOTER_HEIGHT = 70;
const BAR_LEFT = 430;
const BAR_MAX_WIDTH = 440;
const NAME_LEFT = PADDING + 56;
const DETAIL_MAX_WIDTH = BAR_LEFT - NAME_LEFT - 20; // 第二行（代码+上榜原因）不得压到条形图

// 浅色主题（与排行图一致）
const COLORS = {
    background: "#ffffff",
    panel: "#f4f6f9",
    grid: "#e2e8f0",
    text: "#1e293b",
    muted: "#64748b",
    up: "#e03131",
    down: "#16a34a"
};

function changeColor(changePct) {
    if (!Number.isFinite(changePct) || changePct === 0) return COLORS.muted;
    return changePct > 0 ? COLORS.up : COLORS.down;
}

function changeText(changePct) {
    return Number.isFinite(changePct) ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%` : "--";
}

function truncate(text, max) {
    const value = String(text || "");
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// 按像素宽度截断，超出时以省略号结尾
function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let value = text;
    while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) value = value.slice(0, -1);
    return `${value}…`;
}

function drawSection(ctx, { title, rows, color, top, scale }) {
    ctx.fillStyle = color;
    ctx.fillRect(PADDING, top + 14, 8, 28);
    ctx.fillStyle = COLORS.text;
    ctx.font = font(28, "bold");
    ctx.fillText(title, PADDING + 22, top + 39);

    rows.forEach((item, index) => {
        const y = top + SECTION_TITLE_HEIGHT + index * ROW_HEIGHT;
        if (index % 2 === 0) {
            ctx.fillStyle = COLORS.panel;
            ctx.fillRect(PADDING, y, WIDTH - PADDING * 2, ROW_HEIGHT - 6);
        }
        ctx.fillStyle = COLORS.muted;
        ctx.font = font(20);
        ctx.fillText(String(index + 1).padStart(2, " "), PADDING + 12, y + 38);

        // 第一行：名称 + 紧随其后的涨跌幅；第二行：代码 + 上榜原因
        const name = truncate(item.name, 6);
        ctx.fillStyle = COLORS.text;
        ctx.font = font(26, "bold");
        ctx.fillText(name, NAME_LEFT, y + 30);
        const nameWidth = ctx.measureText(name).width;
        ctx.fillStyle = changeColor(item.changePct);
        ctx.font = font(22, "bold");
        ctx.fillText(changeText(item.changePct), NAME_LEFT + nameWidth + 14, y + 29);

        ctx.fillStyle = COLORS.muted;
        ctx.font = font(17);
        ctx.fillText(fitText(ctx, `${item.symbol}  ${compactReason(item.reason)}`, DETAIL_MAX_WIDTH), NAME_LEFT, y + 54);

        const barWidth = Math.max(4, Math.abs(item.netAmount) / scale * BAR_MAX_WIDTH);
        ctx.fillStyle = color;
        ctx.fillRect(BAR_LEFT, y + 18, barWidth, 24);

        ctx.fillStyle = COLORS.text;
        ctx.font = font(22, "bold");
        ctx.textAlign = "right";
        ctx.fillText(signedMoney(item.netAmount), WIDTH - PADDING - 12, y + 38);
        ctx.textAlign = "left";
    });
    return top + SECTION_TITLE_HEIGHT + rows.length * ROW_HEIGHT;
}

function generateLonghuChart({ date, board }) {
    const summary = summarizeBoard(board);
    const sections = [
        { title: `净买入前${summary.buyers.length}`, rows: summary.buyers, color: COLORS.up },
        { title: `净卖出前${summary.sellers.length}`, rows: summary.sellers, color: COLORS.down }
    ].filter(section => section.rows.length);
    const height = HEADER_HEIGHT
        + sections.reduce((sum, section) => sum + SECTION_TITLE_HEIGHT + section.rows.length * ROW_HEIGHT + SECTION_GAP, 0)
        + FOOTER_HEIGHT;
    const scale = Math.max(1, ...board.map(item => Math.abs(item.netAmount)));

    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, WIDTH, height);

    ctx.fillStyle = COLORS.text;
    ctx.font = font(40, "bold");
    ctx.fillText(`龙虎榜  ${date}`, PADDING, 66);
    const { total, counts, upCount, totalNet } = summary;
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(22);
    ctx.fillText(`上榜${total}只（沪${counts.沪} 深${counts.深} 北${counts.北}）｜上涨${upCount}只 下跌${total - upCount}只`, PADDING, 108);
    ctx.fillStyle = totalNet >= 0 ? COLORS.up : COLORS.down;
    ctx.font = font(26, "bold");
    ctx.textAlign = "right";
    ctx.fillText(`合计净买入 ${signedMoney(totalNet)}`, WIDTH - PADDING, 66);
    ctx.textAlign = "left";
    ctx.fillStyle = COLORS.grid;
    ctx.fillRect(PADDING, HEADER_HEIGHT - 20, WIDTH - PADDING * 2, 2);

    let top = HEADER_HEIGHT;
    for (const section of sections) {
        top = drawSection(ctx, { ...section, top, scale }) + SECTION_GAP;
    }

    ctx.fillStyle = COLORS.muted;
    ctx.font = font(17);
    ctx.fillText(SOURCE_NOTE, PADDING, height - 30);
    return canvas.toBuffer("image/png");
}

module.exports = { generateLonghuChart };
