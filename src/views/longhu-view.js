const { escapeHtml, money, shortText, signed } = require("./format");
const { StockLink, stockLinkLegend } = require("./stock-link");

// 每日龙虎榜推送：上榜概况 + 净买入/净卖出排行
const TOP_BUY = 10;
const TOP_SELL = 5;
const REASON_MAX_CHARS = 30;

// 交易所上榜原因措辞冗长且沪深北写法不一：先统一措辞，再压缩常见句式，
// 例如“有价格涨跌幅限制的连续3个交易日内收盘价格涨幅偏离值累计达到30%的证券”→“3日涨幅偏离30%”
const REASON_NORMALIZE = [
    [/^.*?(?=连续|当日|日[涨跌换振价收]|日均|严重异常)/, ""], // 去掉“有价格涨跌幅限制的”“非ST、*ST和S证券”“北交所股票”等前缀
    [/连续三个/, "连续3个"],
    [/股票/, "证券"],
    [/的前[五5]只证券/, "的证券"], // 东方财富“前5只证券”与同花顺“的证券”统一
    [/当日/, "日"],
    [/收盘价格?/, ""],
    [/较基准指数/, ""], // 同花顺“涨幅较基准指数偏离值”
    [/价格振幅|振幅值/, "振幅"],
    [/\([+-]?\d+%\)/, ""], // 北交所“+40%(-40%)”写法
    [/[+-](\d+%)/g, "$1"]
];
const REASON_RULES = [
    [/连续(\d+)个交易日内[，,]?日?(涨跌|涨|跌)幅偏离值累计达到?(\d+%)(?:的?证券)?/, "$1日$2幅偏离$3"],
    [/连续(\d+)个交易日内[，,]?日均换手率与前五个交易日的日均换手率的比值达到(\d+)倍.*/, "$1日换手放大$2倍"],
    [/严重异常期间日?(涨|跌)幅偏离值累计达到?(\d+%)(?:的?证券)?/, "严重异常$1幅偏离$2"],
    [/日(涨|跌)幅偏离值达到?(\d+%)的证券/, "日$1幅偏离$2"],
    [/日换手率达到?(\d+%)的证券/, "换手率$1"],
    [/日(涨|跌)幅达到?(\d+%)的证券/, "日$1幅$2"],
    [/日振幅达到?(\d+%)的证券/, "振幅$1"],
    [/退市整理期/, "退市整理"]
];

