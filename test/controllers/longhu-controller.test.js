const test = require("node:test");
const assert = require("node:assert/strict");
const { coversMainExchanges, isLonghuWindow, isStable, runLonghuTick } = require("../../src/controllers/longhu-controller");

// 北京时间 = UTC + 8；可带秒，模拟执行耗时造成的漂移
const at = (hhmm, seconds = 0) => {
    const [hour, minute] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(2026, 9, 27, hour - 8, minute, seconds));
};
const FULL_BOARD = [
    { symbol: "600000", name: "沪股", changePct: 10, netAmount: 1e8, reason: "涨幅偏离" },
    { symbol: "000001", name: "深股", changePct: -10, netAmount: -1e8, reason: "跌幅偏离" }
];

function setup({ boards, subscribers = [{ chat_id: "100" }, { chat_id: "200" }], trading = { ok: true, verified: true }, sendError, fetchError, renderChart } = {}) {
    const calls = { sent: [], photos: [], texts: [], messages: [], completed: [], failed: [], deactivated: [], alerts: [], tradingChecks: 0, fetches: 0 };
    const store = {
        async listDueSubscribers(job, date, max, options) {
            assert.equal(job, "longhu");
            assert.deepEqual(options, { audience: "longhu" });
            return subscribers.filter(s => !calls.completed.some(c => c.chatId === s.chat_id));
        },
        async claimDeliveryRun() { return 1; },
        async completeDeliveryRun(_job, chatId, _date, status) { calls.completed.push({ chatId, status }); },
        async failDeliveryRun(_job, chatId) { calls.failed.push(chatId); },
        async deactivateSubscriber(chatId) { calls.deactivated.push(chatId); }
    };
    const services = {
        longhu: {
            async getBoardByDate() {
                if (fetchError) throw fetchError;
                return boards[Math.min(calls.fetches++, boards.length - 1)];
            }
        },
        async isTradingDay() { calls.tradingChecks++; return trading; },
        async sendMessage(chatId, text) {
            if (chatId === "admin") return calls.alerts.push(text);
            const error = sendError && sendError(chatId);
            if (error) throw error;
            calls.sent.push(chatId);
            calls.texts.push(chatId);
            calls.messages.push(text);
        },
        async sendPhoto(chatId, photo, caption, filename, options = {}) {
            const error = sendError && sendError(chatId);
            if (error) throw error;
            calls.sent.push(chatId);
            calls.photos.push({ chatId, caption, uploaded: Buffer.isBuffer(photo), photo, keyboard: options.replyMarkup });
            return { photo: [{ file_id: "small" }, { file_id: "large-file-id" }] };
        },
        renderChart: renderChart || (() => Buffer.from("png")),
        adminChatId: "admin",
        alerted: new Set(),
        botUsername: "stock_test_bot",
        state: { date: "", lastSlot: null, trading: null, counts: [] }
    };
    return { calls, services, store };
}

test("龙虎榜窗口为工作日北京时间17:30至20:30", () => {
    assert.equal(isLonghuWindow(at("17:29")), false);
    assert.equal(isLonghuWindow(at("17:30")), true);
    assert.equal(isLonghuWindow(at("20:29")), true);
    assert.equal(isLonghuWindow(at("20:30")), false);
    assert.equal(isLonghuWindow(new Date("2026-10-31T10:00:00.000Z")), false, "周六不推送");
});

test("需同时包含沪深两市、且连续三次数量不变才算发布完成", () => {
    assert.equal(coversMainExchanges(FULL_BOARD), true);
    assert.equal(coversMainExchanges([FULL_BOARD[0]]), false);
    assert.equal(isStable([2, 2]), false);
    assert.equal(isStable([1, 2, 2, 2]), true);
    assert.equal(isStable([2, 2, 3]), false);
});

test("按固定10分钟时段检查，18:00前不推送，连续三次稳定后推送", async () => {
    const { calls, services, store } = setup({ boards: [[FULL_BOARD[1]], FULL_BOARD] });
    assert.equal((await runLonghuTick(store, at("17:30"), services)).action, "waiting");
    assert.equal((await runLonghuTick(store, at("17:35"), services)).action, "waiting");
    assert.equal(calls.fetches, 1, "同一时段内不重复请求");
    assert.equal((await runLonghuTick(store, at("17:40"), services)).action, "waiting");
    assert.equal((await runLonghuTick(store, at("17:50"), services)).action, "waiting", "已稳定但未到18:00");
    const outcome = await runLonghuTick(store, at("18:00"), services);
    assert.equal(outcome.action, "processed");
    assert.deepEqual(calls.sent, ["100", "200"]);
    assert.deepEqual(calls.completed.map(c => c.status), ["done", "done"]);
    assert.equal(calls.tradingChecks, 1, "每天只判断一次交易日");
    assert.equal((await runLonghuTick(store, at("18:10"), services)).action, "not-due");
});

