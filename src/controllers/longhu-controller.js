const { config } = require("../config");
const telegram = require("../gateways/telegram");
const { delay } = require("../lib/async");
const { createHttpClient, formatError, requestWithRetry } = require("../lib/http");
const { createLonghuService } = require("../models/market/longhu");
const { getChinaClock, isTradingDay, isWeekdayWindow, minutesOfDay } = require("../models/market/trading-calendar");
const { alertAdmin } = require("../services/admin-alert");
const { resolveDailyPage } = require("../services/daily-page");
const { sendAndRecord } = require("../services/tracked-delivery");
const { generateLonghuChart } = require("../views/charts/longhu-chart");
const { formatLonghuCaption, formatLonghuKeyboard, formatLonghuMessage } = require("../views/longhu-view");

// 龙虎榜推送控制器：交易所在收盘后傍晚（约16:00-20:00）分批发布龙虎榜，且接口没有“发布完成”标记。
// 工作日17:30-20:30按固定的10分钟时段检查（17:30、17:40……，不会因执行耗时漂移而错过最后时段）：
// 18:00起，当日榜单同时包含沪、深两市且连续三次检查数量不变，视为发布完成后推送；
// 20:20的最后时段有数据即推送，仍无数据时提醒管理员
const JOB_NAME = "longhu";
const WINDOW_START = 17 * 60 + 30;
const EARLIEST_SEND = 18 * 60;
const FINAL_FROM = 20 * 60 + 20;
const WINDOW_END = 20 * 60 + 30;
const SLOT_MINUTES = 10;
const STABLE_CHECKS = 3;
const FINAL_RETRY_DELAY_MS = 2000;

function isLonghuWindow(now = new Date()) {
    return isWeekdayWindow(now, WINDOW_START, WINDOW_END);
}

function isLonghuFinalWindow(now = new Date()) {
    return minutesOfDay(now) >= FINAL_FROM;
}

function slotOf(now) {
    return Math.floor((minutesOfDay(now) - WINDOW_START) / SLOT_MINUTES);
}

// 沪、深两市都已出现上榜股票，才可能是完整榜单（北交所上榜少，不作要求）
function coversMainExchanges(board) {
    return board.some(item => item.symbol.startsWith("6")) && board.some(item => /^[03]/.test(item.symbol));
}

// 连续STABLE_CHECKS次检查的上榜数量相同，说明交易所已停止追加
function isStable(counts) {
    return counts.length >= STABLE_CHECKS && counts.slice(-STABLE_CHECKS).every(count => count === counts.at(-1));
}

function newCheckState(date = "") {
    return { date, lastSlot: null, trading: null, counts: [] };
}

// 进程内的检查状态：当天已检查的时段、交易日判断结果与历次上榜数量
const checkState = newCheckState();

let defaultServices;
function getDefaultServices() {
    if (!defaultServices) {
        const httpClient = createHttpClient();
        defaultServices = {
            longhu: createLonghuService({ httpClient, requestWithRetry }),
            isTradingDay: now => isTradingDay({ httpClient, requestWithRetry, now })
        };
    }
    return defaultServices;
}

async function claim(store, chatId, dateStr) {
    return store.claimDeliveryRun(JOB_NAME, chatId, dateStr, config.scheduler.maxAttempts);
}

async function skipSubscribers(store, subscribers, dateStr, reason) {
    for (const subscriber of subscribers) {
        const attempt = await claim(store, subscriber.chat_id, dateStr).catch(() => null);
        if (attempt !== null) {
            await store.completeDeliveryRun(JOB_NAME, subscriber.chat_id, dateStr, "skipped", reason).catch(() => {});
        }
    }
}

// 最后时段没有下一次重试机会：发送失败时立即再试一次（屏蔽机器人的错误不重试）
function withFinalRetry(send, final) {
    if (!final) return send;
    return async () => {
        try {
            await send();
        } catch (error) {
            if (telegram.isBotBlockedError(error)) throw error;
            await delay(FINAL_RETRY_DELAY_MS);
            await send();
        }
    };
}

// 推送内容只生成一次，所有订阅者共用：优先发图表（图片+概况说明），图表生成失败时退回文字版，保证当天不漏推。
// 图片只上传一次：首次发送成功后记下Telegram返回的 file_id，之后的订阅者直接引用
// 机器人用户名只用于文字版后备里“📋 查看席位”的 t.me 深层链接；查询失败时链接退回电脑版详情页
async function resolveBotUsername() {
    try {
        return (await telegram.getMe()).username || null;
    } catch (error) {
        console.error(`⚠️ 获取机器人用户名失败，龙虎榜链接改用电脑版详情页：${formatError(error)}`);
        return null;
    }
}

async function buildContent({ dateStr, board, getBotUsername, render, sendMessage, sendPhoto }) {
    try {
        const png = render({ date: dateStr, board });
        const caption = formatLonghuCaption({ date: dateStr, board });
        const replyMarkup = formatLonghuKeyboard({ date: dateStr, board });
        let fileId = null;
        const send = async chatId => {
            const message = await sendPhoto(chatId, fileId || png, caption, `longhu-${dateStr}.png`, { replyMarkup });
            fileId = fileId || telegram.largestPhotoFileId(message);
        };
        return { kind: "chart", send };
    } catch (error) {
        console.error(`⚠️ 龙虎榜图表生成失败，改发文字：${formatError(error)}`);
        const text = formatLonghuMessage({ date: dateStr, board, botUsername: await getBotUsername() });
        return { kind: "text", send: chatId => sendMessage(chatId, text) };
    }
}

