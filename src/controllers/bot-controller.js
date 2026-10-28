const { config } = require("../config");
const { formatError } = require("../lib/http");
const { buildTarget, normalizeSymbol } = require("../models/stock");
const view = require("../views/bot-view");
const { generateSeatChart } = require("../views/charts/seat-chart");
const {
    formatSeatCaption,
    formatSeatDetail,
    formatSeatKeyboard,
    formatSeatNotFound,
    parseLonghuCallbackData,
    parseLonghuStartPayload
} = require("../views/longhu-view");

const { LEGACY_BUTTONS, MESSAGES } = view;

// 同一只股票的席位在此时间内不重复发送（防止连续点击刷屏）
const SEAT_COOLDOWN_MS = 60 * 1000;

// 解析 /command 参数；不是该命令时返回null，无参数时返回空字符串
function commandArgument(text, command) {
    const match = String(text || "").trim().match(new RegExp(`^/${command}(?:@\\w+)?(?:\\s+(.+))?$`, "i"));
    return match ? (match[1] || "") : null;
}

function isCommand(text, ...commands) {
    return new RegExp(`^/(?:${commands.join("|")})(?:@\\w+)?$`, "i").test(text);
}

// 推送开关参数：空参数时在当前状态上切换（数据库字段默认开启），on/off 显式设置，无法识别时返回null
function parseToggle(argument, current) {
    const choice = argument.trim().toLowerCase();
    if (!choice) return current === false;
    if (["on", "开", "开启"].includes(choice)) return true;
    if (["off", "关", "关闭"].includes(choice)) return false;
    return null;
}