test("执行耗时造成的秒级漂移不会错过20:20的最后时段", async () => {
    const { calls, services, store } = setup({ boards: [[FULL_BOARD[0]]] });
    await runLonghuTick(store, at("20:19", 50), services);
    const outcome = await runLonghuTick(store, at("20:29", 59), services);
    assert.equal(outcome.action, "processed", "最后时段即使榜单未稳定也推送");
    assert.deepEqual(calls.sent, ["100", "200"]);
});

test("最后时段发送失败会立即重试一次，仍失败记为终止并提醒管理员；屏蔽机器人的用户被停用", async () => {
    const blocked = Object.assign(new Error("forbidden"), { response: { status: 403 } });
    let attempts = 0;
    const { calls, services, store } = setup({
        boards: [FULL_BOARD],
        subscribers: [{ chat_id: "100" }, { chat_id: "200" }, { chat_id: "300" }],
        sendError: id => {
            if (id === "200") return blocked;
            if (id === "300") return new Error("network");
            if (id === "100" && attempts++ === 0) return new Error("flaky");
            return null;
        }
    });
    const outcome = await runLonghuTick(store, at("20:20"), services);
    assert.deepEqual({ delivered: outcome.delivered, failed: outcome.failed, deactivated: outcome.deactivated }, { delivered: 1, failed: 1, deactivated: 1 });
    assert.deepEqual(calls.sent, ["100"], "首次失败后重试成功");
    assert.deepEqual(calls.deactivated, ["200"]);
    assert.deepEqual(calls.completed, [
        { chatId: "100", status: "done" },
        { chatId: "200", status: "blocked" },
        { chatId: "300", status: "failed" }
    ]);
    assert.deepEqual(calls.failed, [], "最后时段不再登记为待重试");
    assert.match(calls.alerts[0], /1位用户推送失败/);
});

test("休市日只判断一次交易日并跳过，不请求龙虎榜接口", async () => {
    const { calls, services, store } = setup({ boards: [FULL_BOARD], trading: { ok: false, reason: "法定节假日", verified: true } });
    assert.equal((await runLonghuTick(store, at("17:30"), services)).action, "skipped");
    assert.equal(calls.fetches, 0);
    assert.deepEqual(calls.completed.map(c => c.status), ["skipped", "skipped"]);
    assert.equal(calls.alerts.length, 0);
});

test("交易日最后时段仍无数据时提醒管理员；节假日接口不可用时提示可能休市", async () => {
    const verified = setup({ boards: [[]] });
    assert.equal((await runLonghuTick(verified.store, at("20:25"), verified.services)).action, "skipped");
    assert.match(verified.calls.alerts[0], /仍未获取到今日龙虎榜/);
    assert.doesNotMatch(verified.calls.alerts[0], /休市/);
    assert.deepEqual(verified.calls.completed.map(c => c.status), ["skipped", "skipped"]);

    const unverified = setup({ boards: [[]], trading: { ok: true, verified: false } });
    await runLonghuTick(unverified.store, at("20:25"), unverified.services);
    assert.match(unverified.calls.alerts[0], /若今日休市请忽略/);
});

test("最后时段取数失败时提醒管理员并把订阅者记为跳过", async () => {
    const early = setup({ boards: [], fetchError: new Error("502") });
    assert.equal((await runLonghuTick(early.store, at("18:00"), early.services)).action, "fetch-failed");
    assert.equal(early.calls.alerts.length, 0, "非最后时段等待下次检查");
    assert.equal(early.calls.completed.length, 0);

    const final = setup({ boards: [], fetchError: new Error("502") });
    await runLonghuTick(final.store, at("20:20"), final.services);
    assert.match(final.calls.alerts[0], /龙虎榜获取失败/);
    assert.deepEqual(final.calls.completed.map(c => c.status), ["skipped", "skipped"]);
});

