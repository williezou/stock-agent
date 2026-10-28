const { formatError } = require("../lib/http");

// 管理员告警：按“日期:类型”去重，每天每类最多提醒一次（各调度任务共用）。
// alerted 为去重记录：调度器传入存库的记录（store.adminAlerts，重启后不重复提醒），默认用进程内的 Set
const sentAlerts = new Set();

// 存库的去重记录读写失败时退回进程内记录，宁可多提醒一次也不漏
async function safely(action, fallback) {
    try {
        return await action();
    } catch (error) {
        console.error(`⚠️ 管理员告警去重记录读写失败：${formatError(error)}`);
        return fallback();
    }
}

// 发送成功后才记为已提醒，失败的告警会在下一轮重试；进程内的 Set 同时清理往日记录，避免无限增长（存库的记录按保留期清理）
async function alertAdmin({ notify, adminChatId, alerted = sentAlerts, dateStr }, { key, text }) {
    if (!adminChatId) return;
    if (await safely(() => alerted.has(key), () => sentAlerts.has(key))) return;
    if (alerted instanceof Set) {
        for (const existing of alerted) {
            if (!existing.startsWith(`${dateStr}:`)) alerted.delete(existing);
        }
    }
    try {
        await notify(adminChatId, text);
    } catch (error) {
        console.error(`⚠️ 管理员告警发送失败：${error.message}`);
        return;
    }
    await safely(() => alerted.add(key), () => sentAlerts.add(key));
}

module.exports = { alertAdmin, sentAlerts };
