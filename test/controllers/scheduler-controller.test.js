const test = require("node:test");
const assert = require("node:assert/strict");
const { isFinalWindow, isRunWindow, isTransientSkip, runSchedulerTick } = require("../../src/controllers/scheduler-controller");

test("每日调度窗口为工作日北京时间15:30至18:00", () => {
    assert.equal(isRunWindow(new Date("2026-10-27T07:29:00.000Z")), false);
    assert.equal(isRunWindow(new Date("2026-10-27T07:30:00.000Z")), true);
    assert.equal(isRunWindow(new Date("2026-10-27T09:59:00.000Z")), true);
    assert.equal(isRunWindow(new Date("2026-10-27T10:00:00.000Z")), false);
    assert.equal(isRunWindow(new Date("2026-10-31T07:30:00.000Z")), false);
});

test("日K未就绪会进入延迟重试", () => {
    assert.equal(isTransientSkip("2026-10-27没有完整日K，按非交易日或数据未就绪处理"), true);
    assert.equal(isTransientSkip("自选股列表为空"), false);
});

test("临近窗口结束时允许发送可用股票", () => {
    assert.equal(isFinalWindow(new Date("2026-10-27T09:29:00.000Z")), false);
    assert.equal(isFinalWindow(new Date("2026-10-27T09:30:00.000Z")), true);
});

test("多用户股票合并分析后按各自列表独立投递", async () => {
    const targetA = { symbol: "600887", name: "伊利股份" };
    const targetB = { symbol: "002380", name: "科远智慧" };
    const targetC = { symbol: "600519", name: "贵州茅台" };
    const lists = new Map([
        ["100", [targetA, targetB]],
        ["200", [targetB, targetC]]
    ]);
    const completed = [];
    const delivered = [];
    const store = {
        async listDueSubscribers() { return [{ chat_id: "100" }, { chat_id: "200" }]; },
        async list(chatId) { return lists.get(String(chatId)) || []; },
        async claimDeliveryRun() { return 1; },
        async completeDeliveryRun(_job, chatId, _date, status) { completed.push({ chatId, status }); },
        async failDeliveryRun() { throw new Error("不应重试"); },
        async deactivateSubscriber() {}
    };
    const outcome = await runSchedulerTick(store, new Date("2026-10-27T07:30:00.000Z"), {
        async buildReports({ targets }) {
            assert.deepEqual(targets.map(item => item.symbol), ["600887", "002380", "600519"]);
            return {
                skipped: false,
                date: "2026-10-27",
                reports: targets.map(meta => ({ meta }))
            };
        },
        async deliverDailyClose({ chatId, reports }) {
            delivered.push({ chatId, symbols: reports.map(report => report.meta.symbol) });
        },
        async sendMessage() {}
    });
    assert.deepEqual(delivered, [
        { chatId: "100", symbols: ["600887", "002380"] },
        { chatId: "200", symbols: ["002380", "600519"] }
    ]);
    assert.deepEqual(completed, [
        { chatId: "100", status: "done" },
        { chatId: "200", status: "done" }
    ]);
    assert.equal(outcome.delivered, 2);
});

function partialStore(overrides = {}) {
    const calls = { completed: [], failed: [] };
    const store = {
        async listDueSubscribers() { return [{ chat_id: "100" }, { chat_id: "200" }]; },
        async list() { return [{ symbol: "600887", name: "伊利股份" }, { symbol: "002380", name: "科远智慧" }]; },
        async claimDeliveryRun() { return 1; },
        async completeDeliveryRun(_job, chatId, _date, status) { calls.completed.push({ chatId, status }); },
        async failDeliveryRun(_job, chatId) { calls.failed.push(chatId); },
        async deactivateSubscriber() {},
        ...overrides
    };
    return { calls, store };
}

const finalWindow = new Date("2026-10-27T09:40:00.000Z");
const partialReports = {
    async buildReports() {
        return { skipped: false, date: "2026-10-27", reports: [{ meta: { symbol: "600887" } }] };
    }
};

