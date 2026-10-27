const test = require("node:test");
const assert = require("node:assert/strict");
const { BUTTONS, createBotController, menuReplyMarkup } = require("../bot-service");

function createMemoryStore(initial = []) {
    const items = new Map(initial.map(item => [item.symbol, item]));
    const sessions = new Map();
    return {
        async list() { return [...items.values()]; },
        async get(_chatId, symbol) { return items.get(symbol) || null; },
        async upsert(_chatId, target) { items.set(target.symbol, target); return target; },
        async remove(_chatId, symbol) { return items.delete(symbol); },
        async setSession(chatId, action) { sessions.set(String(chatId), action); },
        async getSession(chatId) { return sessions.get(String(chatId)) || null; },
        async clearSession(chatId) { sessions.delete(String(chatId)); }
    };
}

function setup(initial = []) {
    const sent = [];
    const answered = [];
    const store = createMemoryStore(initial);
    const controller = createBotController({
        store,
        marketService: {
            async getStockProfile(symbol) { return { symbol, name: symbol === "600519" ? "贵州茅台" : "测试股票" }; }
        },
        async sendMessage(chatId, text, options) { sent.push({ chatId, text, options }); },
        async answerCallback(id, options) { answered.push({ id, options }); },
        allowedChatId: "100",
        allowedUserId: "200",
        maxStocks: 10
    });
    return { answered, controller, sent, store };
}

test("菜单提供添加、删除和追踪列表按钮", () => {
    const markup = menuReplyMarkup();
    const labels = markup.keyboard.flat().map(item => item.text);
    assert.deepEqual(labels, [BUTTONS.ADD, BUTTONS.REMOVE, BUTTONS.LIST]);
});

test("/add会校验行情并写入自选股", async () => {
    const { controller, sent, store } = setup();
    await controller.handleUpdate({ message: { chat: { id: 100 }, from: { id: 200 }, text: "/add 600519" } });
    const targets = await store.list();
    assert.equal(targets.length, 1);
    assert.equal(targets[0].symbol, "600519");
    assert.match(sent.at(-1).text, /贵州茅台/);
});

test("删除按钮需要二次确认后才删除", async () => {
    const initial = [{ symbol: "600887", name: "伊利股份", exchangeCode: "600887.SH", quoteUrl: "https://example.com", keywords: [] }];
    const { answered, controller, sent, store } = setup(initial);
    await controller.handleUpdate({
        callback_query: {
            id: "cb1",
            from: { id: 200 },
            message: { chat: { id: 100 } },
            data: "delete:600887"
        }
    });
    assert.equal((await store.list()).length, 1);
    assert.match(sent.at(-1).text, /确认删除/);
    await controller.handleUpdate({
        callback_query: {
            id: "cb2",
            from: { id: 200 },
            message: { chat: { id: 100 } },
            data: "delete_confirm:600887"
        }
    });
    assert.equal((await store.list()).length, 0);
    assert.equal(answered.length, 2);
});

test("非授权用户不能修改列表", async () => {
    const { controller, sent, store } = setup();
    await controller.handleUpdate({ message: { chat: { id: 100 }, from: { id: 999 }, text: "/add 600519" } });
    assert.equal((await store.list()).length, 0);
    assert.equal(sent.length, 0);
});
