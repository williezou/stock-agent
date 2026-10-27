const { escapeHtml } = require("./daily-format");
const { buildTarget, normalizeSymbol } = require("./stocks");

const BUTTONS = {
    ADD: "➕ 添加股票",
    REMOVE: "➖ 删除股票",
    LIST: "📋 追踪列表"
};

function menuReplyMarkup() {
    return {
        keyboard: [
            [{ text: BUTTONS.ADD }, { text: BUTTONS.REMOVE }],
            [{ text: BUTTONS.LIST }]
        ],
        resize_keyboard: true,
        is_persistent: true,
        input_field_placeholder: "选择操作或输入 /add 600519"
    };
}

function commandArgument(text, command) {
    const match = String(text || "").trim().match(new RegExp(`^/${command}(?:@\\w+)?(?:\\s+(.+))?$`, "i"));
    return match ? (match[1] || "") : null;
}

function createBotController({
    store,
    marketService,
    sendMessage,
    answerCallback,
    inviteCode = process.env.BOT_INVITE_CODE || "",
    privateOnly = true,
    maxSubscribers = Number(process.env.MAX_SUBSCRIBERS || 50),
    maxStocks = 10
}) {
    function isPrivateChat(chat) {
        return !privateOnly || !chat?.type || chat.type === "private";
    }

    async function isActiveSubscriber(chatId) {
        const subscriber = await store.getSubscriber(chatId);
        return Boolean(subscriber && subscriber.status === "active");
    }

    async function register(message, suppliedCode) {
        const chatId = message.chat.id;
        const existing = await store.getSubscriber(chatId);
        if (inviteCode && !existing && suppliedCode !== inviteCode) {
            return sendMessage(chatId, "需要有效邀请码才能启用每日股票追踪。\n请输入：<code>/start 邀请码</code>");
        }
        if (!existing && maxSubscribers > 0) {
            const activeSubscribers = await store.listActiveSubscribers();
            if (activeSubscribers.length >= maxSubscribers) {
                return sendMessage(chatId, "当前订阅名额已满，请联系机器人管理员。");
            }
        }
        await store.registerSubscriber({
            chatId,
            userId: message.from?.id,
            username: message.from?.username,
            firstName: message.from?.first_name
        });
        return sendMenu(chatId, "✅ 订阅已启用。你的自选股与其他用户完全独立。\n请先添加需要每日追踪的股票。");
    }

    async function sendMenu(chatId, text = "请选择要执行的操作：") {
        return sendMessage(chatId, text, { replyMarkup: menuReplyMarkup() });
    }

    async function showList(chatId) {
        const targets = await store.list(chatId);
        if (!targets.length) return sendMenu(chatId, "当前没有每日追踪股票。");
        const lines = targets.map((target, index) =>
            `${index + 1}. <code>${target.symbol}</code> ${escapeHtml(target.name)}`
        );
        return sendMenu(chatId, `<b>每日追踪列表（${targets.length}/${maxStocks}）</b>\n${lines.join("\n")}`);
    }

    async function promptAdd(chatId) {
        await store.setSession(chatId, "add");
        return sendMessage(chatId, "请输入六位沪深A股代码，例如：<code>600519</code>\n发送 /cancel 可取消。", {
            replyMarkup: { force_reply: true, input_field_placeholder: "输入股票代码" }
        });
    }

    async function addStock(chatId, input) {
        const symbol = normalizeSymbol(input);
        if (!symbol) {
            return sendMessage(chatId, "代码格式不正确，仅支持0、3、6开头的六位沪深A股代码。请重新输入，或发送 /cancel。");
        }
        const existing = await store.get(chatId, symbol);
        if (existing) {
            await store.clearSession(chatId);
            return sendMenu(chatId, `<code>${symbol}</code> ${escapeHtml(existing.name)} 已在追踪列表中。`);
        }
        const current = await store.list(chatId);
        if (current.length >= maxStocks) {
            await store.clearSession(chatId);
            return sendMenu(chatId, `最多追踪${maxStocks}只股票，请先删除不需要的代码。`);
        }
        const profile = await marketService.getStockProfile(symbol);
        if (profile.symbol !== symbol) throw new Error(`行情接口返回的代码与${symbol}不一致`);
        const target = buildTarget(symbol, profile.name);
        await store.upsert(chatId, target);
        await store.clearSession(chatId);
        return sendMenu(chatId, `✅ 已添加 <code>${symbol}</code> ${escapeHtml(profile.name)}，下个交易日将纳入收盘分析。`);
    }

    async function showDeleteButtons(chatId) {
        const targets = await store.list(chatId);
        if (!targets.length) return sendMenu(chatId, "当前没有可删除的股票。");
        const inlineKeyboard = targets.map(target => [{
            text: `删除 ${target.symbol} ${target.name}`,
            callback_data: `delete:${target.symbol}`
        }]);
        inlineKeyboard.push([{ text: "取消", callback_data: "delete_cancel" }]);
        return sendMessage(chatId, "请选择要删除的股票：", {
            replyMarkup: { inline_keyboard: inlineKeyboard }
        });
    }

    async function removeStock(chatId, input) {
        const symbol = normalizeSymbol(input);
        if (!symbol) return sendMenu(chatId, "代码格式不正确，删除命令示例：<code>/remove 600519</code>");
        const removed = await store.remove(chatId, symbol);
        return sendMenu(chatId, removed ? `✅ 已停止追踪 <code>${symbol}</code>。` : `未找到 <code>${symbol}</code>。`);
    }

    async function handleMessage(message) {
        const chatId = message.chat && message.chat.id;
        if (!chatId) return;
        const text = String(message.text || "").trim();
        if (!isPrivateChat(message.chat)) {
            return sendMessage(chatId, "为保护每个人的自选股隐私，本机器人目前仅支持私聊使用。");
        }

        const startArgument = commandArgument(text, "start");
        if (startArgument !== null) return register(message, startArgument.trim());
        if (!await isActiveSubscriber(chatId)) {
            return sendMessage(chatId, inviteCode
                ? "请使用 <code>/start 邀请码</code> 完成注册。"
                : "请先发送 /start 启用每日股票追踪。");
        }

        if (/^\/menu(?:@\w+)?$/i.test(text)) return sendMenu(chatId, "每日股票追踪机器人已就绪。");
        if (/^\/stop(?:@\w+)?$/i.test(text)) {
            await store.deactivateSubscriber(chatId);
            return sendMessage(chatId, "已暂停每日推送。你的自选股仍会保留，发送 /start 可随时恢复。", {
                replyMarkup: { remove_keyboard: true }
            });
        }
        if (/^\/cancel(?:@\w+)?$/i.test(text)) {
            await store.clearSession(chatId);
            return sendMenu(chatId, "已取消当前操作。");
        }
        if (text === BUTTONS.LIST || /^\/list(?:@\w+)?$/i.test(text)) return showList(chatId);
        if (text === BUTTONS.ADD) return promptAdd(chatId);
        if (text === BUTTONS.REMOVE) return showDeleteButtons(chatId);

        const addArgument = commandArgument(text, "add");
        if (addArgument !== null) return addArgument ? addStock(chatId, addArgument) : promptAdd(chatId);
        const removeArgument = commandArgument(text, "remove");
        if (removeArgument !== null) return removeArgument ? removeStock(chatId, removeArgument) : showDeleteButtons(chatId);

        if (await store.getSession(chatId) === "add") return addStock(chatId, text);
        return sendMenu(chatId, "未识别该指令，可使用下方菜单或 /add、/remove、/list。");
    }

    async function handleCallback(query) {
        const chatId = query.message && query.message.chat && query.message.chat.id;
        if (!chatId || !isPrivateChat(query.message?.chat) || !await isActiveSubscriber(chatId)) {
            return answerCallback(query.id, { text: "无权操作此机器人", showAlert: true });
        }
        await answerCallback(query.id);
        const data = String(query.data || "");
        if (data === "delete_cancel") return sendMenu(chatId, "已取消删除。");
        if (data.startsWith("delete:")) {
            const symbol = normalizeSymbol(data.slice("delete:".length));
            const target = symbol && await store.get(chatId, symbol);
            if (!target) return sendMenu(chatId, "该股票已不在追踪列表中。");
            return sendMessage(chatId, `确认删除 <code>${symbol}</code> ${escapeHtml(target.name)}？`, {
                replyMarkup: {
                    inline_keyboard: [[
                        { text: "确认删除", callback_data: `delete_confirm:${symbol}` },
                        { text: "取消", callback_data: "delete_cancel" }
                    ]]
                }
            });
        }
        if (data.startsWith("delete_confirm:")) {
            const symbol = normalizeSymbol(data.slice("delete_confirm:".length));
            if (!symbol) return sendMenu(chatId, "股票代码无效。");
            return removeStock(chatId, symbol);
        }
    }

    async function handleUpdate(update) {
        if (update.callback_query) return handleCallback(update.callback_query);
        if (update.message) return handleMessage(update.message);
    }

    return { handleUpdate, sendMenu, showList };
}

module.exports = { BUTTONS, createBotController, menuReplyMarkup };