test("缺失提示发送失败不影响已完成的投递", async () => {
    const { calls, store } = partialStore();
    const outcome = await runSchedulerTick(store, finalWindow, {
        ...partialReports,
        async deliverDailyClose() {},
        async sendMessage() { throw new Error("timeout"); }
    });
    assert.deepEqual(calls.completed.map(item => item.status), ["done", "done"]);
    assert.deepEqual(calls.failed, []);
    assert.equal(outcome.delivered, 2);
});

test("单个用户的状态写入失败不会中断后续用户", async () => {
    const { calls, store } = partialStore({
        async completeDeliveryRun(_job, chatId, _date, status) {
            if (chatId === "100") throw new Error("pg down");
            calls.completed.push({ chatId, status });
        }
    });
    const outcome = await runSchedulerTick(store, finalWindow, {
        ...partialReports,
        async deliverDailyClose() {},
        async sendMessage() {}
    });
    assert.deepEqual(calls.completed, [{ chatId: "200", status: "done" }]);
    assert.equal(outcome.failed, 1);
    assert.equal(outcome.delivered, 1);
});

test("行情源异常时每天只提醒管理员一次", async () => {
    const { calls, store } = partialStore();
    const alerts = [];
    const alerted = new Set();
    const services = {
        async buildReports() {
            return {
                skipped: false,
                date: "2026-10-27",
                reports: [{ meta: { symbol: "600887" } }, { meta: { symbol: "002380" } }],
                dataHealth: { primaryFailures: 2, fallbackUsed: 4, fallbackFailures: 0, lastPrimaryError: "ECONNRESET" }
            };
        },
        async deliverDailyClose() {},
        async sendMessage(chatId, text) { if (chatId === "admin") alerts.push(text); },
        adminChatId: "admin",
        alerted
    };
    await runSchedulerTick(store, finalWindow, services);
    await runSchedulerTick(store, finalWindow, services);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /东方财富.*ECONNRESET.*切换备用源/);
    assert.equal(calls.completed.length, 4);
});

test("告警发送失败会在下一轮重试，生成失败在最后机会提示最终失败", async () => {
    const { store } = partialStore();
    const alerts = [];
    let failSend = true;
    const alerted = new Set(["2026-10-26:primary"]);
    const services = {
        async buildReports() { throw new Error("行情全部失败"); },
        async deliverDailyClose() {},
        async sendMessage(chatId, text) {
            if (failSend) throw new Error("network");
            alerts.push(text);
        },
        adminChatId: "admin",
        alerted
    };
    await assert.rejects(runSchedulerTick(store, new Date("2026-10-27T08:00:00.000Z"), services));
    assert.equal(alerts.length, 0);
    assert.ok(!alerted.has("2026-10-26:primary"), "往日告警记录被清理");
    failSend = false;
    await assert.rejects(runSchedulerTick(store, new Date("2026-10-27T08:10:00.000Z"), services));
    assert.match(alerts[0], /将在约10分钟后重试/);
    await assert.rejects(runSchedulerTick(store, new Date("2026-10-27T09:55:00.000Z"), services));
    assert.match(alerts[1], /最终生成失败/);
    assert.equal(alerts.length, 2);
});

test("行情源告警列出实际使用的数据源：纯IPv6时不含同花顺", () => {
    const { dataSourceAlerts } = require("../../src/controllers/scheduler-controller");
    const health = { primaryFailures: 1, lastPrimaryError: "ECONNRESET", fallbackFailures: 2, sources: {} };
    const [primary, fallback] = dataSourceAlerts(health, "2026-10-28");
    assert.match(primary.text, /切换备用源（同花顺\/财联社\/腾讯）/);
    assert.match(fallback.text, /东方财富、同花顺、财联社、腾讯行情源均获取失败/);

    const original = process.env.IPV6_ONLY;
    process.env.IPV6_ONLY = "true";
    try {
        const [ipv6Primary, ipv6Fallback] = dataSourceAlerts(health, "2026-10-28");
        assert.match(ipv6Primary.text, /切换备用源（财联社\/腾讯）/);
        assert.match(ipv6Fallback.text, /东方财富、财联社、腾讯行情源均获取失败/);
    } finally {
        if (original === undefined) delete process.env.IPV6_ONLY;
        else process.env.IPV6_ONLY = original;
    }
});

