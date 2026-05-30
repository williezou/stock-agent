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

function formatTelegramMessage({ resultsByStyle, now, newsService, longhiData = {} }) {
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

    // =====================
    // 龙虎榜数据格式化
    // =====================
    const longhiSections = [];

    // 龙虎榜上榜个股
    if (longhiData.boardList && longhiData.boardList.length > 0) {
        const boardLines = longhiData.boardList.slice(0, 15).map((item, i) => {
            const changeText = item.changePct >= 0 
                ? `<code>+${(item.changePct).toFixed(2)}%</code>` 
                : `<code>${(item.changePct).toFixed(2)}%</code>`;
            return `${i + 1}. <code>${item.symbol}</code> ${item.name || ""} | 价格:${item.price.toFixed(2)} | 涨跌:${changeText} | 换手:${(item.turnoverRate).toFixed(2)}% | ${item.boardType || ""}`;
        });
        const boardSection = 
            `<b>🎯 龙虎榜上榜 (${longhiData.boardList.length})</b>\n` +
            (boardLines.length ? boardLines.join("\n") : "无数据");
        longhiSections.push(boardSection);
    }

    // 连续上涨个股
    if (longhiData.riseStocks && longhiData.riseStocks.length > 0) {
        const riseLines = longhiData.riseStocks.slice(0, 10).map((item, i) => {
            return `${i + 1}. <code>${item.symbol}</code> ${item.name || ""} | 价格:${item.price.toFixed(2)} | 涨幅:${(item.changePct).toFixed(2)}% | 连涨${item.consecutiveDays}天`;
        });
        const riseSection = 
            `<b>📈 连续上涨 (${longhiData.riseStocks.length})</b>\n` +
            (riseLines.length ? riseLines.join("\n") : "无数据");
        longhiSections.push(riseSection);
    }

    // 连续下跌个股
    if (longhiData.declineStocks && longhiData.declineStocks.length > 0) {
        const declineLines = longhiData.declineStocks.slice(0, 10).map((item, i) => {
            return `${i + 1}. <code>${item.symbol}</code> ${item.name || ""} | 价格:${item.price.toFixed(2)} | 跌幅:${(item.changePct).toFixed(2)}% | 连跌${item.consecutiveDays}天`;
        });
        const declineSection = 
            `<b>📉 连续下跌 (${longhiData.declineStocks.length})</b>\n` +
            (declineLines.length ? declineLines.join("\n") : "无数据");
        longhiSections.push(declineSection);
    }

    const longhiBlock = longhiSections.length > 0 
        ? `\n\n${longhiSections.join("\n\n")}`
        : "";

    return `<b>A股扫描</b>\n${now}\n\n${sections.join("\n\n")}${longhiBlock}`;
}

module.exports = { formatTelegramMessage };
