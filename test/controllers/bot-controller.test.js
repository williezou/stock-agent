const test = require("node:test");
const assert = require("node:assert/strict");
const { createBotController } = require("../../src/controllers/bot-controller");
const { LEGACY_BUTTONS, removeKeyboardMarkup } = require("../../src/views/bot-view");

function createMemoryStore(initial = [], registered = true) {
    const items = new Map([["100", new Map(initial.map(item => [item.symbol, item]))]]);
    const sessions = new Map();
    const profileUpdates = [];
    const subscribers = new Map(registered ? [["100", { chat_id: "100", status: "active" }]] : []);
    const bucket = chatId => {
        const key = String(chatId);
        if (!items.has(key)) items.set(key, new Map());
        return items.get(key);
    };
    return {
        profileUpdates,
        async list(chatId) { return [...bucket(chatId).values()]; },
        async get(chatId, symbol) { return bucket(chatId).get(symbol) || null; },
        async upsert(chatId, target) { bucket(chatId).set(target.symbol, target); return target; },
        async remove(chatId, symbol) { return bucket(chatId).delete(symbol); },
        async setSession(chatId, action) { sessions.set(String(chatId), action); },
        async getSession(chatId) { return sessions.get(String(chatId)) || null; },
        async clearSession(chatId) { sessions.delete(String(chatId)); },
        async getSubscriber(chatId) { return subscribers.get(String(chatId)) || null; },
        async listSubscriberSummaries() {
            return [...subscribers.values()].map(subscriber => ({
                watchlist: [...bucket(subscriber.chat_id).values()].map(({ symbol, name }) => ({ symbol, name })),
                created_date: "2026-10-28",
                ...subscriber
            }));
        },
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
        async setLonghuEnabled(chatId, enabled) {
            const subscriber = subscribers.get(String(chatId));
            if (!subscriber) return false;
            subscriber.longhu_enabled = enabled;
            return true;
        },
        async setFundFlowEnabled(chatId, enabled) {
            const subscriber = subscribers.get(String(chatId));
            if (!subscriber) return false;
            subscriber.fund_flow_enabled = enabled;
            return true;
        },
        async setVolumeSpikeEnabled(chatId, enabled) {
            const subscriber = subscribers.get(String(chatId));
            if (!subscriber) return false;
            subscriber.volume_spike_enabled = enabled;
            return true;
        },
        async updateSubscriberProfile(chatId, { username, firstName }) {
            const subscriber = subscribers.get(String(chatId));
            profileUpdates.push(String(chatId));
            subscriber.username = username;
            subscriber.first_name = firstName || subscriber.first_name;
        },
        async setSubscriberBanned(chatId, banned) {
            const subscriber = subscribers.get(String(chatId));
            if (!subscriber || (!banned && subscriber.status !== "banned")) return null;
            subscriber.status = banned ? "banned" : "active";
            return subscriber;
        },
        async findSubscribersByUsername(username) {
            const name = String(username).replace(/^@/, "").toLowerCase();
            return [...subscribers.values()].filter(subscriber => String(subscriber.username || "").toLowerCase() === name).slice(0, 2);
        },
        async deactivateSubscriber(chatId) {
            const subscriber = subscribers.get(String(chatId));
            if (!subscriber || subscriber.status === "banned") return false;
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

test("/longhu 切换龙虎榜推送，并支持 on/off 显式设置", async () => {
    const { controller, sent, store } = setup();
    await controller.handleUpdate(privateMessage("/longhu"));
    assert.equal((await store.getSubscriber(100)).longhu_enabled, false, "默认开启，首次切换为关闭");
    assert.match(sent.at(-1).text, /已关闭龙虎榜与游资动向推送/);
    await controller.handleUpdate(privateMessage("/longhu on"));
    assert.equal((await store.getSubscriber(100)).longhu_enabled, true);
    assert.match(sent.at(-1).text, /已开启龙虎榜推送/);
    await controller.handleUpdate(privateMessage("/longhu maybe"));
    assert.match(sent.at(-1).text, /用法/);
    assert.equal((await store.getSubscriber(100)).longhu_enabled, true);
});

test("/flow 切换资金异动提醒，并支持 on/off 显式设置", async () => {
    const { controller, sent, store } = setup();
    await controller.handleUpdate(privateMessage("/flow"));
    assert.equal((await store.getSubscriber(100)).fund_flow_enabled, false, "默认开启，首次切换为关闭");
    assert.match(sent.at(-1).text, /已关闭资金异动提醒/);
    await controller.handleUpdate(privateMessage("/flow 开启"));
    assert.equal((await store.getSubscriber(100)).fund_flow_enabled, true);
    assert.match(sent.at(-1).text, /已开启资金异动提醒/);
    await controller.handleUpdate(privateMessage("/flow maybe"));
    assert.match(sent.at(-1).text, /用法/);
});

test("/spike 单独切换量价异动提醒，不影响资金异动", async () => {
    const { controller, sent, store } = setup();
    await controller.handleUpdate(privateMessage("/spike"));
    assert.equal((await store.getSubscriber(100)).volume_spike_enabled, false, "默认开启，首次切换为关闭");
    assert.equal((await store.getSubscriber(100)).fund_flow_enabled, undefined);
    assert.match(sent.at(-1).text, /已关闭量价异动提醒/);
    await controller.handleUpdate(privateMessage("/spike on"));
    assert.equal((await store.getSubscriber(100)).volume_spike_enabled, true);
    assert.match(sent.at(-1).text, /已开启量价异动提醒/);
    await controller.handleUpdate(privateMessage("/spike maybe"));
    assert.match(sent.at(-1).text, /\/spike on/);
});

test("/users 只对管理员生效：列出启用/停用人数、自选股数量与关闭的推送，管理员停用后也能查看", async () => {
    const { controller, sent, store } = setup([{ symbol: "600519", name: "贵州茅台" }], { adminChatId: "100" });
    await store.registerSubscriber({ chatId: 300, username: "friend", firstName: "A<b>" });
    await store.upsert(300, { symbol: "600519", name: "贵州茅台" });
    await store.upsert(300, { symbol: "300308", name: "中际旭创" });
    await store.setLonghuEnabled(300, false);
    await store.setVolumeSpikeEnabled(300, false);
    await store.registerSubscriber({ chatId: 400, firstName: "Gone" });
    await store.deactivateSubscriber(400);
    await store.deactivateSubscriber(100);

    await controller.handleUpdate(privateMessage("/users"));
    const text = sent.at(-1).text;
    assert.match(text, /订阅用户：启用 1\/\d+，停用 2，拉黑 0/);
    assert.match(text, /开启龙虎榜 0 人，开启资金异动 1 人，开启量价异动 0 人/);
    assert.match(text, /自选股汇总（2只，按关注人数）<\/b>\n中际旭创 300308 · 1人\n贵州茅台 600519 · 1人/, "汇总只算启用用户（停用的管理员也关注了茅台）");
    assert.match(text, /1\. A&lt;b&gt;（@friend） <code>300<\/code>\n　自选2只 · 龙虎榜关 · 量价异动关 · 2026-10-28\n　贵州茅台、中际旭创/);
    assert.match(text, /<b>停用（\/stop 或屏蔽了机器人）<\/b>\n1\. 测试 <code>100<\/code>\n　自选1只 · 2026-10-28\n　贵州茅台/);

    await controller.handleUpdate(privateMessage("/users", 300, 300));
    assert.doesNotMatch(sent.at(-1).text, /订阅用户/, "非管理员不能查看");
});

test("每次发消息时同步用户名与名字：有变化才写库，删掉用户名也会同步", async () => {
    const { controller, store } = setup();
    const message = (text, from) => ({ ...privateMessage(text), message: { ...privateMessage(text).message, from } });
    await controller.handleUpdate(message("/list", { id: 100, username: "newname", first_name: "小明" }));
    assert.deepEqual(store.profileUpdates, ["100"]);
    assert.equal((await store.getSubscriber(100)).username, "newname");

    await controller.handleUpdate(message("/list", { id: 100, username: "newname", first_name: "小明" }));
    assert.deepEqual(store.profileUpdates, ["100"], "没有变化不写库");

    await controller.handleUpdate(message("/list", { id: 100, first_name: "小明" }));
    assert.equal((await store.getSubscriber(100)).username, null, "删掉用户名后同步为空");
    assert.equal(store.profileUpdates.length, 2);
});

test("/ban、/unban：管理员按用户ID或@用户名拉黑；被拉黑的用户消息一律不回复、/start 也不能重新启用", async () => {
    const { controller, sent, store } = setup([], { adminChatId: "100" });
    await store.registerSubscriber({ chatId: 300, username: "Friend", firstName: "小明" });
    // 用户300本人发的消息，资料与登记的一致（发消息会同步用户名和名字）
    const fromFriend = text => ({ message: { chat: { id: 300, type: "private" }, from: { id: 300, username: "Friend", first_name: "小明" }, text } });

    await controller.handleUpdate(privateMessage("/ban"));
    assert.match(sent.at(-1).text, /用法/);
    await controller.handleUpdate(privateMessage("/ban 999"));
    assert.match(sent.at(-1).text, /未找到用户 999/);
    await controller.handleUpdate(privateMessage("/ban 100"));
    assert.match(sent.at(-1).text, /不能拉黑管理员/);

    await controller.handleUpdate(privateMessage("/ban @friend"));
    assert.match(sent.at(-1).text, /🚫 已拉黑 小明（@Friend） <code>300<\/code>/);
    assert.equal((await store.getSubscriber(300)).status, "banned");

    const before = sent.length;
    await controller.handleUpdate(fromFriend("/list"));
    await controller.handleUpdate(fromFriend("/start"));
    await controller.handleUpdate(fromFriend("你好"));
    assert.equal(sent.length, before, "被拉黑后不回复任何消息");
    assert.equal((await store.getSubscriber(300)).status, "banned", "/start 不能解除拉黑");
    assert.equal(await store.deactivateSubscriber(300), false, "屏蔽机器人等停用操作不会覆盖拉黑状态");

    await controller.handleUpdate(privateMessage("/users"));
    assert.match(sent.at(-1).text, /拉黑 1[\s\S]*已拉黑（\/unban 用户ID 解除）<\/b>\n1\. 小明/);

    await controller.handleUpdate(privateMessage("/unban 300"));
    assert.match(sent.at(-1).text, /✅ 已解除拉黑 小明/);
    assert.equal((await store.getSubscriber(300)).status, "active");

    await controller.handleUpdate(privateMessage("/unban 300"));
    assert.match(sent.at(-1).text, /不在黑名单中/, "已启用的用户再次解除时只提示");

    await store.registerSubscriber({ chatId: 500, firstName: "停用的人" });
    await store.deactivateSubscriber(500);
    await controller.handleUpdate(privateMessage("/unban 500"));
    assert.match(sent.at(-1).text, /不在黑名单中/);
    assert.equal((await store.getSubscriber(500)).status, "inactive", "不会把自己 /stop 的用户重新启用");

    await store.registerSubscriber({ chatId: 600, username: "friend", firstName: "同名" });
    await controller.handleUpdate(privateMessage("/ban @FRIEND"));
    assert.match(sent.at(-1).text, /有多位用户用过用户名 @FRIEND，请改用用户ID/);
    assert.equal((await store.getSubscriber(600)).status, "active");

    await controller.handleUpdate(fromFriend("/ban 100"));
    assert.equal((await store.getSubscriber(100)).status, "active", "非管理员发 /ban 无效");
    assert.doesNotMatch(sent.at(-1).text, /拉黑/);
});

test("/users 人数多时自动拆成多条消息，每条都在Telegram长度上限内", () => {
    const { usersMessages } = require("../../src/views/bot-view");
    const { visibleLength } = require("../../src/lib/telegram-text");
    const users = Array.from({ length: 80 }, (_, i) => ({
        chat_id: String(i), first_name: `用户${i}`, status: "active", created_date: "2026-10-28",
        watchlist: Array.from({ length: 10 }, (_, j) => ({ symbol: String(600000 + i * 10 + j), name: `股票名称${j}` }))
    }));
    const messages = usersMessages(users, 50);
    assert.ok(messages.length > 1);
    assert.ok(messages.every(text => visibleLength(text) <= 4096));
    assert.ok(messages.every(text => (text.match(/<(b|i|code)>/g) || []).length <= 100), "每条消息的格式实体不超过100个");
    assert.equal(messages.join("\n").match(/^\d+\. 用户/gm).length, 80, "不丢人");
});

test("点击龙虎榜深层链接：订阅者收到席位明细，未订阅者不会被当作邀请码注册", async () => {
    const queries = [];
    const longhuService = {
        async getSeatDetails(date, symbol) {
            queries.push([date, symbol]);
            return symbol === "002249"
                ? { symbol, name: "大洋电机", changePct: 10, groups: [{ reason: "日涨幅偏离值达7%的证券", dealAmount: 1, buyTotal: 1, sellTotal: 1, netAmount: 1, buyers: [], sellers: [] }] }
                : null;
        }
    };
    const sent = [];
    const store = createMemoryStore([], true);
    const controller = createBotController({
        store, marketService: {}, longhuService,
        async sendMessage(chatId, text) { sent.push(text); },
        async answerCallback() {},
        inviteCode: "friends", adminChatId: "1"
    });
    await controller.handleUpdate(privateMessage("/start lhb_002249_20261027"));
    assert.deepEqual(queries[0], ["2026-10-27", "002249"]);
    assert.match(sent.at(-1), /大洋电机.*2026-10-27 龙虎榜/);

    await controller.handleUpdate(privateMessage("/start lhb_600000_20261027"));
    assert.match(sent.at(-1), /未查询到 <code>600000<\/code>/);

    await controller.handleUpdate(privateMessage("/start lhb_002249_20261027", 555));
    assert.match(sent.at(-1), /邀请码/);
    assert.equal(await store.getSubscriber(555), null, "未注册用户不会因点击链接而被注册");
});

test("龙虎榜席位以表格图片发送，画图失败时退回文字", async () => {
    const detail = { symbol: "002249", name: "大洋电机", changePct: 10, groups: [{ reason: "日涨幅偏离值达7%的证券", dealAmount: 1, buyTotal: 1, sellTotal: 1, netAmount: 1, buyers: [], sellers: [] }] };
    function build(renderSeatChart) {
        const sent = { photos: [], texts: [] };
        const controller = createBotController({
            store: createMemoryStore([], true),
            marketService: {},
            longhuService: { async getSeatDetails() { return detail; } },
            async sendMessage(chatId, text) { sent.texts.push(text); },
            async sendPhoto(chatId, png, caption, filename, options = {}) { sent.photos.push({ png, caption, keyboard: options.replyMarkup }); },
            renderSeatChart,
            async answerCallback() {},
            adminChatId: "1"
        });
        return { controller, sent };
    }
    const ok = build(() => Buffer.from("png"));
    await ok.controller.handleUpdate(privateMessage("/start lhb_002249_20261027"));
    assert.equal(ok.sent.photos.length, 1);
    assert.match(ok.sent.photos[0].caption, /大洋电机.*龙虎榜席位/);
    assert.deepEqual(ok.sent.photos[0].keyboard.inline_keyboard[0].map(button => button.text), ["东方财富", "同花顺", "电脑版"]);
    assert.deepEqual(ok.sent.texts, []);

    const broken = build(() => { throw new Error("未找到可用的中文字体"); });
    await broken.controller.handleUpdate(privateMessage("/start lhb_002249_20261027"));
    assert.equal(broken.sent.photos.length, 0);
    assert.match(broken.sent.texts[0], /大洋电机.*2026-10-27 龙虎榜/);
});

test("点击龙虎榜图片下方的股票名称按钮，回复该股席位表格", async () => {
    const answered = [];
    const photos = [];
    const controller = createBotController({
        store: createMemoryStore([], true),
        marketService: {},
        longhuService: { async getSeatDetails(date, symbol) { return { symbol, name: "大洋电机", changePct: 10, groups: [] }; } },
        async sendMessage() {},
        async sendPhoto(chatId, png, caption) { photos.push(caption); },
        renderSeatChart: () => Buffer.from("png"),
        async answerCallback(id) { answered.push(id); },
        adminChatId: "1"
    });
    await controller.handleUpdate({
        callback_query: { id: "cb", from: { id: 200 }, message: { chat: { id: 100, type: "private" } }, data: "lhb:002249:20261027" }
    });
    assert.deepEqual(answered, ["cb"]);
    assert.match(photos[0], /大洋电机.*2026-10-27 龙虎榜席位/);
});

test("席位查询防重复点击：生成中与60秒内重复点击只弹提示，冷却后可再次查看", async () => {
    let clock = 0;
    let release;
    const answered = [];
    const photos = [];
    const controller = createBotController({
        store: createMemoryStore([], true),
        marketService: {},
        longhuService: {
            async getSeatDetails(date, symbol) {
                await new Promise(resolve => { release = resolve; });
                return { symbol, name: "大洋电机", changePct: 10, groups: [] };
            }
        },
        async sendMessage() {},
        async sendPhoto(chatId, png, caption) { photos.push(caption); },
        renderSeatChart: () => Buffer.from("png"),
        async answerCallback(id, options = {}) { answered.push([id, options.text || ""]); },
        adminChatId: "1",
        now: () => clock
    });
    const tap = id => controller.handleUpdate({
        callback_query: { id, from: { id: 200 }, message: { chat: { id: 100, type: "private" } }, data: "lhb:002249:20261027" }
    });

    const first = tap("cb1");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(answered, [["cb1", ""]], "首次点击立即应答，不等生成完成");
    await tap("cb2");
    assert.deepEqual(answered[1], ["cb2", "正在生成席位表格，请稍候…"]);
    release();
    await first;
    assert.equal(photos.length, 1);

    clock += 30 * 1000;
    await tap("cb3");
    assert.deepEqual(answered[2], ["cb3", "席位已发送，请查看上方消息"]);
    assert.equal(photos.length, 1, "冷却期内不重复发送");

    clock += 31 * 1000;
    const again = tap("cb4");
    await new Promise(resolve => setImmediate(resolve));
    release();
    await again;
    assert.equal(photos.length, 2, "冷却结束后可再次查看");
});

test("不同股票的席位互不影响", async () => {
    const photos = [];
    const controller = createBotController({
        store: createMemoryStore([], true),
        marketService: {},
        longhuService: { async getSeatDetails(date, symbol) { return { symbol, name: symbol, changePct: 1, groups: [] }; } },
        async sendMessage() {},
        async sendPhoto(chatId, png, caption) { photos.push(caption); },
        renderSeatChart: () => Buffer.from("png"),
        async answerCallback() {},
        adminChatId: "1"
    });
    for (const data of ["lhb:002249:20261027", "lhb:600000:20261027", "lhb:002249:20261027"]) {
        await controller.handleUpdate({ callback_query: { id: data, from: { id: 200 }, message: { chat: { id: 100, type: "private" } }, data } });
    }
    assert.equal(photos.length, 2);
});