async function deliverToSubscribers(store, subscribers, { dateStr, send, final }) {
    const totals = { delivered: 0, failed: 0, deactivated: 0 };
    for (const subscriber of subscribers) {
        const chatId = subscriber.chat_id;
        try {
            if (await claim(store, chatId, dateStr) === null) continue;
            const outcome = await sendAndRecord(store, {
                jobName: JOB_NAME,
                chatId,
                runDate: dateStr,
                send: withFinalRetry(() => send(chatId), final),
                finalAttempt: final
            });
            totals[outcome]++;
        } catch (error) {
            // 单个用户的状态写入失败不影响其他用户
            console.error(`❌ 处理${chatId}的龙虎榜投递失败：${formatError(error)}`);
            totals.failed++;
        }
    }
    return totals;
}

async function runLonghuTick(store, now = new Date(), services = {}) {
    if (!isLonghuWindow(now)) return { action: "outside-window" };
    const { longhu, isTradingDay: checkTradingDay } = { ...getDefaultServices(), ...services };
    const notify = services.sendMessage || telegram.sendMessage;
    const state = services.state || checkState;
    const { dateStr } = getChinaClock(now);
    const alertContext = {
        notify,
        adminChatId: services.adminChatId ?? config.telegram.adminChatId,
        alerted: services.alerted || store.adminAlerts,
        dateStr
    };

    if (state.date !== dateStr) Object.assign(state, newCheckState(dateStr));
    const slot = slotOf(now);
    if (slot === state.lastSlot) return { action: "waiting" };
    state.lastSlot = slot;

    const subscribers = await store.listDueSubscribers(JOB_NAME, dateStr, config.scheduler.maxAttempts, { audience: "longhu" });
    if (!subscribers.length) return { action: "not-due" };

    // 每天只判断一次交易日；休市日直接跳过，不再请求行情接口
    if (!state.trading) {
        state.trading = await checkTradingDay(now).catch(() => ({ ok: true, verified: false }));
    }
    if (!state.trading.ok) {
        await skipSubscribers(store, subscribers, dateStr, `非交易日（${state.trading.reason}）`);
        return { action: "skipped", reason: "非交易日" };
    }

    const final = isLonghuFinalWindow(now);
    let board;
    try {
        board = await longhu.getBoardByDate(dateStr);
    } catch (error) {
        console.error(`⚠️ 龙虎榜获取失败：${formatError(error)}`);
        if (!final) return { action: "fetch-failed" };
        await alertAdmin(alertContext, { key: `${dateStr}:longhu-fetch`, text: `❌ 今日龙虎榜获取失败：${formatError(error)}，今日不再推送。` });
        await skipSubscribers(store, subscribers, dateStr, "龙虎榜获取失败");
        return { action: "fetch-failed", final: true };
    }

    state.counts.push(board.length);
    const ready = coversMainExchanges(board) && isStable(state.counts) && minutesOfDay(now) >= EARLIEST_SEND;
    if (!ready && !final) return { action: "waiting", count: board.length };

    if (!board.length) {
        const unverified = state.trading.verified === false ? "（节假日接口不可用，若今日休市请忽略）" : "";
        await alertAdmin(alertContext, {
            key: `${dateStr}:longhu-missing`,
            text: `⚠️ 截至20:20仍未获取到今日龙虎榜，今日不再推送。${unverified}`
        });
        await skipSubscribers(store, subscribers, dateStr, "龙虎榜未发布");
        return { action: "skipped", reason: "龙虎榜未发布" };
    }

    const getBotUsername = services.botUsername !== undefined ? async () => services.botUsername : resolveBotUsername;
    const render = services.renderChart || generateLonghuChart;
    const content = await buildContent({
        dateStr,
        board,
        getBotUsername,
        render,
        sendMessage: notify,
        sendPhoto: services.sendPhoto || telegram.sendPhoto
    });
    // 每日总结网页：榜单写入网页（所有用户共用），这里只把龙虎榜加进各用户的入口页，不单独推送；
    // 随后的游资动向推送会带上网页按钮。网页写入失败时按原方式推送图片
    const page = resolveDailyPage(services);
    if (page) {
        try {
            await page.publishLonghu({ date: dateStr, board, botUsername: await getBotUsername(), render });
            content.kind = "page";
            content.send = async chatId => { await page.publishIndex(await store.getSubscriber(chatId), dateStr); };
        } catch (error) {
            console.error(`⚠️ 龙虎榜网页写入失败，改为推送图片：${formatError(error)}`);
        }
    }
    const totals = await deliverToSubscribers(store, subscribers, { dateStr, send: content.send, final });
    if (final && totals.failed) {
        await alertAdmin(alertContext, { key: `${dateStr}:longhu-send`, text: `⚠️ 今日龙虎榜有${totals.failed}位用户推送失败，已无重试机会。` });
    }
    return { action: "processed", count: board.length, format: content.kind, recipients: subscribers.length, ...totals };
}

module.exports = { coversMainExchanges, isLonghuFinalWindow, isLonghuWindow, isStable, runLonghuTick };
