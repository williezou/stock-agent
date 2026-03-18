function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function truncate(text, max) {
    if (!text) return "";
    const t = String(text).trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function formatTelegramMessage({ resultsByStyle, now, newsService }) {
    const styles = ["intraday", "short", "swing", "mid"];
    const styleLabels = {
        intraday: "日内",
        short: "短线",
        swing: "波段",
        mid: "中线"
    };
    const NEWS_CONTENT_MAX_CHARS = 120;

    const sections = [];
    for (const style of styles) {
        const top5 = resultsByStyle[style] || [];
        const symbolLine = top5.length
            ? `代码: <code>${top5.map(r => r.symbol).join(" ")}</code>`
            : "";
        const lines = top5.map((r, i) => {
            const scoreText = Number.isFinite(r.score) ? r.score.toFixed(1) : r.score;
            const base = `${i + 1}. <code>${r.symbol}</code> ${r.name || ""} | 分数:${scoreText} | 涨幅:${r.gap} | 量:${r.volume} | 新闻:${r.newsCount || 0} | 公告:${r.annCount || 0}`;
            if (style !== "mid") return base;
            if (!r.buy) return `${base} | 买点: 无`;
            const buy = `买点:${r.buy.entry.toFixed(2)} 止损:${r.buy.stop.toFixed(2)} 量比:${r.buy.volRatio.toFixed(2)}`;
            return `${base} | ${buy}`;
        });
        const newsLines = top5.flatMap(r => {
            if (!r.news || r.news.length === 0) return [];
            const head = `${r.symbol} ${r.name || ""} 新闻:`;
            const items = r.news.map(n => {
                const title = escapeHtml(n.title || "");
                const url = n.url || "";
                const content = truncate(n.content || "", NEWS_CONTENT_MAX_CHARS);
                const contentText = content ? `（${escapeHtml(content)}）` : "（无摘要）";
                const source = escapeHtml(n.source || newsService.sourceFromUrl(url) || "来源未知");
                const prefix = `［${source}］`;
                return url ? `- ${prefix} <a href="${url}">${title}</a> ${contentText}` : `- ${prefix} ${title} ${contentText}`;
            });
            return [head, ...items];
        });
        const annLines = top5.flatMap(r => {
            if (!r.announcements || r.announcements.length === 0) return [];
            const head = `${r.symbol} ${r.name || ""} 公告:`;
            const items = r.announcements.map(a => {
                const title = escapeHtml(a.title || "");
                const url = a.url || "";
                return url ? `- <a href="${url}">${title}</a>` : `- ${title}`;
            });
            return [head, ...items];
        });

        const block =
            `<b>${styleLabels[style]} Top5</b>\n` +
            (lines.length ? lines.join("\n") : "无符合条件标的") +
            (symbolLine ? `\n${symbolLine}` : "") +
            (newsLines.length ? `\n<b>新闻详情</b>\n${newsLines.join("\n")}` : "") +
            (annLines.length ? `\n<b>公告详情</b>\n${annLines.join("\n")}` : "");
        sections.push(block);
    }

    return `<b>A股扫描</b>\n${now}\n\n${sections.join("\n\n")}`;
}

module.exports = { formatTelegramMessage };