function rewrite(text, rules) {
    return rules.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

function compactReason(reason) {
    return String(reason || "")
        .split(/[；;]/) // 东方财富用全角分号，同花顺单条原因内用半角分号
        .map(part => rewrite(rewrite(part.trim(), REASON_NORMALIZE), REASON_RULES))
        .filter((part, index, parts) => part && parts.indexOf(part) === index)
        .join("、");
}

function exchangeOf(symbol) {
    const code = String(symbol || "");
    if (code.startsWith("6")) return "沪";
    if (/^[03]/.test(code)) return "深";
    return "北";
}

// 净买入额带符号，单位亿/万元
function signedMoney(value) {
    return `${value >= 0 ? "+" : "-"}${money(Math.abs(value))}`;
}

// 东方财富“个股某日龙虎榜”详情页（电脑版）：当天的上榜原因与买卖前五席位
function longhuDetailUrl(symbol, date) {
    return `https://data.eastmoney.com/stock/lhb,${date},${symbol}.html`;
}

// 机器人深层链接参数：t.me/<机器人>?start=lhb_002249_20261027，点击后机器人回复该股当日席位
const START_PAYLOAD = /^lhb_(\d{6})_(\d{4})(\d{2})(\d{2})$/;

function longhuStartPayload(symbol, date) {
    return `lhb_${symbol}_${date.replace(/-/g, "")}`;
}

function parseLonghuStartPayload(payload) {
    const match = START_PAYLOAD.exec(String(payload || "").trim());
    return match ? { symbol: match[1], date: `${match[2]}-${match[3]}-${match[4]}` } : null;
}

// 📋 席位图标：有机器人用户名时链接到机器人（手机上直接在Telegram里看席位表格），否则退回东方财富电脑版详情页
function seatLinkUrl(symbol, date, botUsername) {
    return botUsername
        ? `https://t.me/${botUsername}?start=${longhuStartPayload(symbol, date)}`
        : longhuDetailUrl(symbol, date);
}

// 股票名称经 StockLink 渲染（名称链接所选App），龙虎榜额外附 📋（查看席位）
function longhuStock(item, date, botUsername, app, options = {}) {
    return StockLink.of(item, app).html({ ...options, extraLinks: [{ label: SEAT_ICON, url: seatLinkUrl(item.symbol, date, botUsername) }] });
}

function boardLine(item, index, date, botUsername, app) {
    const reason = escapeHtml(shortText(compactReason(item.reason), REASON_MAX_CHARS)) || "—";
    return `${index + 1}. ${longhuStock(item, date, botUsername, app)} ${signed(item.changePct)}｜净额 ${signedMoney(item.netAmount)}\n　${reason}`;
}

// 文字消息与图表共用的榜单统计：分市场家数、上涨家数、合计净买入、净买入/净卖出排行
function summarizeBoard(board) {
    const counts = { 沪: 0, 深: 0, 北: 0 };
    for (const item of board) counts[exchangeOf(item.symbol)]++;
    return {
        total: board.length,
        counts,
        upCount: board.filter(item => item.changePct > 0).length,
        totalNet: board.reduce((sum, item) => sum + item.netAmount, 0),
        buyers: board.filter(item => item.netAmount > 0).sort((a, b) => b.netAmount - a.netAmount).slice(0, TOP_BUY),
        sellers: board.filter(item => item.netAmount < 0).sort((a, b) => a.netAmount - b.netAmount).slice(0, TOP_SELL)
    };
}

function overviewLine(summary) {
    const { total, counts, upCount, totalNet } = summary;
    return `上榜${total}只（沪${counts.沪} 深${counts.深} 北${counts.北}），上涨${upCount}只｜榜单合计净买入 ${signedMoney(totalNet)}`;
}

const SOURCE_NOTE = "数据来源：沪深北交易所当日公开信息（同花顺/东方财富整理），仅供参考，不构成投资建议。";
const OPT_OUT_NOTE = "发送 /longhu off 可关闭龙虎榜推送。";
const SEAT_ICON = "📋";
function linkNote(app) {
    return `点${SEAT_ICON}查看当日买卖席位；${stockLinkLegend(app)}。`;
}
const BUTTON_NOTE = "点下方股票名称查看当日买卖席位（前10只为净买入，其后为净卖出）。";

// 文字版（图表生成失败时的后备）
function formatLonghuMessage({ date, board, botUsername, app }) {
    const summary = summarizeBoard(board);
    const sections = [`<b>🐉 龙虎榜｜${escapeHtml(date)}</b>\n${overviewLine(summary)}`];
    const line = (item, index) => boardLine(item, index, date, botUsername, app);
    if (summary.buyers.length) sections.push([`<b>💰 净买入前${summary.buyers.length}</b>`, ...summary.buyers.map(line)].join("\n"));
    if (summary.sellers.length) sections.push([`<b>📉 净卖出前${summary.sellers.length}</b>`, ...summary.sellers.map(line)].join("\n"));
    sections.push(`<i>${linkNote(app)}</i>\n<i>${SOURCE_NOTE}</i>\n<i>${OPT_OUT_NOTE}</i>`);
    // 最多15行明细，长度远低于Telegram 4096字符上限
    return sections.join("\n\n");
}

// 图表版的图片说明：只放概况，股票的席位与App跳转在图片下方的按钮里
function formatLonghuCaption({ date, board }) {
    const head = `<b>🐉 龙虎榜｜${escapeHtml(date)}</b>\n${overviewLine(summarizeBoard(board))}`;
    return `${head}\n<i>${BUTTON_NOTE}${OPT_OUT_NOTE}</i>`;
}

// 席位金额紧凑写法，适配手机一行显示：1.22亿 / 7951万
function compactAmount(value) {
    if (!Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
    return `${Math.round(value / 1e4)}万`;
}

// 图片下方的股票按钮：只放名称（回调按钮，无↗标记，名称能完整显示），每行3个；
// 净买入在前、净卖出另起一行，顺序与图中表格一致。点击后机器人回复该股席位表格
const KEYBOARD_COLUMNS = 3;
const CALLBACK_PREFIX = "lhb:";

function longhuCallbackData(symbol, date) {
    return `${CALLBACK_PREFIX}${symbol}:${date.replace(/-/g, "")}`;
}

function parseLonghuCallbackData(data) {
    const match = /^lhb:(\d{6}):(\d{4})(\d{2})(\d{2})$/.exec(String(data || ""));
    return match ? { symbol: match[1], date: `${match[2]}-${match[3]}-${match[4]}` } : null;
}

function chunk(items, size) {
    const rows = [];
    for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
    return rows;
}

function formatLonghuKeyboard({ date, board }) {
    const summary = summarizeBoard(board);
    const button = item => ({ text: item.name, callback_data: longhuCallbackData(item.symbol, date) });
    return {
        inline_keyboard: [
            ...chunk(summary.buyers.map(button), KEYBOARD_COLUMNS),
            ...chunk(summary.sellers.map(button), KEYBOARD_COLUMNS)
        ]
    };
}

// 席位表格图片下方：[所选App] [其他App…] [电脑版]
function formatSeatKeyboard({ date, symbol, app }) {
    return {
        inline_keyboard: [new StockLink(symbol, "", app).appButtonRow([{ text: "电脑版", url: longhuDetailUrl(symbol, date) }])]
    };
}

// 营业部名称去掉冗长的公司后缀，例如“国泰海通证券股份有限公司武汉紫阳东路证券营业部”→“国泰海通证券武汉紫阳东路”
function shortSeatName(name) {
    return String(name || "")
        .replace(/股份有限公司|有限责任公司|有限公司/g, "")
        .replace(/证券营业部$|营业部$/, "")
        .trim();
}

function seatLine(seat, index) {
    const net = `${seat.net >= 0 ? "+" : ""}${compactAmount(seat.net)}`;
    return `${index + 1}. ${escapeHtml(shortText(shortSeatName(seat.name), 18))}\n　买${compactAmount(seat.buy)} 卖${compactAmount(seat.sell)} 净${net}`;
}

function quoteLinksLine(symbol, date, app) {
    return `📱 行情（可跳转App）：${new StockLink(symbol, "", app).appLinksLine()}\n💻 <a href="${escapeHtml(longhuDetailUrl(symbol, date))}">电脑版龙虎榜详情</a>`;
}

// 点击龙虎榜股票名称后，机器人回复的当日席位明细（每个上榜原因一组）
function formatSeatDetail({ date, detail, app }) {
    const sections = [`🐉 ${StockLink.of(detail, app).html({ bold: true })} ${signed(detail.changePct)}｜${escapeHtml(date)} 龙虎榜`];
    for (const group of detail.groups) {
        const lines = [
            `📌 <b>${escapeHtml(compactReason(group.reason))}</b>`,
            `成交${money(group.dealAmount)}｜买入${money(group.buyTotal)}｜卖出${money(group.sellTotal)}｜净额${signedMoney(group.netAmount)}`
        ];
        if (group.buyers.length) lines.push("🔴 买入前5", ...group.buyers.map(seatLine));
        if (group.sellers.length) lines.push("🟢 卖出前5", ...group.sellers.map(seatLine));
        sections.push(lines.join("\n"));
    }
    sections.push(quoteLinksLine(detail.symbol, date, app));
    return sections.join("\n\n");
}

// 席位表格图片的说明：只放标题，App与电脑版入口在图片下方按钮里
function formatSeatCaption({ date, detail }) {
    return `🐉 <b>${escapeHtml(detail.name)}</b> <code>${detail.symbol}</code> ${signed(detail.changePct)}｜${escapeHtml(date)} 龙虎榜席位`;
}

function formatSeatNotFound({ date, symbol, app }) {
    return `${escapeHtml(date)} 未查询到 ${new StockLink(symbol).html()} 的龙虎榜席位（可能未上榜或数据暂不可用）。\n\n${quoteLinksLine(symbol, date, app)}`;
}

module.exports = {
    SOURCE_NOTE,
    compactReason,
    formatLonghuCaption,
    formatLonghuKeyboard,
    formatLonghuMessage,
    formatSeatKeyboard,
    formatSeatCaption,
    formatSeatDetail,
    formatSeatNotFound,
    longhuDetailUrl,
    longhuCallbackData,
    longhuStartPayload,
    parseLonghuCallbackData,
    parseLonghuStartPayload,
    shortSeatName,
    signedMoney,
    summarizeBoard
};
