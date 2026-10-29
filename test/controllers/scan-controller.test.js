const test = require("node:test");
const assert = require("node:assert/strict");
const { runScanTick } = require("../../src/controllers/scan-controller");
const { scanPageHtml } = require("../../src/views/daily-page-view");
const { formatScanMessage } = require("../../src/views/scan-view");
const { QuoteApp } = require("../../src/views/quote-app");

const at = hhmm => {
    const [hour, minute] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(2026, 9, 29, hour - 8, minute));
};

function report(symbol, style, recommendation) {
    const value = 10;
    return {
        style,
        meta: { symbol, name: `股票${symbol}`, exchangeCode: `${symbol}.SH` },
        klines: [],
        analysis: {
            latest: { close: value, changePct: 1.5, open: value, high: value, low: value, amount: 1e8, turnover: 3 },
            ma: {}, volumeRatio: 1.4, support: 9.5, resistance: 11, weightedClose20: value
        },
        plan: { recommendation, reason: "测试理由", entryLow: 9.4, entryHigh: 9.6, breakoutTrigger: 11, stop: 8.9, target: 11, rewardRisk: 2, overheated: false },
        news: [],
        announcements: []
    };
}

const RESULT = {
    ok: true,
    date: "2026-10-29",
    picksByStyle: {
        intraday: [{ item: { symbol: "600001", name: "股票600001" }, report: report("600001", "intraday", "条件性试仓") }],
        short: [{ item: { symbol: "600002", name: "股票600002", gap: "1.00%" }, report: null }],
        swing: [],
        mid: [{ item: { symbol: "600003", name: "股票600003" }, report: report("600003", "mid", "观望") }]
    },
    longhiData: { riseStocks: [{ symbol: "600009", name: "涨停股", changePct: 10 }], declineStocks: [] }
};

test("推送：今日结论（股票名称打开所选App）+ 入选概况，四类明细在网页里", () => {
    const text = formatScanMessage({ ...RESULT, now: "2026-10-29 15:40:00" }, { app: QuoteApp.get("xueqiu") });
    assert.match(text, /^<b>📈 A股扫描｜2026-10-29 15:40:00<\/b>\n市场：涨停1家／跌停0家，情绪中性\n可操作1只/);
    assert.match(text, /<a href="https:\/\/xueqiu\.com\/S\/SH600001">股票600001<\/a> <code>600001<\/code>［日内］<b>条件性试仓<\/b>/);
    assert.match(text, /入选3只（日内1 短线1 波段0 中线1）/);
    assert.match(text, /点股票名称打开雪球。.*\/scan off 关闭/);
});

test("网页：导航与四类入选，个股卡片带K线图，没有报告或没有入选时注明；热点不含已入选", () => {
    const html = scanPageHtml({ ...RESULT, now: "2026-10-29 15:40:00", chartUrls: new Map([["600001", "https://pages.test/k-600001.png"]]), app: QuoteApp.get("cmschina") });
    assert.match(html, /<title>A股扫描｜2026-10-29<\/title>/);
    assert.match(html, /<a href="#style-swing">波段入选<\/a>/);
    assert.match(html, /<section id="style-intraday"><h2>日内入选<\/h2><div class="card" id="s-600001">/);
    assert.match(html, /<img src="https:\/\/pages\.test\/k-600001\.png"/);
    assert.match(html, /股票600002<\/a>｜K线数据不足，未生成建议/);
    assert.match(html, /<section id="style-swing"><h2>波段入选<\/h2><div class="card"><p class="pending">无符合条件标的<\/p>/);
    assert.match(html, /📈 涨停 1只<\/b><div class="tg"><a href="https:\/\/weixin\.newone\.com\.cn[^"]+">涨停股<\/a> \+10\.00%/);
    assert.match(html, /测试理由/, "网页里的结论带理由");
});