test("推送图表（图片+概况说明），图表生成失败时退回文字版", async () => {
    const chart = setup({ boards: [FULL_BOARD] });
    const outcome = await runLonghuTick(chart.store, at("20:20"), chart.services);
    assert.equal(outcome.format, "chart");
    assert.deepEqual(chart.calls.photos.map(p => p.chatId), ["100", "200"]);
    assert.match(chart.calls.photos[0].caption, /龙虎榜｜2026-10-27/);
    assert.deepEqual(chart.calls.texts, []);

    const fallback = setup({ boards: [FULL_BOARD], renderChart: () => { throw new Error("未找到可用的中文字体"); } });
    const fallbackOutcome = await runLonghuTick(fallback.store, at("20:20"), fallback.services);
    assert.equal(fallbackOutcome.format, "text");
    assert.deepEqual(fallback.calls.texts, ["100", "200"]);
    assert.deepEqual(fallback.calls.photos, []);
});

test("图表只上传一次，后续订阅者复用Telegram返回的file_id", async () => {
    const { calls, services, store } = setup({ boards: [FULL_BOARD], subscribers: [{ chat_id: "100" }, { chat_id: "200" }, { chat_id: "300" }] });
    await runLonghuTick(store, at("20:20"), services);
    assert.deepEqual(calls.photos.map(p => p.uploaded), [true, false, false]);
    assert.deepEqual(calls.photos.slice(1).map(p => p.photo), ["large-file-id", "large-file-id"]);
});

test("图片下方按钮只放股票名称（回调按钮），净买入在前、净卖出另起一行，说明只留概况", async () => {
    const { calls, services, store } = setup({ boards: [FULL_BOARD] });
    await runLonghuTick(store, at("20:20"), services);
    assert.deepEqual(calls.photos[0].keyboard.inline_keyboard, [
        [{ text: "沪股", callback_data: "lhb:600000:20261027" }],
        [{ text: "深股", callback_data: "lhb:000001:20261027" }]
    ]);
    assert.doesNotMatch(calls.photos[0].caption, /<a /, "说明里不再堆叠链接");
    assert.deepEqual(calls.photos[1].keyboard, calls.photos[0].keyboard, "复用file_id时按钮一并发送");
});

test("每日总结网页：榜单写入网页后只更新各用户的入口页，不单独推送；网页写入失败时照常推图", async () => {
    const { calls, services, store } = setup({ boards: [FULL_BOARD] });
    const published = { longhu: [], indexes: [] };
    store.getSubscriber = async chatId => ({ chat_id: chatId, longhu_enabled: true });
    services.dailyPage = {
        async publishLonghu({ date, board, botUsername, render }) {
            published.longhu.push({ date, count: board.length, botUsername, png: render({ date, board }).toString() });
        },
        async publishIndex(subscriber, date) { published.indexes.push([subscriber.chat_id, date]); }
    };
    const outcome = await runLonghuTick(store, at("20:20"), services);
    assert.equal(outcome.format, "page");
    assert.deepEqual(published.longhu, [{ date: "2026-10-27", count: 2, botUsername: "stock_test_bot", png: "png" }]);
    assert.deepEqual(published.indexes, [["100", "2026-10-27"], ["200", "2026-10-27"]]);
    assert.deepEqual(calls.sent, [], "第二条推送由游资动向发");
    assert.deepEqual(calls.completed.map(c => c.status), ["done", "done"]);

    const broken = setup({ boards: [FULL_BOARD] });
    broken.services.dailyPage = { async publishLonghu() { throw new Error("storage down"); } };
    assert.equal((await runLonghuTick(broken.store, at("20:20"), broken.services)).format, "chart");
    assert.deepEqual(broken.calls.photos.map(p => p.chatId), ["100", "200"]);
});

test("文字版的股票名称链接按各自选择的App", async () => {
    const { calls, services, store } = setup({
        boards: [FULL_BOARD],
        subscribers: [{ chat_id: "100" }, { chat_id: "200", quote_app: "xueqiu" }],
        renderChart: () => { throw new Error("未找到可用的中文字体"); }
    });
    await runLonghuTick(store, at("20:20"), services);
    assert.match(calls.messages[0], /mlink\.eastmoney\.com[^"]*600000/);
    assert.match(calls.messages[1], /<a href="https:\/\/xueqiu.com\/S\/SH600000">沪股<\/a>/);
    assert.match(calls.messages[1], /点股票名称打开雪球/);
});
