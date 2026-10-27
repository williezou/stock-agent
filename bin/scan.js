// A股扫描（推送给管理员）；加 --dry-run 只打印不发送
const { config } = require("../src/config");
const { formatError } = require("../src/lib/http");
const { nowChinaString } = require("../src/models/market/trading-calendar");
const { deliverScan } = require("../src/services/report-delivery");
const { runScan } = require("../src/services/scan");
const { formatScanDelivery, formatScanSummary } = require("../src/views/scan-view");

async function main({ dryRun = process.argv.includes("--dry-run") } = {}) {
    const result = await runScan();
    if (!result.ok) {
        console.log(`🛑 ${result.reason}`);
        return;
    }
    const summary = formatScanSummary({ now: nowChinaString(), picksByStyle: result.picksByStyle, longhiData: result.longhiData });
    const delivery = formatScanDelivery({ picksByStyle: result.picksByStyle, date: result.date });
    if (!dryRun && (!config.telegram.botToken || !config.telegram.adminChatId)) {
        console.log("⚠️ 未配置TELEGRAM_BOT_TOKEN或TELEGRAM_CHAT_ID，跳过推送");
        return;
    }

    const { sent, failed } = await deliverScan({
        chatId: config.telegram.adminChatId,
        summary,
        delivery,
        date: result.date,
        dryRun
    });
    if (dryRun) return;
    console.log(`✅ 已发送${sent}条消息（结论、${delivery.overviews.length}张分类总览图、${delivery.stocks.length}张个股图），失败${failed}条`);
    if (failed) process.exitCode = 1;
}

main().catch(error => {
    console.log("❌ 扫描失败:", formatError(error));
    process.exitCode = 1;
});