function setup({ scan = async () => RESULT } = {}) {
    const calls = { messages: [], completed: [], scans: 0, pages: 0 };
    const subscribers = [{ chat_id: "100" }, { chat_id: "200", quote_app: "xueqiu" }];
    const store = {
        async listDueSubscribers(job, date, max, options) {
            assert.equal(job, "scan");
            assert.deepEqual(options, { audience: "scan" });
            return subscribers.filter(s => !calls.completed.some(c => c.chatId === s.chat_id));
        },
        async claimDeliveryRun() { return 1; },
        async completeDeliveryRun(_job, chatId, _date, status, message) { calls.completed.push({ chatId, status, message }); },
        async failDeliveryRun() {},
        async deactivateSubscriber() {}
    };
    const services = {
        cache: { date: "", result: null, failedAt: 0, pageUrl: null },
        now: "2026-10-29 15:40:00",
        async runScan() { calls.scans++; return scan(); },
        dailyPage: {
            async publishScan({ date, picksByStyle }) {
                calls.pages++;
                assert.equal(date, "2026-10-29");
                assert.equal(picksByStyle.intraday.length, 1);
                return app => `https://pages.test/s/${date}/scan.${app.key}.html`;
            }
        },
        async sendMessage(chatId, text, options) { calls.messages.push({ chatId, text, options }); },
        adminChatId: "admin",
        alerted: new Set()
    };
    return { calls, services, store };
}

test("A股扫描调度：15:40起扫描一次、写网页一次，每人推结论加各自App的网页按钮", async () => {
    const early = setup();
    assert.deepEqual(await runScanTick(early.store, at("15:39"), early.services), { action: "outside-window" });

    const { calls, services, store } = setup();
    const result = await runScanTick(store, at("15:40"), services);
    assert.equal(result.delivered, 2);
    assert.equal(calls.scans, 1);
    assert.equal(calls.pages, 1);
    assert.deepEqual(calls.messages[1].options.replyMarkup, { inline_keyboard: [[{ text: "📈 打开今日A股扫描", url: "https://pages.test/s/2026-10-29/scan.xueqiu.html" }]] });
    assert.match(calls.messages[0].text, /mlink\.eastmoney\.com/);
    await runScanTick(store, at("15:50"), services);
    assert.equal(calls.scans, 1, "当天只扫描一次");
});

test("休市时全部跳过；取数失败10分钟后再试，最后时段仍失败才提醒管理员", async () => {
    const holiday = setup({ scan: async () => ({ ok: false, retryable: false, reason: "非交易日（周末）：2026-10-29" }) });
    assert.equal((await runScanTick(holiday.store, at("15:40"), holiday.services)).action, "skipped");
    assert.deepEqual(holiday.calls.completed.map(c => c.status), ["skipped", "skipped"]);

    const failing = setup({ scan: async () => ({ ok: false, retryable: true, reason: "拉取A股列表失败" }) });
    assert.deepEqual(await runScanTick(failing.store, at("15:40"), failing.services), { action: "scan-failed", final: false });
    assert.deepEqual(await runScanTick(failing.store, at("15:45"), failing.services), { action: "waiting" });
    assert.equal(failing.calls.scans, 1);
    await runScanTick(failing.store, at("15:51"), failing.services);
    assert.equal(failing.calls.scans, 2, "10分钟后重试");
    assert.deepEqual(await runScanTick(failing.store, at("17:00"), failing.services), { action: "scan-failed", final: true });
    assert.match(failing.calls.messages.find(m => m.chatId === "admin").text, /今日A股扫描失败：拉取A股列表失败/);
    assert.deepEqual(failing.calls.completed.map(c => c.status), ["skipped", "skipped"]);
});

test("网页写入失败时改推完整的扫描结论文字", async () => {
    const { calls, services, store } = setup();
    services.dailyPage = { async publishScan() { throw new Error("storage down"); } };
    assert.equal((await runScanTick(store, at("15:40"), services)).delivered, 2);
    assert.match(calls.messages[0].text, /<b>A股扫描<\/b>｜2026-10-29 15:40:00[^]*📋 分类入选/);
    assert.equal(calls.messages[0].options, undefined);
});
