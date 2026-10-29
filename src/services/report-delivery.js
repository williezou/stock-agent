const { config } = require("../config");
const telegram = require("../gateways/telegram");
const { delay } = require("../lib/async");
const { formatError } = require("../lib/http");
const { generateOverviewChart, generateStockChart } = require("../views/charts/stock-charts");
const { formatDailyCloseDelivery } = require("../views/daily-report-view");
const { formatScanDelivery, formatScanSummary } = require("../views/scan-view");

// Telegram同一会话连续发送的间隔，避免触发限流
const SEND_GAP_MS = 350;
const SUMMARY_RETRY_DELAY_MS = 2000;

// 每日收盘报告：先发总览图，再逐只发个股图；dryRun时只在控制台打印。app：股票名称链接打开的行情App
async function deliverDailyClose({ chatId, reports, date, app, dryRun = false }) {
    const delivery = formatDailyCloseDelivery({ reports, date, app });
    if (dryRun) {
        delivery.overviews.forEach((item, index) => {
            const overviewChart = generateOverviewChart(item.reports, date);
            console.log(`\n===== Telegram 总览图 ${index + 1}/${delivery.overviews.length}（${overviewChart.length} bytes）=====\n${item.caption}`);
        });
        delivery.stocks.forEach((item, index) => {
            const chart = generateStockChart(item.report);
            console.log(`\n===== Telegram 图表 ${index + 1}/${delivery.stocks.length}（${chart.length} bytes）=====\n${item.caption}`);
        });
        return delivery;
    }
    if (!config.telegram.botToken || !chatId) {
        throw new Error("缺少TELEGRAM_BOT_TOKEN或目标chat_id，未发送任何消息");
    }
    for (const item of delivery.overviews) {
        await telegram.sendPhoto(chatId, generateOverviewChart(item.reports, date), item.caption, item.filename);
        await delay(SEND_GAP_MS);
    }
    for (const item of delivery.stocks) {
        await delay(SEND_GAP_MS);
        await telegram.sendPhoto(chatId, generateStockChart(item.report), item.caption, item.filename);
    }
    return delivery;
}

// A股扫描：结论文字 + 分类总览图 + 可操作标的个股图。每条消息独立发送，单张失败不影响其余内容；
// 结论文字（含操作建议）最重要，首次失败时在图片发完后再补发一次，不重发已成功的图片
async function deliverScan({ chatId, summary, delivery, date, dryRun = false }) {
    if (dryRun) {
        console.log(`\n===== 扫描结论（${summary.length}字符）=====\n${summary}`);
        for (const item of delivery.overviews) {
            const png = generateOverviewChart(item.reports, date, item.title);
            console.log(`\n===== 总览图 ${item.filename}（${png.length} bytes）=====\n${item.caption}`);
        }
        for (const item of delivery.stocks) {
            const png = generateStockChart(item.report);
            console.log(`\n===== 个股图 ${item.filename}（${png.length} bytes）=====\n${item.caption}`);
        }
        return { sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;
    async function sendStep(label, send) {
        try {
            await send();
            sent++;
            return true;
        } catch (error) {
            failed++;
            console.log(`⚠️ ${label} 发送失败:`, formatError(error));
            return false;
        }
    }
    const summarySent = await sendStep("扫描结论", () => telegram.sendMessage(chatId, summary));
    for (const item of delivery.overviews) {
        await delay(SEND_GAP_MS);
        await sendStep(item.filename, () =>
            telegram.sendPhoto(chatId, generateOverviewChart(item.reports, date, item.title), item.caption, item.filename)
        );
    }
    for (const item of delivery.stocks) {
        await delay(SEND_GAP_MS);
        await sendStep(item.filename, () =>
            telegram.sendPhoto(chatId, generateStockChart(item.report), item.caption, item.filename)
        );
    }
    if (!summarySent) {
        // 补发针对的是同一条消息：成功则抵消首次失败，失败也不重复计数
        await delay(SUMMARY_RETRY_DELAY_MS);
        try {
            await telegram.sendMessage(chatId, summary);
            sent++;
            failed--;
        } catch (error) {
            console.log("⚠️ 扫描结论（补发）发送失败:", formatError(error));
        }
    }
    return { sent, failed };
}

// 由扫描结果生成结论与图表并推送；返回 { sent, failed, total }
async function deliverScanResult({ chatId, result, now, dryRun = false }) {
    const summary = formatScanSummary({ now, picksByStyle: result.picksByStyle, longhiData: result.longhiData });
    const delivery = formatScanDelivery({ picksByStyle: result.picksByStyle, date: result.date });
    const { sent, failed } = await deliverScan({ chatId, summary, delivery, date: result.date, dryRun });
    return { sent, failed, total: 1 + delivery.overviews.length + delivery.stocks.length };
}

module.exports = { deliverDailyClose, deliverScan, deliverScanResult };
