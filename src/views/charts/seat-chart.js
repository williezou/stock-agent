const { createCanvas } = require("@napi-rs/canvas");
const { compactReason, shortSeatName, signedMoney } = require("../longhu-view");
const { font } = require("./cjk-font");

// 个股龙虎榜席位表格：每个上榜原因一组，组内为“买入前5”“卖出前5”两张表（营业部｜买入｜卖出｜净额）
const WIDTH = 1080;
const PADDING = 48;
const HEADER_HEIGHT = 120;
const GROUP_TITLE_HEIGHT = 92;
const TABLE_TITLE_HEIGHT = 48;
const COLUMN_HEAD_HEIGHT = 44;
const ROW_HEIGHT = 54;
const TABLE_GAP = 20;
const GROUP_GAP = 28;
const FOOTER_HEIGHT = 56;

// 列的右边界（金额右对齐），营业部列从序号后开始
const COLUMNS = {
    index: PADDING + 16,
    name: PADDING + 60,
    nameMaxWidth: 470,
    buy: 760,
    sell: 900,
    net: WIDTH - PADDING - 16
};

const COLORS = {
    background: "#0a1220",
    panel: "#111d31",
    head: "#1b2a42",
    grid: "#2b394e",
    text: "#e2e8f0",
    muted: "#8b97ab",
    up: "#f55252",
    down: "#22c55e",
    accent: "#facc15"
};

function signColor(value) {
    if (!Number.isFinite(value) || value === 0) return COLORS.text;
    return value > 0 ? COLORS.up : COLORS.down;
}

// 表格金额：过亿显示“1.22亿”，否则显示整数“7951万”
function tableAmount(value, withSign = false) {
    if (!Number.isFinite(value)) return "—";
    const sign = withSign && value > 0 ? "+" : "";
    return Math.abs(value) >= 1e8 ? `${sign}${(value / 1e8).toFixed(2)}亿` : `${sign}${Math.round(value / 1e4)}万`;
}

function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let value = text;
    while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) value = value.slice(0, -1);
    return `${value}…`;
}

function tableHeight(rows) {
    return TABLE_TITLE_HEIGHT + COLUMN_HEAD_HEIGHT + Math.max(rows, 1) * ROW_HEIGHT;
}

function groupHeight(group) {
    return GROUP_TITLE_HEIGHT + tableHeight(group.buyers.length) + TABLE_GAP + tableHeight(group.sellers.length);
}

function rightText(ctx, text, x, y) {
    ctx.textAlign = "right";
    ctx.fillText(text, x, y);
    ctx.textAlign = "left";
}

function drawTable(ctx, { title, color, seats, top }) {
    ctx.fillStyle = color;
    ctx.fillRect(PADDING, top + 12, 6, 24);
    ctx.fillStyle = COLORS.text;
    ctx.font = font(24, "bold");
    ctx.fillText(title, PADDING + 18, top + 33);

    const headTop = top + TABLE_TITLE_HEIGHT;
    ctx.fillStyle = COLORS.head;
    ctx.fillRect(PADDING, headTop, WIDTH - PADDING * 2, COLUMN_HEAD_HEIGHT);
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(19);
    ctx.fillText("营业部", COLUMNS.name, headTop + 29);
    rightText(ctx, "买入", COLUMNS.buy, headTop + 29);
    rightText(ctx, "卖出", COLUMNS.sell, headTop + 29);
    rightText(ctx, "净额", COLUMNS.net, headTop + 29);

    const rowsTop = headTop + COLUMN_HEAD_HEIGHT;
    if (!seats.length) {
        ctx.fillStyle = COLORS.muted;
        ctx.font = font(20);
        ctx.fillText("暂无数据", COLUMNS.name, rowsTop + 35);
        return rowsTop + ROW_HEIGHT;
    }
    seats.forEach((seat, index) => {
        const y = rowsTop + index * ROW_HEIGHT;
        ctx.fillStyle = index % 2 === 0 ? COLORS.panel : COLORS.background;
        ctx.fillRect(PADDING, y, WIDTH - PADDING * 2, ROW_HEIGHT);
        const baseline = y + 35;
        ctx.fillStyle = COLORS.muted;
        ctx.font = font(20);
        ctx.fillText(String(index + 1), COLUMNS.index, baseline);
        ctx.fillStyle = COLORS.text;
        ctx.font = font(22);
        ctx.fillText(fitText(ctx, shortSeatName(seat.name), COLUMNS.nameMaxWidth), COLUMNS.name, baseline);
        ctx.font = font(21);
        rightText(ctx, tableAmount(seat.buy), COLUMNS.buy, baseline);
        rightText(ctx, tableAmount(seat.sell), COLUMNS.sell, baseline);
        ctx.fillStyle = signColor(seat.net);
        ctx.font = font(21, "bold");
        rightText(ctx, tableAmount(seat.net, true), COLUMNS.net, baseline);
    });
    ctx.fillStyle = COLORS.grid;
    ctx.fillRect(PADDING, rowsTop + seats.length * ROW_HEIGHT, WIDTH - PADDING * 2, 1);
    return rowsTop + seats.length * ROW_HEIGHT;
}

