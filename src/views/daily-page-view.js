const { escapeHtml, linkLine, money, number, signed } = require("./format");
const { deltaText, signedAmount } = require("./fund-flow-view");
const { formatHotMoneyText, seatLabel } = require("./hot-money-view");
const { NOTE: LIMIT_UP_NOTE, countsText, industriesText, summarizeLimitUp, yesterdayText } = require("./limit-up-view");
const { formatLonghuMessage } = require("./longhu-view");
const { chipsLine } = require("./daily-report-view");
const { eventsLine } = require("./stock-events-view");
const { StockLink } = require("./stock-link");

// 每日总结网页：一个入口页（按用户的推送开关列出各段）+ 各段的HTML片段（各任务完成时分别写入，入口页打开时加载）。
// 片段内容复用Telegram推送的文字格式（<b>/<i>/<a>/<code> 本身就是合法HTML），按原换行显示；股票名称链接打开 app（用户选择的行情App）

const STYLE = `
:root { --bg: #f5f7fa; --card: #ffffff; --text: #1e293b; --muted: #64748b; --line: #e2e8f0; --up: #e03131; --down: #16a34a; --accent: #2563eb; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
header { position: sticky; top: 0; z-index: 1; background: var(--card); border-bottom: 1px solid var(--line); padding: 12px 16px 8px; }
h1 { margin: 0; font-size: 20px; }
h1 small { color: var(--muted); font-weight: normal; font-size: 15px; margin-left: 6px; }
nav { display: flex; gap: 8px; overflow-x: auto; padding-top: 8px; }
nav a { flex: none; padding: 4px 12px; border-radius: 999px; background: var(--bg); color: var(--text); text-decoration: none; font-size: 14px; }
main { max-width: 760px; margin: 0 auto; padding: 8px 12px 32px; }
section { scroll-margin-top: 96px; }
h2 { font-size: 18px; margin: 20px 4px 10px; }
.card { background: var(--card); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; box-shadow: 0 1px 2px rgba(15, 23, 42, .06); }
.card img { display: block; width: 100%; height: auto; border-radius: 8px; margin-bottom: 8px; }
.tg { white-space: pre-line; word-break: break-word; }
.tg i, .note { color: var(--muted); font-size: 13px; }
a { color: var(--accent); text-decoration: none; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 14px; color: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
th, td { padding: 8px 4px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--muted); font-weight: normal; font-size: 13px; }
tr:last-child td { border-bottom: none; }
tr.has-sub td { border-bottom: none; padding-bottom: 2px; }
tr.sub td { text-align: left; white-space: normal; color: var(--muted); font-size: 13px; padding-top: 0; }
.up { color: var(--up); } .down { color: var(--down); }
.stock-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.stock-head a { font-size: 18px; font-weight: 600; }
.price { font-size: 18px; font-weight: 600; white-space: nowrap; }
.plan { margin: 4px 0 8px; }
.meta { color: var(--muted); font-size: 14px; }
.event { font-size: 14px; color: #b45309; margin: 2px 0; }
details { margin-top: 6px; }
summary { color: var(--accent); cursor: pointer; font-size: 14px; }
details .tg { margin-top: 6px; font-size: 14px; }
.card > b { display: block; margin-bottom: 4px; }
.pending { color: var(--muted); text-align: center; padding: 20px 0; margin: 0; }
footer { color: var(--muted); font-size: 12px; text-align: center; padding: 0 16px 24px; }
`;

// 片段加载：缺失（任务还没完成）时显示该段的提示
const LOADER = `
document.querySelectorAll("[data-src]").forEach(async el => {
    try {
        const response = await fetch(el.dataset.src, { cache: "no-cache" });
        if (!response.ok) throw new Error(response.status);
        el.innerHTML = await response.text();
    } catch {
        el.innerHTML = '<p class="card pending">' + el.dataset.pending + "</p>";
    }
});
`;

