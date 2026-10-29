const { escapeHtml } = require("./format");
const { QuoteApp } = require("./quote-app");

function tagLink(label, url) {
    return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/**
 * 推送与回复中股票名称/代码的统一渲染：名称本身链接用户选择的行情App（QuoteApp，默认东方财富），
 * 代码保持 <code> 等宽格式（Telegram中可点击复制，且不允许与链接嵌套）。
 *   new StockLink("002249", "大洋电机").html()  →  <a href="…eastmoney…">大洋电机</a> <code>002249</code>
 *   new StockLink("002249", "大洋电机", QuoteApp.get("xueqiu")).html()  →  <a href="https://xueqiu.com/S/SZ002249">大洋电机</a> …
 */
class StockLink {
    constructor(symbol, name = "", app = QuoteApp.DEFAULT) {
        this.symbol = String(symbol);
        this.name = String(name || "");
        this.app = app || QuoteApp.DEFAULT;
    }

    static of(stock, app) {
        return new StockLink(stock.symbol, stock.name, app);
    }

    // 名称链接的地址（所选App）
    url() {
        return this.app.stockUrl(this.symbol);
    }

    // bold：名称加粗；code：是否附带代码；extraLinks：名称后追加的标签（如龙虎榜的 📋 席位）
    html({ bold = false, code = true, extraLinks = [] } = {}) {
        const codeHtml = `<code>${escapeHtml(this.symbol)}</code>`;
        const extras = extraLinks.map(link => ` ${tagLink(link.label, link.url)}`).join("");
        // 没有名称时只能显示代码：代码要保持可复制，不能放进链接
        if (!this.name) return `${codeHtml}${extras}`;
        const label = bold ? `<b>${escapeHtml(this.name)}</b>` : escapeHtml(this.name);
        const name = `<a href="${escapeHtml(this.url())}">${label}</a>`;
        return `${name}${extras}${code ? ` ${codeHtml}` : ""}`;
    }

    // 纯文本名称（不带链接），用于行情概览等不需要跳转、又要控制格式实体数量的场合
    text() {
        return escapeHtml(this.name || this.symbol);
    }

    // 全部App，所选App排在最前
    allApps() {
        return [this.app, ...QuoteApp.all.filter(app => app !== this.app)];
    }

    // 带App全称的按钮行：[所选App] [其他App…]，extraButtons 追加在后
    appButtonRow(extraButtons = []) {
        return [...this.allApps().map(app => ({ text: app.label, url: app.stockUrl(this.symbol) })), ...extraButtons];
    }

    // 完整的App名称链接行，用于详情类消息末尾
    appLinksLine() {
        return this.allApps().map(app => tagLink(app.label, app.stockUrl(this.symbol))).join("｜");
    }
}

// 消息末尾的说明
function stockLinkLegend(app = QuoteApp.DEFAULT) {
    return `点股票名称打开${app.label}`;
}

// 涨/跌方向的按钮标记（emoji 没有红绿箭头，用走势图）
const UP_MARK = "📈";
const DOWN_MARK = "📉";

/**
 * 排行图片下方的股票按钮：按图中顺序每行 columns 个，按钮为“方向标记+名称”，点击打开所选App；自选股名称后加 ⭐。
 *   groups：[{ mark, rows }]，rows 为带 symbol/name 的股票
 */
function stockButtonMarkup(groups, { watchSymbols = new Set(), app = QuoteApp.DEFAULT, columns = 2 } = {}) {
    const buttons = groups.flatMap(({ mark, rows }) => rows.map(row => {
        const stock = new StockLink(row.symbol, String(row.name || "").replace(/\s+/g, ""), app);
        return { text: `${mark}${stock.name || stock.symbol}${watchSymbols.has(stock.symbol) ? "⭐" : ""}`, url: stock.url() };
    }));
    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += columns) inlineKeyboard.push(buttons.slice(i, i + columns));
    return { inline_keyboard: inlineKeyboard };
}

function stockButtonLegend(app = QuoteApp.DEFAULT) {
    return `点下方按钮打开${app.label}`;
}

module.exports = { DOWN_MARK, StockLink, UP_MARK, stockButtonLegend, stockButtonMarkup, stockLinkLegend };
