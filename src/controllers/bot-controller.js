const { config } = require("../config");
const { formatError } = require("../lib/http");
const { buildTarget, normalizeSymbol } = require("../models/stock");
const view = require("../views/bot-view");

const { LEGACY_BUTTONS, MESSAGES } = view;

// 解析 /command 参数；不是该命令时返回null，无参数时返回空字符串
function commandArgument(text, command) {
    const match = String(text || "").trim().match(new RegExp(`^/${command}(?:@\\w+)?(?:\\s+(.+))?$`, "i"));
    return match ? (match[1] || "") : null;
}

function isCommand(text, ...commands) {
    return new RegExp(`^/(?:${commands.join("|")})(?:@\\w+)?$`, "i").test(text);
}

// Telegram机器人控制器：处理私聊消息与内联按钮回调，管理订阅与自选股
function createBotController({
    store,
    marketService,
    sendMessage,
    answerCallback,
    inviteCode = config.registration.inviteCode,
    openRegistration = config.registration.openRegistration,
    adminChatId = config.telegram.adminChatId,
    privateOnly = true,
    maxSubscribers = config.registration.maxSubscribers,
    maxStocks = config.registration.maxStocksPerUser
}) {
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
        const choice = argument.trim().toLowerCase();
        let enabled;
        if (!choice) enabled = subscriber.longhu_enabled === false;
        else if (["on", "开", "开启"].includes(choice)) enabled = true;
        else if (["off", "关", "关闭"].includes(choice)) enabled = false;
        else return reply(chatId, MESSAGES.invalidLonghuArgument);
        await store.setLonghuEnabled(chatId, enabled);
        return reply(chatId, view.longhuToggledText(enabled));
    }

    async function handleMessage(message) {
        const chatId = message.chat && message.chat.id;
        if (!chatId) return;
        const text = String(message.text || "").trim();
        // 群聊静默忽略，避免繁忙群组耗尽共享的Telegram限流额度
        if (!isPrivateChat(message.chat)) return;

        const startArgument = commandArgument(text, "start");
        if (startArgument !== null) return register(message, startArgument.trim());
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
        await answerCallback(query.id);
        const data = String(query.data || "");
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
