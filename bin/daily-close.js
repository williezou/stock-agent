// 单次运行的每日收盘报告（推送给管理员）；加 --dry-run 只打印不发送
const { config } = require("../src/config");
const { formatError } = require("../src/lib/http");
const { buildReports } = require("../src/services/daily-report");
const { deliverDailyClose } = require("../src/services/report-delivery");

async function runDailyClose({ dryRun = process.argv.includes("--dry-run") } = {}) {
    console.log(`📈 开始生成每日自选股收盘分析${dryRun ? "（试运行）" : ""}...`);
    const result = await buildReports({ dryRun });
    if (result.skipped) {
        console.log(`🛑 本次不推送：${result.reason}`);
        return;
    }
    const delivery = await deliverDailyClose({
        chatId: config.telegram.adminChatId,
        reports: result.reports,
        date: result.date,
        dryRun
    });
    if (!dryRun) {
        console.log(`✅ 已向Telegram发送${delivery.overviews.length}张总览图和${delivery.stocks.length}张${result.date}个股图表`);
    }
}

runDailyClose().catch(error => {
    console.error(`❌ 每日收盘任务失败：${formatError(error)}`);
    process.exitCode = 1;
});
