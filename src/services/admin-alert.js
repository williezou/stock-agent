// 管理员告警：按“日期:类型”去重，每天每类最多提醒一次（进程内，各调度任务共用）
const sentAlerts = new Set();

// 发送成功后才记为已提醒，失败的告警会在下一轮重试；同时清理往日记录，避免集合无限增长
async function alertAdmin({ notify, adminChatId, alerted = sentAlerts, dateStr }, { key, text }) {
    if (!adminChatId || alerted.has(key)) return;
    for (const existing of alerted) {
        if (!existing.startsWith(`${dateStr}:`)) alerted.delete(existing);
    }
    try {
        await notify(adminChatId, text);
        alerted.add(key);
    } catch (error) {
        console.error(`⚠️ 管理员告警发送失败：${error.message}`);
    }
}

module.exports = { alertAdmin, sentAlerts };
