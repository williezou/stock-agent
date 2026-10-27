const { PHOTO_CAPTION_LIMIT } = require("../constants");
const { escapeHtml, linkLine, money, number, safeHttpUrl, shortText, signed } = require("./format");

// 每日收盘报告的展示：总览图说明（每页两只股票）与个股图说明
const OVERVIEW_PAGE_SIZE = 2;

const STOCK_FOCUS = {
    "600887": "关注三季报利润修复、减值与回购进度",
    "002380": "关注工业AI/机器人兑现与高换手风险"
};

function formatStockCaption(report, date) {
    const { meta, analysis, plan, news = [], announcements = [] } = report;
    const { latest, ma, macd, rsi, kdj, bollinger } = analysis;
    const catalyst = [...announcements, ...news].find(item => item && item.title);
    const catalystLine = catalyst
        ? `📰 ${linkLine(catalyst)}`
        : "📰 暂无可核验的新公告或催化";
    const plainCatalystLine = catalyst
        ? `📰 ${escapeHtml(shortText(catalyst.title))}`
        : catalystLine;
    const focus = STOCK_FOCUS[meta.symbol] || "关注量能能否延续与板块情绪变化";
    const quoteUrl = safeHttpUrl(meta.quoteUrl);
    const sourceLine = quoteUrl
        ? `🔗 <a href="${escapeHtml(quoteUrl)}">东方财富行情</a>`
        : "🔗 行情来源：东方财富公开接口";
    const lines = [
        `<b>${escapeHtml(meta.name)} ${meta.exchangeCode}｜${escapeHtml(date)}</b>`,
        `💰 收 ${number(latest.close)}元 ${signed(latest.changePct)}｜开/高/低 ${number(latest.open)}/${number(latest.high)}/${number(latest.low)}`,
        `📊 成交额 ${money(latest.amount)}｜换手 ${number(latest.turnover)}%｜5日量比 ${number(analysis.volumeRatio)}x`,
        `🟥涨K　🟩跌K　🟨MA5　🟦MA20　🟢支撑　🔴压力`,
        `📐 MA5/10/20/60 ${number(ma.ma5)}/${number(ma.ma10)}/${number(ma.ma20)}/${number(ma.ma60)}`,
        `⚡ MACD ${number(macd && macd.dif, 3)}/${number(macd && macd.dea, 3)}/${number(macd && macd.histogram, 3)}｜RSI ${number(rsi, 1)}｜K/D/J ${number(kdj && kdj.k, 1)}/${number(kdj && kdj.d, 1)}/${number(kdj && kdj.j, 1)}`,
        `〽️ BOLL 下/中/上 ${number(bollinger && bollinger.lower)}/${number(bollinger && bollinger.middle)}/${number(bollinger && bollinger.upper)}`,
        `🧭 支撑 ${number(analysis.support)}｜压力 ${number(analysis.resistance)}｜20日量价均价 ${number(analysis.weightedClose20)}`,
        `🎯 <b>${plan.recommendation}</b>｜回踩 ${number(plan.entryLow)}～${number(plan.entryHigh)}｜突破 ${number(plan.breakoutTrigger)}`,
        `🛡 止损 ${number(plan.stop)}｜15%目标 ${number(plan.target)}｜盈亏比 ${number(plan.rewardRisk)}:1`,
        `🔎 ${focus}；筹码/机构成本不可可靠验证；跳空可能令实际亏损超过8%。`,
        catalystLine,
        sourceLine
    ];
    // 超长链接会撑爆1024字符限制：依次降级为纯文本标题、去掉行情链接，而不是让整次推送失败
    let caption = lines.join("\n");
    if (caption.length > PHOTO_CAPTION_LIMIT) caption = [...lines.slice(0, -2), plainCatalystLine, sourceLine].join("\n");
    if (caption.length > PHOTO_CAPTION_LIMIT) caption = [...lines.slice(0, -2), plainCatalystLine].join("\n");
    if (caption.length > PHOTO_CAPTION_LIMIT) throw new Error("Telegram图片说明超过1024字符限制");
    return caption;
}

function formatOverviewRow(report) {
    const { meta, analysis, plan } = report;
    const latest = analysis.latest;
    return `<b>${escapeHtml(meta.name)}</b>　${number(latest.close)}元 ${signed(latest.changePct)}　量比${number(analysis.volumeRatio)}x　<b>${plan.recommendation}</b>`;
}

function formatOverviewCaption(reports, date) {
    return [
        `<b>A股每日收盘图览｜${escapeHtml(date)}</b>`,
        ...reports.map(formatOverviewRow),
        "红涨、绿跌；黄色MA5；下方为成交量；虚线为支撑与压力。"
    ].join("\n");
}

function formatDailyCloseDelivery({ reports, date }) {
    const overviewPages = [];
    for (let index = 0; index < reports.length; index += OVERVIEW_PAGE_SIZE) {
        const pageReports = reports.slice(index, index + OVERVIEW_PAGE_SIZE);
        overviewPages.push({
            caption: formatOverviewCaption(pageReports, date),
            filename: `overview-${date}-${overviewPages.length + 1}.png`,
            reports: pageReports
        });
    }
    return {
        overviews: overviewPages,
        stocks: reports.map(report => ({
            caption: formatStockCaption(report, date),
            filename: `${report.meta.symbol}-${date}.png`,
            report
        }))
    };
}

module.exports = {
    formatDailyCloseDelivery,
    formatOverviewCaption,
    formatOverviewRow,
    formatStockCaption
};
