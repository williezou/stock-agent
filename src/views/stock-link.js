const { escapeHtml } = require("./format");

// 可跳转App的手机版行情页（两家都没有可直接唤起App的公开链接，手机网页上可一键打开App）
const APPS = [
    {
        key: "eastmoney",
        tag: "🔴", // 东方财富红色图标
        label: "东方财富",
        url: symbol => `https://wap.eastmoney.com/quote/stock/${String(symbol).startsWith("6") ? 1 : 0}.${symbol}.html`
    },
    {
        key: "tonghuashun",
        tag: "🌸", // 同花顺
        label: "同花顺",
        url: symbol => `https://m.10jqka.com.cn/stockpage/hs_${symbol}/`
    }
];

// Telegram消息正文不能插入图片（自定义emoji需机器人购买Fragment用户名），用普通emoji代表App图标
function tagLink(label, url) {
    return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/**
 * 推送与回复中股票名称/代码的统一渲染：名称后跟 🔴 🌸 两个图标，分别链接东方财富、同花顺手机版行情页；
 * 代码保持 <code> 等宽格式（Telegram中可点击复制，且不允许与链接嵌套）。
 *   new StockLink("002249", "大洋电机").html()  →  大洋电机 🔴 🌸 <code>002249</code>
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
        return APPS.map(({ key, tag, label }) => ({ key, tag, label }));
    }

    appUrl(key) {
        const app = APPS.find(item => item.key === key);
        if (!app) throw new Error(`未知的App：${key}`);
        return app.url(this.symbol);
    }

    // 🔴 🌸 两个App图标链接，extraLinks 追加额外图标（如龙虎榜的 📋 席位）
    tags(extraLinks = []) {
        return [...APPS.map(app => tagLink(app.tag, app.url(this.symbol))), ...extraLinks.map(link => tagLink(link.label, link.url))].join(" ");
    }

    // bold：名称加粗；code：是否附带代码；extraLinks：额外标签
    html({ bold = false, code = true, extraLinks = [] } = {}) {
        const codeHtml = `<code>${escapeHtml(this.symbol)}</code>`;
        if (!this.name) return `${codeHtml} ${this.tags(extraLinks)}`;
        const name = bold ? `<b>${escapeHtml(this.name)}</b>` : escapeHtml(this.name);
        return `${name} ${this.tags(extraLinks)}${code ? ` ${codeHtml}` : ""}`;
    }

    // 纯文本名称（不带链接），用于行情概览等不需要跳转、又要控制格式实体数量的场合
    text() {
        return escapeHtml(this.name || this.symbol);
    }

    // 带App全称的按钮行：[🔴 东方财富] [🌸 同花顺]，extraButtons 追加在后
    appButtonRow(extraButtons = []) {
        return [...APPS.map(app => ({ text: `${app.tag} ${app.label}`, url: app.url(this.symbol) })), ...extraButtons];
    }

    // 完整的App名称链接行，用于详情类消息末尾
    appLinksLine() {
        return APPS.map(app => `${app.tag} <a href="${escapeHtml(app.url(this.symbol))}">${app.label}</a>`).join("｜");
    }
}

// 消息末尾的标签说明
const STOCK_LINK_LEGEND = "🔴 东方财富 🌸 同花顺：点击打开手机版行情，可跳转App";

module.exports = { STOCK_LINK_LEGEND, StockLink };
