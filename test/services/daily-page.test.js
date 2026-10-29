const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 每日总结网页写入临时目录（本地目录托管）
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-page-"));
process.env.DAILY_PAGE_DIR = dir;
process.env.DAILY_PAGE_BASE_URL = "http://pages.test/";
process.env.DAILY_PAGE_SECRET = "test-secret";
delete process.env.DAILY_PAGE_BUCKET;

const { config } = require("../../src/config");
const { publicUrl } = require("../../src/gateways/page-storage");
const { dailyPage, pageToken, resolveDailyPage, sharedToken } = require("../../src/services/daily-page");
const view = require("../../src/views/daily-page-view");

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = name => fs.readFileSync(path.join(dir, ...name.split("/")), "utf8");
const exists = name => fs.existsSync(path.join(dir, ...name.split("/")));

function report(symbol, name, { changePct = 1.5, klines = 0 } = {}) {
    return {
        meta: { symbol, name, exchangeCode: `${symbol}.SZ` },
        klines: Array.from({ length: klines }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, "0")}`, open: 10 + index * 0.1, high: 10.5 + index * 0.1, low: 9.8 + index * 0.1, close: 10.2 + index * 0.1, volume: 1e6 })),
        analysis: {
            latest: { date: "2026-10-25", close: 12.34, changePct, open: 12, high: 12.5, low: 11.9, amount: 3.2e8 },
            ma: { ma5: 12, ma10: 11.8, ma20: 11.5, ma60: 11 },
            macd: { dif: 0.12, dea: 0.1, histogram: 0.04 },
            rsi: 58.2,
            kdj: { k: 60, d: 55, j: 70 },
            bollinger: { lower: 11, middle: 11.8, upper: 12.6 },
            support: 11.6,
            resistance: 12.9,
            volumeRatio: 1.35,
            weightedClose20: 11.7
        },
        plan: { recommendation: "观望", entryLow: 11.6, entryHigh: 11.9, breakoutTrigger: 12.95, stop: 10.9, target: 14.2, rewardRisk: 2.1 },
        announcements: [{ title: "三季度报告", url: "https://example.com/a", date: "2026-10-28" }],
        news: []
    };
}

test("开启条件：需要密钥，且配置了存储桶或本地目录；页面内引用本地地址时去掉结尾斜杠", () => {
    assert.equal(config.dailyPage.enabled, true);
    assert.equal(resolveDailyPage(), dailyPage);
    assert.equal(resolveDailyPage({ dailyPage: null }), null, "测试可显式关闭");
    assert.equal(publicUrl("p/abc/index.html"), "http://pages.test/p/abc/index.html");
});

test("页面令牌：同一用户同一天固定，换用户或换日期就不同，长度32位", () => {
    const token = pageToken("100", "2026-10-28");
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.equal(pageToken("100", "2026-10-28"), token);
    assert.notEqual(pageToken("200", "2026-10-28"), token);
    assert.notEqual(pageToken("100", "2026-10-29"), token);
    assert.equal(dailyPage.pageUrl("100", "2026-10-28"), `http://pages.test/p/${token}/index.html`);
});

test("入口页按推送开关列出各段：关掉的提醒不出现；页面不被搜索引擎收录", async () => {
    const url = await dailyPage.publishIndex({ chat_id: "100", longhu_enabled: false, fund_flow_enabled: false, volume_spike_enabled: true }, "2026-10-28");
    const token = pageToken("100", "2026-10-28");
    assert.equal(url, `http://pages.test/p/${token}/index.html`);
    const html = read(`p/${token}/index.html`);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(html, /<title>每日总结｜2026-10-28<\/title>/);
    assert.match(html, new RegExp(`data-src="http://pages.test/p/${token}/close.html"`));
    assert.match(html, /data-src="http:\/\/pages.test\/s\/[0-9a-f]{32}\/intraday.html"/, "量价异动开着，回顾仍在");
    assert.doesNotMatch(html, /longhu\.html|hot-money\.html/, "龙虎榜关闭");

    await dailyPage.publishIndex({ chat_id: "200", fund_flow_enabled: false, volume_spike_enabled: false }, "2026-10-28");
    const other = read(`p/${pageToken("200", "2026-10-28")}/index.html`);
    assert.doesNotMatch(other, /intraday\.html/, "两种盘中提醒都关了");
    assert.match(other, /s\/[0-9a-f]{32}\/longhu\.html[^]*s\/[0-9a-f]{32}\/hot-money\.html/);
});

