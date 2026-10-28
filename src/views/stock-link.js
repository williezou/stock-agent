const { escapeHtml } = require("./format");

// 可跳转App的手机版行情页（两家都没有可直接唤起App的公开链接，手机网页上可一键打开App）
const APPS = [
    {
        key: "eastmoney",
        label: "东方财富",
        url: symbol => `https://wap.eastmoney.com/quote/stock/${String(symbol).startsWith("6") ? 1 : 0}.${symbol}.html`
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
 * 推送与回复中股票名称/代码的统一渲染：名称本身链接东方财富手机版行情页（可跳转App），
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
const STOCK_LINK_LEGEND = "点股票名称打开东方财富行情（可跳转App）";

module.exports = { STOCK_LINK_LEGEND, StockLink };
