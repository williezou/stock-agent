const test = require("node:test");
const assert = require("node:assert/strict");
const telegram = require("../../src/gateways/telegram");
const { deliverScan } = require("../../src/services/report-delivery");

test("扫描结论首次发送失败时，在图片之后补发一次且不重发图片", async t => {
    const sent = [];
    let summaryAttempts = 0;
    t.mock.method(telegram, "sendMessage", async () => {
        if (summaryAttempts++ === 0) throw new Error("timeout");
        sent.push("summary");
    });
    t.mock.method(telegram, "sendPhoto", async (chatId, photo, caption, filename) => { sent.push(filename); });
    t.mock.method(global, "setTimeout", fn => { fn(); return 0; });

    const result = await deliverScan({
        chatId: "admin",
        summary: "结论",
        delivery: { overviews: [], stocks: [] },
        date: "2026-10-27"
    });
    assert.deepEqual(sent, ["summary"]);
    assert.deepEqual(result, { sent: 1, failed: 0 });
});

test("扫描结论补发仍失败时只计一次失败", async t => {
    t.mock.method(telegram, "sendMessage", async () => { throw new Error("timeout"); });
    t.mock.method(telegram, "sendPhoto", async () => {});
    t.mock.method(global, "setTimeout", fn => { fn(); return 0; });
    const result = await deliverScan({ chatId: "admin", summary: "结论", delivery: { overviews: [], stocks: [] }, date: "2026-10-27" });
    assert.deepEqual(result, { sent: 0, failed: 1 });
});