function generateSeatChart({ date, detail }) {
    const height = HEADER_HEIGHT
        + detail.groups.reduce((sum, group) => sum + groupHeight(group) + GROUP_GAP, 0)
        + FOOTER_HEIGHT;
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, WIDTH, height);

    ctx.fillStyle = COLORS.text;
    ctx.font = font(38, "bold");
    ctx.fillText(`${detail.name}  ${detail.symbol}`, PADDING, 62);
    const nameWidth = ctx.measureText(`${detail.name}  ${detail.symbol}`).width;
    if (Number.isFinite(detail.changePct)) {
        ctx.fillStyle = signColor(detail.changePct);
        ctx.font = font(30, "bold");
        ctx.fillText(`${detail.changePct >= 0 ? "+" : ""}${detail.changePct.toFixed(2)}%`, PADDING + nameWidth + 20, 62);
    }
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(22);
    ctx.fillText(`${date} 龙虎榜席位`, PADDING, 100);
    ctx.fillStyle = COLORS.grid;
    ctx.fillRect(PADDING, HEADER_HEIGHT - 6, WIDTH - PADDING * 2, 2);

    let top = HEADER_HEIGHT;
    for (const group of detail.groups) {
        // 图表字体不含emoji，用色块标记上榜原因
        ctx.fillStyle = COLORS.accent;
        ctx.fillRect(PADDING, top + 18, 10, 28);
        ctx.fillStyle = COLORS.text;
        ctx.font = font(26, "bold");
        ctx.fillText(compactReason(group.reason), PADDING + 22, top + 42);
        ctx.fillStyle = COLORS.muted;
        ctx.font = font(20);
        const totals = `成交${tableAmount(group.dealAmount)}  买入${tableAmount(group.buyTotal)}  卖出${tableAmount(group.sellTotal)}`;
        ctx.fillText(totals, PADDING, top + 74);
        ctx.fillStyle = signColor(group.netAmount);
        ctx.font = font(22, "bold");
        rightText(ctx, `净额 ${signedMoney(group.netAmount)}`, COLUMNS.net, top + 74);

        let tableTop = top + GROUP_TITLE_HEIGHT;
        tableTop = drawTable(ctx, { title: "买入金额前5", color: COLORS.up, seats: group.buyers, top: tableTop }) + TABLE_GAP;
        top = drawTable(ctx, { title: "卖出金额前5", color: COLORS.down, seats: group.sellers, top: tableTop }) + GROUP_GAP;
    }

    ctx.fillStyle = COLORS.muted;
    ctx.font = font(17);
    ctx.fillText("数据来源：沪深北交易所当日公开信息（同花顺整理），仅供参考，不构成投资建议。", PADDING, height - 22);
    return canvas.toBuffer("image/png");
}

module.exports = { generateSeatChart };
