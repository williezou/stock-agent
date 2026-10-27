// Telegram HTML消息的通用格式化工具

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function number(value, digits = 2) {
    return Number.isFinite(value) ? value.toFixed(digits) : "不可用";
}

function signed(value, suffix = "%") {
    if (!Number.isFinite(value)) return "不可用";
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function money(value) {
    if (!Number.isFinite(value)) return "不可用";
    if (value >= 100000000) return `${(value / 100000000).toFixed(2)}亿元`;
    if (value >= 10000) return `${(value / 10000).toFixed(2)}万元`;
    return `${value.toFixed(0)}元`;
}

function shortText(value, max = 62) {
    const text = String(value || "").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 只允许http(s)链接进入消息，防止javascript:等协议注入
function safeHttpUrl(value) {
    try {
        const url = new URL(String(value || ""));
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
    } catch {
        return "";
    }
}

// 新闻/公告条目：“日期｜标题链接”
function linkLine(item) {
    const title = escapeHtml(shortText(item.title || "未命名信息"));
    const url = safeHttpUrl(item.url);
    const date = String(item.date || item.time || "").slice(0, 10);
    const prefix = date ? `${escapeHtml(date)}｜` : "";
    return url ? `${prefix}<a href="${escapeHtml(url)}">${title}</a>` : `${prefix}${title}`;
}

module.exports = { escapeHtml, linkLine, money, number, safeHttpUrl, shortText, signed };