// 入口页：sections 为 [{ id, title, url, pending }]
function dailyPageHtml({ date, sections }) {
    const nav = sections.map(section => `<a href="#${section.id}">${escapeHtml(section.title)}</a>`).join("");
    const body = sections.map(section => [
        `<section id="${section.id}">`,
        `<h2>${escapeHtml(section.title)}</h2>`,
        `<div data-src="${escapeHtml(section.url)}" data-pending="${escapeHtml(section.pending)}"><p class="card pending">加载中…</p></div>`,
        "</section>"
    ].join("")).join("\n");
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>每日总结｜${escapeHtml(date)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>每日总结<small>${escapeHtml(date)}</small></h1><nav>${nav}</nav></header>
<main>
${body}
</main>
<footer>数据来自公开行情，仅供参考，不构成投资建议。</footer>
<script>${LOADER}</script>
</body>
</html>
`;
}

function card(inner) {
    return `<div class="card">${inner}</div>`;
}

function chartImage(url, alt) {
    return url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">` : "";
}

function changeClass(value) {
    if (!Number.isFinite(value) || value === 0) return "";
    return value > 0 ? "up" : "down";
}

// 推送文字末尾的说明（关闭方式、数据来源）在网页里每条都重复，去掉后在段末统一说明
function withoutNotes(text) {
    return text.replace(/\n\n(?:<i>[^\n]*<\/i>\n?)+$/, "");
}

// 个股卡片：名称与涨跌、交易计划、K线图、支撑压力与量能、最新催化；技术指标收在“详情”里
function stockCard({ meta, analysis, plan, news = [], announcements = [], events = [] }, chartUrl, app) {
    const { latest, ma, macd, rsi, kdj, bollinger } = analysis;
    const catalyst = [...announcements, ...news].find(item => item && item.title);
    const indicators = [
        `MA5/10/20/60 ${number(ma.ma5)}/${number(ma.ma10)}/${number(ma.ma20)}/${number(ma.ma60)}`,
        `MACD ${number(macd && macd.dif, 3)}/${number(macd && macd.dea, 3)}/${number(macd && macd.histogram, 3)}｜RSI ${number(rsi, 1)}`,
        `KDJ ${number(kdj && kdj.k, 1)}/${number(kdj && kdj.d, 1)}/${number(kdj && kdj.j, 1)}`,
        `BOLL ${number(bollinger && bollinger.lower)}/${number(bollinger && bollinger.middle)}/${number(bollinger && bollinger.upper)}`,
        `开/高/低 ${number(latest.open)}/${number(latest.high)}/${number(latest.low)}｜20日量价均价 ${number(analysis.weightedClose20)}`,
        `盈亏比 ${number(plan.rewardRisk)}:1；跳空可能令实际亏损超过止损幅度`,
        ...(analysis.chips ? [`70%筹码 ${number(analysis.chips.range70.low)}～${number(analysis.chips.range70.high)}（集中度 ${(analysis.chips.range70.concentration * 100).toFixed(1)}%）；筹码按换手率衰减估算，各家口径不同`] : [])
    ];
    return `<div class="card" id="s-${meta.symbol}">`
        + `<div class="stock-head">${StockLink.of(meta, app).html({ code: false })}`
        + `<span class="price">${number(latest.close)} <span class="${changeClass(latest.changePct)}">${signed(latest.changePct)}</span></span></div>`
        + `<div class="plan"><b>${escapeHtml(plan.recommendation)}</b>｜回踩 ${number(plan.entryLow)}～${number(plan.entryHigh)}｜突破 ${number(plan.breakoutTrigger)}｜止损 ${number(plan.stop)}｜目标 ${number(plan.target)}</div>`
        + chartImage(chartUrl, `${meta.name} K线`)
        + `<div class="meta">支撑 ${number(analysis.support)}｜压力 ${number(analysis.resistance)}｜成交 ${money(latest.amount)}｜量比 ${number(analysis.volumeRatio)}x</div>`
        + (analysis.chips ? `<div class="meta">${escapeHtml(chipsLine(analysis.chips))}</div>` : "")
        + (events.length ? `<div class="event">${eventsLine(events)}</div>` : "")
        + (catalyst ? `<div class="meta">📰 ${linkLine(catalyst)}</div>` : "")
        + `<details><summary>技术指标</summary><div class="tg">${indicators.join("\n")}</div></details>`
        + "</div>";
}

// 自选股收盘：总览表（点名称跳到下方个股）+ 每只一张卡片
function closeFragment({ reports, chartUrls, app }) {
    const rows = reports.map(({ meta, analysis, plan }) => {
        const latest = analysis.latest;
        return `<tr><td><a href="#s-${meta.symbol}">${escapeHtml(meta.name || meta.symbol)}</a></td>`
            + `<td>${number(latest.close)}</td>`
            + `<td class="${changeClass(latest.changePct)}">${signed(latest.changePct)}</td>`
            + `<td><b>${escapeHtml(plan.recommendation)}</b></td></tr>`;
    });
    const table = card(`<table><thead><tr><th>名称</th><th>收盘</th><th>涨跌</th><th>建议</th></tr></thead><tbody>${rows.join("")}</tbody></table>`);
    return [table, ...reports.map(report => stockCard(report, chartUrls.get(report.meta.symbol), app))].join("\n");
}

// 盘中异动回顾：当天所有推送合并成两张清单（量价异动、资金异动），按时间排序，不标自选股
function stockCell(row, app) {
    return new StockLink(row.symbol, String(row.name || "").replace(/\s+/g, ""), app).html({ code: false });
}

function pctCell(value) {
    return `<td class="${changeClass(value)}">${signed(value)}</td>`;
}

function listCard(title, head, rows) {
    return card(`<b>${title}</b><table><thead><tr>${head.map(text => `<th>${text}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
}

function intradayFragment({ alerts, app }) {
    const spikes = [];
    const flows = [];
    let lookback = 5;
    for (const { label, content } of alerts) {
        if (label.startsWith("量价:")) lookback = content.lookbackMinutes ?? content.minutes ?? lookback;
        // 早期的量价异动记录没有每只股票的触发时间，用推送时间
        if (label.startsWith("量价:")) spikes.push(...[...content.up, ...content.down].map(row => ({ ...row, time: row.time || content.time })));
        else flows.push(...[...content.inflow, ...content.outflow].map(row => ({ ...row, time: content.time })));
    }
    if (!spikes.length && !flows.length) return card('<p class="pending">今日没有盘中异动推送</p>');
    const byTime = (a, b) => a.time.localeCompare(b.time);
    const parts = [];
    if (spikes.length) {
        const upCount = spikes.filter(row => row.windowChange > 0).length;
        parts.push(listCard(
            `量价异动 ${spikes.length}只（急涨${upCount}、急跌${spikes.length - upCount}）`,
            ["时间", "名称", `${lookback}分钟`, "成交", "今日"],
            spikes.sort(byTime).map(row => `<tr><td>${row.time}</td><td>${stockCell(row, app)}</td>${pctCell(row.windowChange)}<td>${signedAmount(row.windowAmount).replace(/^\+/, "")}</td>${pctCell(row.changePct)}</tr>`)
        ));
    }
    if (flows.length) {
        parts.push(listCard(
            `尾盘资金异动 ${flows.length}只`,
            ["时间", "名称", "主力净额变化", "今日"],
            flows.sort(byTime).map(row => `<tr><td>${row.time}</td><td>${stockCell(row, app)}</td><td class="${changeClass(row.delta)}"><b>${deltaText(row)}</b></td>${pctCell(row.changePct)}</tr>`)
        ));
    }
    parts.push(`<p class="note">量价异动：${lookback}分钟内涨跌幅变化与成交额（沪市上交所、深市新浪财经行情）；资金异动：主力净额为数据商按大单估算，非交易所官方口径。</p>`);
    return parts.join("\n");
}

// 图表 + 收起的明细（明细里的名称可跳转App，龙虎榜的 📋 跳回机器人查看席位）；图表生成失败时明细直接展开
function chartWithDetails(chartUrl, alt, summary, text) {
    if (!chartUrl) return card(`<div class="tg">${text}</div>`);
    return card(`${chartImage(chartUrl, alt)}<details><summary>${summary}</summary><div class="tg">${text}</div></details>`);
}

function longhuFragment({ date, board, botUsername, chartUrl, app }) {
    return chartWithDetails(chartUrl, "龙虎榜", "榜单明细（点📋查看买卖席位）", withoutNotes(formatLonghuMessage({ date, board, botUsername, app })));
}

function hotMoneyFragment({ content, chartUrl, app }) {
    return chartWithDetails(chartUrl, "游资动向", "游资明细", withoutNotes(formatHotMoneyText(content, { app })));
}

// 涨停复盘：概况 + 梯队图 + 各连板层级明细（附相关公告/新闻）+ 首板按行业分组；跌停与炸板收在详情里
function limitUpLevelCard(level, { app, catalysts }) {
    const rows = level.stocks.map(stock => {
        const catalyst = catalysts && catalysts[stock.symbol];
        const row = `<tr${catalyst ? ' class="has-sub"' : ""}><td>${stockCell(stock, app)}</td><td>${escapeHtml(stock.industry)}</td><td>${stock.firstTime}</td><td>${stock.breaks || "—"}</td><td>${signedAmount(stock.sealAmount).replace(/^\+/, "")}</td></tr>`;
        return catalyst ? `${row}<tr class="sub"><td colspan="5">📰 ${linkLine(catalyst)}</td></tr>` : row;
    });
    return listCard(`${level.boards}连板（${level.stocks.length}只）`, ["名称", "行业", "首封", "炸板", "封单"], rows);
}

function firstBoardCard(firstBoard, app) {
    const groups = new Map();
    for (const stock of firstBoard) {
        const key = stock.industry || "其他";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(stock);
    }
    const lines = [...groups.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([industry, stocks]) => `<b>${escapeHtml(industry)}</b>（${stocks.length}）：${stocks.map(stock => stockCell(stock, app)).join("、")}`);
    return card(`<b>首板 ${firstBoard.length}只（按行业）</b><div class="tg">${lines.join("\n")}</div>`);
}

function collapsedList(title, head, rows) {
    if (!rows.length) return "";
    return card(`<details><summary>${title}</summary><table><thead><tr>${head.map(text => `<th>${text}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></details>`);
}

function limitUpFragment({ content, chartUrl, app }) {
    const summary = summarizeLimitUp(content);
    const head = [countsText(summary), yesterdayText(summary), industriesText(summary)].filter(Boolean).map(escapeHtml).join("<br>");
    const parts = [card(`${head}${chartImage(chartUrl, "涨停复盘")}`)];
    parts.push(...summary.ladder.map(level => limitUpLevelCard(level, { app, catalysts: content.catalysts })));
    if (summary.firstBoard.length) parts.push(firstBoardCard(summary.firstBoard, app));
    parts.push(collapsedList(`跌停 ${content.limitDown.length}只`, ["名称", "行业", "连跌", "开板"],
        content.limitDown.map(stock => `<tr><td>${stockCell(stock, app)}</td><td>${escapeHtml(stock.industry)}</td><td>${stock.days}天</td><td>${stock.opens}次</td></tr>`)));
    parts.push(collapsedList(`炸板 ${content.broken.length}只`, ["名称", "行业", "首封", "炸板", "收盘"],
        content.broken.map(stock => `<tr><td>${stockCell(stock, app)}</td><td>${escapeHtml(stock.industry)}</td><td>${stock.firstTime}</td><td>${stock.breaks}次</td>${pctCell(stock.changePct)}</tr>`)));
    parts.push(`<p class="note">${escapeHtml(LIMIT_UP_NOTE)}。</p>`);
    return parts.filter(Boolean).join("\n");
}

// 推送消息下方打开网页的按钮
function dailyPageButton(url) {
    return { inline_keyboard: [[{ text: "📄 打开今日总结", url }]] };
}

// 收盘推送：概况（每只一行）+ 按钮，明细在网页里
function closeMessage({ reports, date, app }) {
    // 有事件（解禁、财报披露等）的股票标 ⚠️，明细在网页里
    const rows = reports.map(({ meta, analysis, plan, events = [] }) =>
        `${StockLink.of(meta, app).html({ bold: true, code: false })} ${number(analysis.latest.close)} ${signed(analysis.latest.changePct)}　<b>${escapeHtml(plan.recommendation)}</b>${events.length ? " ⚠️" : ""}`);
    return [`<b>📊 每日收盘总结｜${escapeHtml(date)}</b>`, ...rows, "<i>K线、技术指标、交易计划、⚠️事件与盘中异动回顾见网页。</i>"].join("\n");
}

// 龙虎榜与游资动向写入网页后的推送：游资要点 + 按钮
function longhuUpdatedMessage({ date, hotMoney }) {
    const lines = [`<b>🐉 龙虎榜与游资动向已更新｜${escapeHtml(date)}</b>`];
    if (hotMoney && hotMoney.seats.length) {
        const top = hotMoney.seats[0];
        lines.push(`高胜率游资出手${(hotMoney.highWinSeats || []).length}家｜净买入第一：${escapeHtml(seatLabel(top))} ${signedAmount(top.net)}`);
    }
    lines.push("<i>榜单、买卖席位与游资明细见网页。</i>");
    return lines.join("\n");
}

module.exports = {
    closeFragment,
    closeMessage,
    longhuUpdatedMessage,
    dailyPageButton,
    dailyPageHtml,
    hotMoneyFragment,
    intradayFragment,
    limitUpFragment,
    longhuFragment
};