test("自选股收盘：K线图所有用户共用、只写一次；图表生成失败时卡片只有文字", async () => {
    const reports = [report("300308", "中际旭创", { klines: 25 }), report("000001", "平安银行", { changePct: -2 })];
    const url = await dailyPage.publishClose({ chat_id: "100" }, { reports, date: "2026-10-27" });
    assert.match(url, /\/index\.html$/);
    assert.ok(exists(`s/${sharedToken("2026-10-27")}/k-300308.png`));
    assert.ok(!exists(`s/${sharedToken("2026-10-27")}/k-000001.png`), "不足20根K线画不了图");
    const close = read(`p/${pageToken("100", "2026-10-27")}/close.html`);
    assert.match(close, /<img src="http:\/\/pages.test\/s\/[0-9a-f]{32}\/k-300308.png"/);
    assert.equal((close.match(/<img /g) || []).length, 1);

    fs.rmSync(path.join(dir, "s", sharedToken("2026-10-27"), "k-300308.png"));
    await dailyPage.publishClose({ chat_id: "200" }, { reports, date: "2026-10-27" });
    assert.ok(!exists(`s/${sharedToken("2026-10-27")}/k-300308.png`), "同一天同一只股票不重复写图");
    assert.match(read(`p/${pageToken("200", "2026-10-27")}/close.html`), /k-300308\.png/, "仍引用已写入的图");
});

test("收盘片段：总览表点名称跳到个股卡片；卡片只放价格、交易计划、支撑压力与催化，技术指标收在详情里", () => {
    const html = view.closeFragment({ reports: [report("300308", "中际旭创"), report("000001", "平安银行", { changePct: -2 })], chartUrls: new Map() });
    assert.match(html, /<td><a href="#s-300308">中际旭创<\/a><\/td><td>12\.34<\/td><td class="up">\+1\.50%<\/td><td><b>观望<\/b><\/td>/);
    assert.match(html, /<td class="down">-2\.00%<\/td>/);
    assert.match(html, /<div class="card" id="s-300308"><div class="stock-head"><a href="https:\/\/mlink\.eastmoney\.com[^"]+">中际旭创<\/a>/);
    assert.match(html, /<b>观望<\/b>｜回踩 11\.60～11\.90｜突破 12\.95｜止损 10\.90｜目标 14\.20/);
    assert.match(html, /支撑 11\.60｜压力 12\.90｜成交 3\.20亿元｜量比 1\.35x/);
    assert.match(html, /📰 2026-10-28｜<a href="https:\/\/example\.com\/a">三季度报告<\/a>/);
    assert.match(html, /<details><summary>技术指标<\/summary><div class="tg">MA5\/10\/20\/60 12\.00\/11\.80\/11\.50\/11\.00\nMACD/);
    assert.doesNotMatch(html, /<img /, "没有图时不放图片");
});

test("盘中异动回顾：所有推送合并成两张清单，按时间排序；早期记录没有触发时间时用推送时间；没有推送时注明", () => {
    const row = (symbol, name, extra) => ({ symbol, name, changePct: 3, ...extra });
    const alerts = [
        { label: "量价:上午", content: { label: "上午", since: "09:30", time: "09:40", lookbackMinutes: 5,
            up: [row("002029", "七匹狼", { windowChange: 3.5, windowAmount: 5.188e7, time: "09:37" })],
            down: [row("603296", "华勤技术", { changePct: -8.61, windowChange: -2.56, windowAmount: 8.022e7, time: "09:35" })] } },
        { label: "量价:上午", content: { label: "上午", since: "09:31", time: "09:36", minutes: 5,
            up: [row("600000", "浦 发 银 行", { windowChange: 2.1, windowAmount: 6e7 })], down: [] } },
        { label: "尾盘", content: { label: "尾盘", since: "14:30", time: "14:45",
            inflow: [row("300308", "中际旭创", { delta: 8.75e8 })], outflow: [row("000858", "五粮液", { changePct: -6.04, delta: -7.951e7, estimated: true })] } }
    ];
    const html = view.intradayFragment({ alerts });
    assert.match(html, /<b>量价异动 3只（急涨2、急跌1）<\/b>/);
    const order = [...html.matchAll(/<tr><td>(\d\d:\d\d)<\/td><td><a [^>]+>([^<]+)<\/a>/g)].map(match => `${match[1]} ${match[2]}`);
    assert.deepEqual(order, ["09:35 华勤技术", "09:36 浦发银行", "09:37 七匹狼", "14:45 中际旭创", "14:45 五粮液"]);
    assert.match(html, /<td class="down">-2\.56%<\/td><td>8022万<\/td><td class="down">-8\.61%<\/td>/);
    assert.match(html, /<b>尾盘资金异动 2只<\/b>/);
    assert.match(html, /<td class="down"><b>≤-7951万<\/b><\/td>/);
    assert.match(view.intradayFragment({ alerts: [] }), /今日没有盘中异动推送/);
});