test("管理员告警去重记录可存库（异步 has/add）：重启后同一天不再提醒；记录读取失败时仍会提醒", async () => {
    const { alertAdmin } = require("../../src/services/admin-alert");
    const rows = new Set();
    const persisted = { async has(key) { return rows.has(key); }, async add(key) { rows.add(key); } };
    const sent = [];
    const context = { notify: async (_chatId, text) => sent.push(text), adminChatId: "admin", alerted: persisted, dateStr: "2026-10-28" };
    await alertAdmin(context, { key: "2026-10-28:primary", text: "东财异常" });
    await alertAdmin({ ...context }, { key: "2026-10-28:primary", text: "东财异常" }); // 模拟重启后再次触发
    assert.deepEqual(sent, ["东财异常"]);
    assert.ok(rows.has("2026-10-28:primary"));

    const broken = { async has() { throw new Error("db down"); }, async add() { throw new Error("db down"); } };
    await alertAdmin({ ...context, alerted: broken }, { key: "2026-10-28:fallback", text: "备用源也失败" });
    assert.deepEqual(sent, ["东财异常", "备用源也失败"]);
});

test("每日总结网页：先写盘中异动回顾，每人写自己的收盘内容后只推一条概况+按钮；网页写入失败的用户退回逐条推图", async () => {
    const report = symbol => ({
        meta: { symbol, name: `股${symbol}` },
        analysis: { latest: { close: 10, changePct: 1 } },
        plan: { recommendation: "观望" }
    });
    const calls = { intraday: [], published: [], messages: [], fallback: [], completed: [] };
    const store = {
        async listDueSubscribers() { return [{ chat_id: "100" }, { chat_id: "200" }]; },
        async list() { return [{ symbol: "600887", name: "伊利股份" }]; },
        async getSubscriber(chatId) { return { chat_id: chatId, longhu_enabled: true }; },
        async listFundFlowAlerts(date) { return [{ label: "尾盘", date }]; },
        async claimDeliveryRun() { return 1; },
        async completeDeliveryRun(_job, chatId, _date, status) { calls.completed.push({ chatId, status }); },
        async failDeliveryRun() { throw new Error("不应重试"); },
        async deactivateSubscriber() {}
    };
    const outcome = await runSchedulerTick(store, new Date("2026-10-27T07:30:00.000Z"), {
        async buildReports() { return { skipped: false, date: "2026-10-27", reports: [report("600887")] }; },
        dailyPage: {
            async publishIntraday(date, alerts) { calls.intraday.push({ date, alerts }); },
            async publishClose(subscriber, { reports, date }) {
                if (subscriber.chat_id === "200") throw new Error("storage down");
                calls.published.push({ chatId: subscriber.chat_id, date, symbols: reports.map(item => item.meta.symbol) });
                return `https://pages.test/p/${subscriber.chat_id}/index.html`;
            }
        },
        async deliverDailyClose({ chatId }) { calls.fallback.push(chatId); },
        async sendMessage(chatId, text, options) { calls.messages.push({ chatId, text, options }); }
    });
    assert.deepEqual(calls.intraday, [{ date: "2026-10-27", alerts: [{ label: "尾盘", date: "2026-10-27" }] }]);
    assert.deepEqual(calls.published, [{ chatId: "100", date: "2026-10-27", symbols: ["600887"] }]);
    assert.equal(calls.messages.length, 1);
    assert.match(calls.messages[0].text, /📊 每日收盘总结｜2026-10-27[^]*股600887/);
    assert.deepEqual(calls.messages[0].options.replyMarkup.inline_keyboard[0][0], { text: "📄 打开今日总结", url: "https://pages.test/p/100/index.html" });
    assert.deepEqual(calls.fallback, ["200"]);
    assert.deepEqual(calls.completed.map(item => item.status), ["done", "done"]);
    assert.equal(outcome.delivered, 2);
});