// Telegram机器人控制器：处理私聊消息与内联按钮回调，管理订阅与自选股
function createBotController({
    store,
    marketService,
    longhuService,
    sendMessage,
    sendPhoto,
    renderSeatChart = generateSeatChart,
    answerCallback,
    inviteCode = config.registration.inviteCode,
    openRegistration = config.registration.openRegistration,
    adminChatId = config.telegram.adminChatId,
    privateOnly = true,
    maxSubscribers = config.registration.maxSubscribers,
    maxStocks = config.registration.maxStocksPerUser,
    seatCooldownMs = SEAT_COOLDOWN_MS,
    now = () => Date.now()
}) {
    // 席位查询防重复点击：key=会话+股票+日期 → 状态（生成中/已发送时间）
    const seatRequests = new Map();

    // 返回 null 表示可以处理；否则返回提示文案（正在生成 / 冷却期内已发送）
    function seatRequestBlocked(key) {
        const current = now();
        for (const [entryKey, entry] of seatRequests) {
            if (!entry.pending && current - entry.at >= seatCooldownMs) seatRequests.delete(entryKey);
        }
        const entry = seatRequests.get(key);
        if (!entry) return null;
        return entry.pending ? MESSAGES.seatPending : MESSAGES.seatRecentlySent;
    }
    function isPrivateChat(chat) {
        return !privateOnly || !chat?.type || chat.type === "private";
    }

    function isAdmin(chatId) {
        return Boolean(adminChatId) && String(chatId) === String(adminChatId);
    }

    async function isActiveSubscriber(chatId) {
        const subscriber = await store.getSubscriber(chatId);
        return Boolean(subscriber && subscriber.status === "active");
    }

    function reply(chatId, text) {
        return sendMessage(chatId, text, { replyMarkup: view.removeKeyboardMarkup() });
    }

    // /start [邀请码]：管理员与已注册过的用户直接启用，新用户需邀请码或开放注册，且受名额限制
    async function register(message, suppliedCode) {
        const chatId = message.chat.id;
        const admin = isAdmin(chatId);
        const existing = await store.getSubscriber(chatId);
        if (!admin && !existing) {
            if (inviteCode && suppliedCode !== inviteCode) return sendMessage(chatId, MESSAGES.inviteRequired);
            if (!inviteCode && !openRegistration) return sendMessage(chatId, MESSAGES.registrationClosed);
        }
        const subscriber = await store.registerSubscriber({
            chatId,
            userId: message.from?.id,
            username: message.from?.username,
            firstName: message.from?.first_name,
            maxActive: admin ? 0 : maxSubscribers
        });
        if (!subscriber) return sendMessage(chatId, MESSAGES.subscribersFull);
        return reply(chatId, MESSAGES.registered);
    }

    async function showUsers(chatId) {
        for (const text of view.usersMessages(await store.listSubscriberSummaries(), maxSubscribers)) {
            await reply(chatId, text);
        }
    }

    async function showList(chatId) {
        const targets = await store.list(chatId);
        if (!targets.length) return reply(chatId, MESSAGES.emptyList);
        return reply(chatId, view.watchlistText(targets, maxStocks));
    }

    async function promptAdd(chatId) {
        await store.setSession(chatId, "add");
        return sendMessage(chatId, MESSAGES.addPrompt, { replyMarkup: view.addPromptMarkup() });
    }

    async function addStock(chatId, input) {
        const symbol = normalizeSymbol(input);
        if (!symbol) return sendMessage(chatId, MESSAGES.invalidAddCode);
        const existing = await store.get(chatId, symbol);
        if (existing) {
            await store.clearSession(chatId);
            return reply(chatId, view.alreadyTrackedText(symbol, existing.name));
        }
        const current = await store.list(chatId);
        if (current.length >= maxStocks) {
            await store.clearSession(chatId);
            return reply(chatId, view.watchlistFullText(maxStocks));
        }
        const profile = await marketService.getStockProfile(symbol);
        if (profile.symbol !== symbol) throw new Error(`行情接口返回的代码与${symbol}不一致`);
        await store.upsert(chatId, buildTarget(symbol, profile.name));
        await store.clearSession(chatId);
        return reply(chatId, view.addedText(symbol, profile.name));
    }

    async function showRemoveChoices(chatId) {
        const targets = await store.list(chatId);
        if (!targets.length) return reply(chatId, MESSAGES.nothingToRemove);
        return sendMessage(chatId, MESSAGES.chooseToRemove, { replyMarkup: view.removeChoicesMarkup(targets) });
    }

    async function removeStock(chatId, input) {
        const symbol = normalizeSymbol(input);
        if (!symbol) return reply(chatId, MESSAGES.invalidRemoveCode);
        const removed = await store.remove(chatId, symbol);
        return reply(chatId, view.removedText(symbol, removed));
    }

    // /longhu 切换，/longhu on|off 显式设置
    async function setLonghuPush(chatId, argument, subscriber) {
        const enabled = parseToggle(argument, subscriber.longhu_enabled);
        if (enabled === null) return reply(chatId, MESSAGES.invalidLonghuArgument);
        await store.setLonghuEnabled(chatId, enabled);
        return reply(chatId, view.longhuToggledText(enabled));
    }

    // /flow 切换，/flow on|off 显式设置
    async function setFundFlowPush(chatId, argument, subscriber) {
        const enabled = parseToggle(argument, subscriber.fund_flow_enabled);
        if (enabled === null) return reply(chatId, MESSAGES.invalidFlowArgument);
        await store.setFundFlowEnabled(chatId, enabled);
        return reply(chatId, view.fundFlowToggledText(enabled));
    }

    // 龙虎榜推送里点击股票名称（t.me 深层链接）后，回复该股当日的买卖席位明细
    // 同一会话对同一只股票同一天的席位：生成中或冷却期内不重复发送。
    // onAccepted / onBlocked 在开始处理前调用（按钮点击需立即应答，避免生成期间按钮一直转圈引发重按）
    async function showLonghuSeatsOnce(chatId, query, { onAccepted = async () => {}, onBlocked = async () => {} } = {}) {
        const key = `${chatId}:${query.symbol}:${query.date}`;
        const blocked = seatRequestBlocked(key);
        if (blocked) return onBlocked(blocked);
        seatRequests.set(key, { pending: true, at: now() });
        try {
            await onAccepted();
            return await showLonghuSeats(chatId, query);
        } finally {
            seatRequests.set(key, { pending: false, at: now() });
        }
    }

    async function showLonghuSeats(chatId, { symbol, date }) {
        let detail = null;
        try {
            detail = longhuService ? await longhuService.getSeatDetails(date, symbol) : null;
        } catch (error) {
            console.error(`⚠️ 龙虎榜席位查询失败（${symbol} ${date}）：${formatError(error)}`);
        }
        if (!detail) return reply(chatId, formatSeatNotFound({ date, symbol }));
        // 席位以表格图片展示；画图失败或未注入发图函数时退回文字版
        if (sendPhoto) {
            try {
                const png = renderSeatChart({ date, detail });
                return await sendPhoto(chatId, png, formatSeatCaption({ date, detail }), `lhb-${symbol}-${date}.png`, {
                    replyMarkup: formatSeatKeyboard({ date, symbol })
                });
            } catch (error) {
                console.error(`⚠️ 龙虎榜席位表格发送失败，改发文字（${symbol} ${date}）：${formatError(error)}`);
            }
        }
        return reply(chatId, formatSeatDetail({ date, detail }));
    }

    async function handleMessage(message) {
        const chatId = message.chat && message.chat.id;
        if (!chatId) return;
        const text = String(message.text || "").trim();
        // 群聊静默忽略，避免繁忙群组耗尽共享的Telegram限流额度
        if (!isPrivateChat(message.chat)) return;

        const startArgument = commandArgument(text, "start");
        const seatQuery = startArgument && parseLonghuStartPayload(startArgument);
        if (seatQuery) {
            // 深层链接只给已订阅的用户查看；其他人按未注册处理，不把链接参数当成邀请码
            if (isAdmin(chatId) || await isActiveSubscriber(chatId)) {
                return showLonghuSeatsOnce(chatId, seatQuery);
            }
            return sendMessage(chatId, inviteCode ? MESSAGES.registerWithInvite : MESSAGES.registerFirst);
        }
        if (startArgument !== null) return register(message, startArgument.trim());
        // 管理员命令不受本人订阅状态影响（管理员 /stop 后也能查看）
        if (isAdmin(chatId) && isCommand(text, "users")) return showUsers(chatId);
        const subscriber = await store.getSubscriber(chatId);
        if (subscriber?.status !== "active") {
            // 陌生人的闲聊不回复；已停用（或屏蔽后又解除）的用户仍给出恢复提示
            if (!subscriber && !text.startsWith("/")) return;
            return sendMessage(chatId, inviteCode ? MESSAGES.registerWithInvite : MESSAGES.registerFirst);
        }

        if (isCommand(text, "menu", "help")) return reply(chatId, MESSAGES.help);
        if (isCommand(text, "stop")) {
            await store.deactivateSubscriber(chatId);
            return reply(chatId, MESSAGES.stopped);
        }
        if (isCommand(text, "cancel")) {
            await store.clearSession(chatId);
            return reply(chatId, MESSAGES.cancelled);
        }
        if (text === LEGACY_BUTTONS.LIST || isCommand(text, "list")) return showList(chatId);
        if (text === LEGACY_BUTTONS.ADD) return promptAdd(chatId);
        if (text === LEGACY_BUTTONS.REMOVE) return showRemoveChoices(chatId);

        const longhuArgument = commandArgument(text, "longhu");
        if (longhuArgument !== null) return setLonghuPush(chatId, longhuArgument, subscriber);
        const flowArgument = commandArgument(text, "flow");
        if (flowArgument !== null) return setFundFlowPush(chatId, flowArgument, subscriber);

        const addArgument = commandArgument(text, "add");
        if (addArgument !== null) return addArgument ? addStock(chatId, addArgument) : promptAdd(chatId);
        const removeArgument = commandArgument(text, "remove");
        if (removeArgument !== null) return removeArgument ? removeStock(chatId, removeArgument) : showRemoveChoices(chatId);

        // 多步对话：上一步是“添加股票”时，把这条消息当作股票代码
        if (await store.getSession(chatId) === "add") return addStock(chatId, text);
        return reply(chatId, MESSAGES.unknownCommand);
    }

    // 删除流程：delete:代码 → 二次确认 → delete_confirm:代码
    async function handleCallback(query) {
        const chatId = query.message && query.message.chat && query.message.chat.id;
        if (!chatId || !isPrivateChat(query.message?.chat) || !await isActiveSubscriber(chatId)) {
            return answerCallback(query.id, { text: MESSAGES.unauthorizedCallback, showAlert: true });
        }
        const data = String(query.data || "");
        // 龙虎榜推送图片下方的股票名称按钮：重复点击时只弹出提示
        const seatQuery = parseLonghuCallbackData(data);
        if (seatQuery) {
            return showLonghuSeatsOnce(chatId, seatQuery, {
                onAccepted: () => answerCallback(query.id),
                onBlocked: text => answerCallback(query.id, { text })
            });
        }
        await answerCallback(query.id);
        if (data === "delete_cancel") return reply(chatId, MESSAGES.removeCancelled);
        if (data.startsWith("delete:")) {
            const symbol = normalizeSymbol(data.slice("delete:".length));
            const target = symbol && await store.get(chatId, symbol);
            if (!target) return reply(chatId, MESSAGES.alreadyRemoved);
            return sendMessage(chatId, view.confirmRemoveText(symbol, target.name), {
                replyMarkup: view.confirmRemoveMarkup(symbol)
            });
        }
        if (data.startsWith("delete_confirm:")) {
            const symbol = normalizeSymbol(data.slice("delete_confirm:".length));
            if (!symbol) return reply(chatId, MESSAGES.invalidSymbol);
            return removeStock(chatId, symbol);
        }
    }

    async function handleUpdate(update) {
        if (update.callback_query) return handleCallback(update.callback_query);
        if (update.message) return handleMessage(update.message);
    }

    // 处理失败时记录日志，并仅向活跃订阅者提示失败（不向陌生人暴露错误）
    async function handleUpdateSafely(update) {
        try {
            await handleUpdate(update);
        } catch (error) {
            console.error(`❌ Telegram更新处理失败：${formatError(error)}`);
            const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
            const subscriber = chatId ? await store.getSubscriber(chatId).catch(() => null) : null;
            if (subscriber?.status === "active") {
                await sendMessage(chatId, MESSAGES.operationFailed).catch(() => {});
            }
        }
    }

    return { handleUpdate, handleUpdateSafely };
}

module.exports = { createBotController };
