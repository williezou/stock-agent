// A股扫描（推送给管理员），由GitHub Actions定时执行；加 --dry-run 只打印不发送
const { config } = require("../src/config");
const { formatError } = require("../src/lib/http");
const { nowChinaString } = require("../src/models/market/trading-calendar");
const { deliverScanResult } = require("../src/services/report-delivery");
const { runScan } = require("../src/services/scan");

async function main({ dryRun = process.argv.includes("--dry-run") } = {}) {
    if (!dryRun && (!config.telegram.botToken || !config.telegram.adminChatId)) {
        console.log("⚠️ 未配置TELEGRAM_BOT_TOKEN或TELEGRAM_CHAT_ID，跳过推送");
        return;
    }
    const result = await runScan();
    if (!result.ok) {
        console.log(`🛑 ${result.reason}`);
        // 非交易日正常结束；取数失败以非0退出，GitHub Actions会把本次运行标为失败并通知
        if (result.retryable) process.exitCode = 1;
        return;
    }
    const { sent, failed, total } = await deliverScanResult({
        chatId: config.telegram.adminChatId,
        result,
        now: nowChinaString(),
        dryRun
    });
    if (dryRun) return;
    console.log(`✅ 已发送${sent}/${total}条消息，失败${failed}条`);
    if (failed) process.exitCode = 1;
}

main().catch(error => {
    console.log("❌ 扫描失败:", formatError(error));
    process.exitCode = 1;
});
