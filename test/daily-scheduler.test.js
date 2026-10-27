const test = require("node:test");
const assert = require("node:assert/strict");
const { isRunWindow, isTransientSkip } = require("../daily-scheduler");

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