test("龙虎榜与游资：图表加收起的明细（去掉推送末尾的说明）；没有图时明细直接显示", () => {
    const board = [{ symbol: "600000", name: "沪股", changePct: 10, netAmount: 1e8, reason: "涨幅偏离" }];
    const longhu = view.longhuFragment({ date: "2026-10-28", board, botUsername: "stock_test_bot", chartUrl: "http://pages.test/s/2026-10-28/longhu.png" });
    assert.match(longhu, /<img src="http:\/\/pages.test\/s\/2026-10-28\/longhu.png"[^>]*><details><summary>榜单明细（点📋查看买卖席位）<\/summary>/);
    assert.match(longhu, /https:\/\/t\.me\/stock_test_bot\?start=lhb_600000_20261028/);
    assert.doesNotMatch(longhu, /<i>/, "说明不再逐条重复");

    const content = { date: "2026-10-28", totalSeats: 1, highWinSeats: [], seats: [{ name: "华鑫证券有限责任公司上海分公司", net: 5e7, stats: null, stocks: [{ symbol: "600000", name: "浦发银行", net: 5e7 }] }] };
    const hotMoney = view.hotMoneyFragment({ content, chartUrl: null });
    assert.match(hotMoney, /^<div class="card"><div class="tg"><b>🐯 今日游资动向/);
    assert.doesNotMatch(hotMoney, /<details>|<img /);
});

test("推送消息：收盘为每只一行概况，龙虎榜更新附游资要点；都带打开网页的按钮", () => {
    const close = view.closeMessage({ reports: [report("300308", "中际旭创")], date: "2026-10-28" });
    assert.match(close, /^<b>📊 每日收盘总结｜2026-10-28<\/b>\n<a [^>]+><b>中际旭创<\/b><\/a> 12\.34 \+1\.50%　<b>观望<\/b>\n<i>/);
    const hotMoney = { seats: [{ name: "国泰君安证券股份有限公司上海江苏路证券营业部", net: 1.23e8, stats: { times: 85, riseProbability: 62.4 } }], highWinSeats: [{}, {}] };
    assert.match(view.longhuUpdatedMessage({ date: "2026-10-28", hotMoney }), /已更新｜2026-10-28<\/b>\n高胜率游资出手2家｜净买入第一：🏆国泰君安证券上海江苏路 \+1\.23亿\n/);
    assert.doesNotMatch(view.longhuUpdatedMessage({ date: "2026-10-28", hotMoney: { seats: [], highWinSeats: [] } }), /净买入第一/);
    assert.deepEqual(view.dailyPageButton("https://x/p"), { inline_keyboard: [[{ text: "📄 打开今日总结", url: "https://x/p" }]] });
});

test("龙虎榜与游资写入共用目录：图表失败时只写明细", async () => {
    const board = [{ symbol: "600000", name: "沪股", changePct: 10, netAmount: 1e8, reason: "涨幅偏离" }];
    await dailyPage.publishLonghu({ date: "2026-10-26", board, botUsername: "bot", render: () => Buffer.from("png") });
    assert.match(read(`s/${sharedToken("2026-10-26")}/longhu.html`), /<img src="http:\/\/pages.test\/s\/[0-9a-f]{32}\/longhu.png"/);
    await dailyPage.publishHotMoney({ date: "2026-10-26", content: { date: "2026-10-26", totalSeats: 0, seats: [], highWinSeats: [] }, render: () => { throw new Error("不应画图"); } });
    assert.doesNotMatch(read(`s/${sharedToken("2026-10-26")}/hot-money.html`), /<img /);
    await dailyPage.publishIntraday("2026-10-26", []);
    assert.match(read(`s/${sharedToken("2026-10-26")}/intraday.html`), /今日没有盘中异动推送/);
});
