const test = require("node:test");
const assert = require("node:assert/strict");
const { isFinalWindow, isRunWindow, isTransientSkip, runSchedulerTick } = require("../daily-scheduler");

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
        async listActiveSubscribers() { return [{ chat_id: "100" }, { chat_id: "200" }]; },
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
        async sendTelegramTo() {}
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
