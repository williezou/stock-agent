const test = require("node:test");
const assert = require("node:assert/strict");
const { createBotController } = require("../../src/controllers/bot-controller");
const { LEGACY_BUTTONS, removeKeyboardMarkup } = require("../../src/views/bot-view");

function createMemoryStore(initial = [], registered = true) {
    const items = new Map([["100", new Map(initial.map(item => [item.symbol, item]))]]);
    const sessions = new Map();
    const subscribers = new Map(registered ? [["100", { chat_id: "100", status: "active" }]] : []);
    const bucket = chatId => {
        const key = String(chatId);
        if (!items.has(key)) items.set(key, new Map());
        return items.get(key);
    };
    return {
        async list(chatId) { return [...bucket(chatId).values()]; },
        async get(chatId, symbol) { return bucket(chatId).get(symbol) || null; },
        async upsert(chatId, target) { bucket(chatId).set(target.symbol, target); return target; },
        async remove(chatId, symbol) { return bucket(chatId).delete(symbol); },
        async setSession(chatId, action) { sessions.set(String(chatId), action); },
        async getSession(chatId) { return sessions.get(String(chatId)) || null; },
        async clearSession(chatId) { sessions.delete(String(chatId)); },
        async getSubscriber(chatId) { return subscribers.get(String(chatId)) || null; },
        async registerSubscriber({ chatId, userId, username, firstName, maxActive = 0 }) {
            const current = subscribers.get(String(chatId));
            const active = [...subscribers.values()].filter(item => item.status === "active").length;
            if (maxActive > 0 && current?.status !== "active" && active >= maxActive) return null;
            const value = {
                chat_id: String(chatId),
                telegram_user_id: userId ? String(userId) : null,
                username,
                first_name: firstName,
                status: "active"
            };
            subscribers.set(String(chatId), value);
            return value;
        },
        async deactivateSubscriber(chatId) {
            const subscriber = subscribers.get(String(chatId));
            if (!subscriber) return false;
            subscriber.status = "inactive";
            sessions.delete(String(chatId));
            return true;
        }
    };
}

function setup(initial = [], options = {}) {
    const sent = [];
    const answered = [];
    const store = createMemoryStore(initial, options.registered !== false);
    const controller = createBotController({
        store,
        marketService: {
            async getStockProfile(symbol) { return { symbol, name: symbol === "600519" ? "贵州茅台" : "测试股票" }; }
        },
        async sendMessage(chatId, text, sendOptions) { sent.push({ chatId, text, options: sendOptions }); },
        async answerCallback(id, answerOptions) { answered.push({ id, options: answerOptions }); },
        inviteCode: options.inviteCode || "",
        openRegistration: options.openRegistration ?? true,
        adminChatId: options.adminChatId || "1",
        maxSubscribers: options.maxSubscribers ?? 50,
        maxStocks: 10
    });
    return { answered, controller, sent, store };
}

function privateMessage(text, chatId = 100, userId = 200) {
    return { message: { chat: { id: chatId, type: "private" }, from: { id: userId, first_name: "测试" }, text } };
}

test("菜单回复会移除旧的常驻按钮键盘", async () => {
    assert.deepEqual(removeKeyboardMarkup(), { remove_keyboard: true });
    const { controller, sent } = setup();
    await controller.handleUpdate(privateMessage("/menu"));
    assert.deepEqual(sent.at(-1).options.replyMarkup, { remove_keyboard: true });
    assert.match(sent.at(-1).text, /Menu/);
});

test("旧版按钮文字仍可使用", async () => {
    const { controller, sent } = setup();
    await controller.handleUpdate(privateMessage(LEGACY_BUTTONS.LIST));
    assert.match(sent.at(-1).text, /当前没有每日追踪股票/);
});

test("新用户通过/start建立独立订阅", async () => {
    const { controller, sent, store } = setup([], { registered: false });
    await controller.handleUpdate(privateMessage("/start"));
    assert.equal((await store.getSubscriber(100)).status, "active");
    assert.match(sent.at(-1).text, /订阅已启用/);
});

test("配置邀请码后拒绝无效邀请码", async () => {
    const { controller, sent, store } = setup([], { registered: false, inviteCode: "friends" });
    await controller.handleUpdate(privateMessage("/start wrong"));
    assert.equal(await store.getSubscriber(100), null);
    assert.match(sent.at(-1).text, /有效邀请码/);
    await controller.handleUpdate(privateMessage("/start friends"));
    assert.equal((await store.getSubscriber(100)).status, "active");
});

