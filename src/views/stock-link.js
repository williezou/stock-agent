const { escapeHtml } = require("./format");

// 东方财富：Telegram 只允许 http(s)/tg 链接，不能直接用 eastmoney:// 协议，改用东方财富的 iOS 通用链接
// mlink.eastmoney.com/h52n/*（其 apple-app-site-association 指向东方财富App）：已装App时点击直接进入个股页，
// 未装时打开中转页。id 参数为App内部地址，格式取自东方财富手机版行情页的“打开App”按钮（仅iOS写法）
const EASTMONEY_APP_LINK = "https://mlink.eastmoney.com/h52n/nlink.html?type=localurl&id=";

function eastmoneyMarket(symbol) {
    return String(symbol).startsWith("6") ? 1 : 0;
}

// 同花顺只提供手机版行情页（网页上可一键打开App）
const APPS = [
    {
        key: "eastmoney",
        label: "东方财富",
        url: symbol => `${EASTMONEY_APP_LINK}${encodeURIComponent(`eastmoney://page/stockpage?code=${symbol}&market=${eastmoneyMarket(symbol)}`)}`
    },
    {
        key: "tonghuashun",
        label: "同花顺",
        url: symbol => `https://m.10jqka.com.cn/stockpage/hs_${symbol}/`
    }
];

function tagLink(label, url) {
    return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/**
 * 推送与回复中股票名称/代码的统一渲染：名称本身链接东方财富（已装App时直接打开个股页），
 * 代码保持 <code> 等宽格式（Telegram中可点击复制，且不允许与链接嵌套）。
 *   new StockLink("002249", "大洋电机").html()  →  <a href="…eastmoney…">大洋电机</a> <code>002249</code>
 */
class StockLink {
    constructor(symbol, name = "") {
        this.symbol = String(symbol);
        this.name = String(name || "");
    }

    static of(stock) {
        return new StockLink(stock.symbol, stock.name);
    }

    static get apps() {
        return APPS.map(({ key, label }) => ({ key, label }));
    }

    appUrl(key) {
        const app = APPS.find(item => item.key === key);
        if (!app) throw new Error(`未知的App：${key}`);
        return app.url(this.symbol);
    }

    // bold：名称加粗；code：是否附带代码；extraLinks：名称后追加的标签（如龙虎榜的 📋 席位）
    html({ bold = false, code = true, extraLinks = [] } = {}) {
        const codeHtml = `<code>${escapeHtml(this.symbol)}</code>`;
        const extras = extraLinks.map(link => ` ${tagLink(link.label, link.url)}`).join("");
        // 没有名称时只能显示代码：代码要保持可复制，不能放进链接
        if (!this.name) return `${codeHtml}${extras}`;
        const label = bold ? `<b>${escapeHtml(this.name)}</b>` : escapeHtml(this.name);
        const name = `<a href="${escapeHtml(this.appUrl("eastmoney"))}">${label}</a>`;
        return `${name}${extras}${code ? ` ${codeHtml}` : ""}`;
    }

    // 纯文本名称（不带链接），用于行情概览等不需要跳转、又要控制格式实体数量的场合
    text() {
        return escapeHtml(this.name || this.symbol);
    }

    // 带App全称的按钮行：[东方财富] [同花顺]，extraButtons 追加在后
    appButtonRow(extraButtons = []) {
        return [...APPS.map(app => ({ text: app.label, url: app.url(this.symbol) })), ...extraButtons];
    }

    // 完整的App名称链接行，用于详情类消息末尾
    appLinksLine() {
        return APPS.map(app => tagLink(app.label, app.url(this.symbol))).join("｜");
    }
}

// 消息末尾的说明
const STOCK_LINK_LEGEND = "点股票名称打开东方财富App";

// 涨/跌方向的按钮标记（emoji 没有红绿箭头，用走势图）
const UP_MARK = "📈";
const DOWN_MARK = "📉";

/**
 * 排行图片下方的股票按钮：按图中顺序每行 columns 个，按钮为“方向标记+名称”，点击打开东方财富；自选股名称后加 ⭐。
 *   groups：[{ mark, rows }]，rows 为带 symbol/name 的股票
 */
function stockButtonMarkup(groups, watchSymbols = new Set(), columns = 2) {
    const buttons = groups.flatMap(({ mark, rows }) => rows.map(row => {
        const stock = new StockLink(row.symbol, String(row.name || "").replace(/\s+/g, ""));
        return { text: `${mark}${stock.name || stock.symbol}${watchSymbols.has(stock.symbol) ? "⭐" : ""}`, url: stock.appUrl("eastmoney") };
    }));
    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += columns) inlineKeyboard.push(buttons.slice(i, i + columns));
    return { inline_keyboard: inlineKeyboard };
}

const STOCK_BUTTON_LEGEND = "点下方按钮打开东方财富App";

module.exports = { DOWN_MARK, STOCK_BUTTON_LEGEND, STOCK_LINK_LEGEND, StockLink, UP_MARK, stockButtonMarkup };