test("/add会校验行情并写入当前用户自选股", async () => {
    const { controller, sent, store } = setup();
    await controller.handleUpdate(privateMessage("/add 600519"));
    const targets = await store.list(100);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].symbol, "600519");
    assert.equal((await store.list(999)).length, 0);
    assert.match(sent.at(-1).text, /贵州茅台/);
});

test("删除按钮需要二次确认后才删除", async () => {
    const initial = [{ symbol: "600887", name: "伊利股份", exchangeCode: "600887.SH", quoteUrl: "https://example.com", keywords: [] }];
    const { answered, controller, sent, store } = setup(initial);
    await controller.handleUpdate({
        callback_query: {
            id: "cb1",
            from: { id: 200 },
            message: { chat: { id: 100, type: "private" } },
            data: "delete:600887"
        }
    });
    assert.equal((await store.list(100)).length, 1);
    assert.match(sent.at(-1).text, /确认删除/);
    await controller.handleUpdate({
        callback_query: {
            id: "cb2",
            from: { id: 200 },
            message: { chat: { id: 100, type: "private" } },
            data: "delete_confirm:600887"
        }
    });
    assert.equal((await store.list(100)).length, 0);
    assert.equal(answered.length, 2);
});

test("/stop暂停订阅但保留自选股", async () => {
    const initial = [{ symbol: "600887", name: "伊利股份" }];
    const { controller, store } = setup(initial);
    await controller.handleUpdate(privateMessage("/stop"));
    assert.equal((await store.getSubscriber(100)).status, "inactive");
    assert.equal((await store.list(100)).length, 1);
});

test("群聊消息被静默忽略", async () => {
    const { controller, sent, store } = setup();
    await controller.handleUpdate({ message: { chat: { id: -100, type: "group" }, from: { id: 200 }, text: "/start" } });
    assert.equal(await store.getSubscriber(-100), null);
    assert.equal(sent.length, 0);
});

test("未配置邀请码且未开放注册时仅管理员可注册", async () => {
    const { controller, sent, store } = setup([], { registered: false, openRegistration: false, adminChatId: "300" });
    await controller.handleUpdate(privateMessage("/start"));
    assert.equal(await store.getSubscriber(100), null);
    assert.match(sent.at(-1).text, /暂未开放注册/);
    await controller.handleUpdate(privateMessage("/start", 300));
    assert.equal((await store.getSubscriber(300)).status, "active");
});

test("未注册用户的普通文本不回复", async () => {
    const { controller, sent } = setup([], { registered: false });
    await controller.handleUpdate(privateMessage("hello"));
    assert.equal(sent.length, 0);
});

test("名额已满时已停用用户也不能重新启用", async () => {
    const { controller, sent, store } = setup([], { maxSubscribers: 1 });
    await controller.handleUpdate(privateMessage("/stop"));
    await controller.handleUpdate(privateMessage("/start", 400));
    assert.equal((await store.getSubscriber(400)).status, "active");
    await controller.handleUpdate(privateMessage("/start"));
    assert.equal((await store.getSubscriber(100)).status, "inactive");
    assert.match(sent.at(-1).text, /名额已满/);
});

test("已停用用户点击菜单按钮仍会收到恢复提示", async () => {
    const { controller, sent } = setup();
    await controller.handleUpdate(privateMessage("/stop"));
    await controller.handleUpdate(privateMessage(LEGACY_BUTTONS.LIST));
    assert.match(sent.at(-1).text, /\/start/);
});

test("未显式传入时，注册策略在创建控制器时读取当前环境变量", async () => {
    const previous = process.env.BOT_INVITE_CODE;
    process.env.BOT_INVITE_CODE = "late-code";
    try {
        const sent = [];
        const controller = createBotController({
            store: createMemoryStore([], false),
            marketService: {},
            async sendMessage(chatId, text) { sent.push(text); },
            async answerCallback() {},
            adminChatId: "1"
        });
        await controller.handleUpdate(privateMessage("/start"));
        assert.match(sent.at(-1), /有效邀请码/);
    } finally {
        if (previous === undefined) delete process.env.BOT_INVITE_CODE;
        else process.env.BOT_INVITE_CODE = previous;
    }
});
