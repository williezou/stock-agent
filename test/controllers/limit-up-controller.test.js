const test = require("node:test");
const assert = require("node:assert/strict");
const { latestCatalyst, runLimitUpTick } = require("../../src/controllers/limit-up-controller");
const { clockText, parsePool } = require("../../src/models/market/limit-up");
const { generateLimitUpChart } = require("../../src/views/charts/limit-up-chart");
const { formatLimitUpCaption, formatLimitUpText, limitUpKeyboard, summarizeLimitUp } = require("../../src/views/limit-up-view");
const { limitUpFragment } = require("../../src/views/daily-page-view");
const { QuoteApp } = require("../../src/views/quote-app");
const { visibleLength } = require("../../src/lib/telegram-text");

const at = hhmm => {
    const [hour, minute] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(2026, 9, 29, hour - 8, minute));
};

const up = (symbol, name, boards, sealAmount, extra = {}) => ({
    symbol, name, boards, sealAmount, changePct: 10, industry: "通用设备", firstTime: "09:25", lastTime: "09:25", breaks: 0, ...extra
});

const POOLS = {
    date: "2026-10-29",
    dataDate: "2026-10-29",
    limitUp: [
        up("002708", "光洋股份", 4, 8.5e6, { industry: "汽车零部", breaks: 17 }),
        up("001219", "青岛食品", 4, 1.65e8, { industry: "休闲食品" }),
        up("601956", "东贝集团", 3, 1.83e8),
        up("002862", "实丰文化", 2, 4.06e8, { industry: "文娱用品" }),
        up("600261", "阳光照明", 1, 2.12e8, { industry: "照明设备", firstTime: "09:32" }),
        up("603703", "盛洋科技", 1, 1.56e8)
    ],
    limitDown: [{ symbol: "600771", name: "广誉远", industry: "中药", days: 1, opens: 10, changePct: -10 }],
    broken: [
        { symbol: "003011", name: "海象新材", industry: "家居用品", firstTime: "09:30", breaks: 1, changePct: 1.41 },
        { symbol: "605118", name: "力鼎光电", industry: "计算机设", firstTime: "09:30", breaks: 4, changePct: 6.39 }
    ],
    yesterday: [{ changePct: 3 }, { changePct: -1 }, { changePct: 1 }]
};
const CONTENT = {
    ...POOLS,
    catalysts: { "001219": { title: "青岛食品控股股东拟转让股权", url: "https://finance.eastmoney.com/a/1.html", date: "2026-10-28" } }
};

test("涨停池解析：价格单位为厘、时间补零；接口异常时报错", () => {
    const pool = parsePool("limitUp", {
        rc: 0,
        data: { qdate: 20261029, pool: [{ c: "001219", n: "青 岛 食 品", p: 18130, zdp: 10.01, lbc: 4, fbt: 92500, lbt: 150000, fund: 165299295, zbc: 0, hybk: "休闲食品", zttj: { days: 4, ct: 4 } }] }
    });
    assert.equal(pool.date, "20261029");
    assert.deepEqual(pool.rows[0], {
        symbol: "001219", name: "青岛食品", price: 18.13, changePct: 10.01, amount: undefined, turnover: undefined, floatCap: undefined, industry: "休闲食品",
        boards: 4, firstTime: "09:25", lastTime: "15:00", sealAmount: 165299295, breaks: 0, stat: { days: 4, count: 4 }
    });
    assert.equal(clockText(93003), "09:30");
    assert.throws(() => parsePool("limitDown", { rc: 102 }), /rc=102/);
});

test("复盘统计：封板率=涨停/(涨停+炸板)，昨日涨停今日平均与上涨家数；梯队按连板数分层、层内按封单排序", () => {
    const summary = summarizeLimitUp(POOLS);
    assert.equal(summary.sealRate, 6 / 8);
    assert.equal(summary.yesterdayAvg, 1);
    assert.equal(summary.yesterdayUp, 2);
    assert.deepEqual(summary.ladder.map(level => [level.boards, level.stocks.map(stock => stock.name)]), [
        [4, ["青岛食品", "光洋股份"]],
        [3, ["东贝集团"]],
        [2, ["实丰文化"]]
    ]);
    assert.deepEqual(summary.firstBoard.map(stock => stock.name), ["阳光照明", "盛洋科技"]);
    assert.deepEqual(summary.industries[0], { industry: "通用设备", count: 2 });
});

test("推送：说明含概况与梯队，按钮为连板股（标几板、打开所选App）加网页按钮；文字版附相关公告/新闻", () => {
    const caption = formatLimitUpCaption(CONTENT, { app: QuoteApp.get("xueqiu") });
    assert.match(caption, /^<b>🔥 涨停复盘｜10-29<\/b>\n涨停6 跌停1 炸板2｜封板率75%\n昨日涨停今日平均\+1\.00%（上涨2\/3只）\n连板梯队：4板2只 3板1只 2板1只｜最高4板：青岛食品、光洋股份/);
    assert.match(caption, /点下方按钮打开雪球。\/limit off 关闭/);
    assert.ok(visibleLength(caption) <= 1024);

    const keyboard = limitUpKeyboard(CONTENT, { app: QuoteApp.get("xueqiu"), pageUrl: "https://pages.test/p" }).inline_keyboard;
    assert.deepEqual(keyboard[0].map(button => button.text), ["4板青岛食品", "4板光洋股份", "3板东贝集团"]);
    assert.equal(keyboard[0][0].url, "https://xueqiu.com/S/SZ001219");
    assert.deepEqual(keyboard.at(-1), [{ text: "📄 打开今日总结", url: "https://pages.test/p" }]);
    assert.equal(limitUpKeyboard(CONTENT).inline_keyboard.flat().some(button => button.text.includes("今日总结")), false, "网页写入失败时不带网页按钮");

    const text = formatLimitUpText(CONTENT);
    assert.match(text, /<b>4连板（2只）<\/b>\n<a href="https:\/\/mlink\.eastmoney\.com[^"]+">青岛食品<\/a> 休闲食品 首封09:25 封单1\.65亿\n　📰 2026-10-28｜<a href="https:\/\/finance\.eastmoney\.com\/a\/1\.html">青岛食品控股股东拟转让股权<\/a>/);
    assert.match(text, /光洋股份<\/a> 汽车零部 首封09:25 炸板17次 封单850万/);
    assert.equal(generateLimitUpChart(CONTENT).subarray(1, 4).toString(), "PNG");
});

test("相关公告/新闻：只要标题提到该股、不是例行播报、7天内的最新一条", () => {
    const stock = { symbol: "001219", name: "青岛食品" };
    const pick = (news, announcements = []) => latestCatalyst(stock, { news, announcements }, "2026-10-29");
    assert.equal(pick([
        { title: "10月29日A股早盘：科创50跌超4%", time: "2026-10-29 11:00:00" },
        { title: "青岛食品涨停走出4连板", time: "2026-10-29 10:00:00" },
        { title: "青岛食品:股票交易异常波动公告", date: "2026-10-29" },
        { title: "青岛食品控股股东拟转让股权", time: "2026-10-28 20:00:00", url: "u" }
    ]).title, "青岛食品控股股东拟转让股权");
    assert.equal(pick([{ title: "青岛食品三季报", time: "2026-10-10 08:00:00" }]), null, "超过7天");
    assert.equal(pick([], [{ title: "青岛食品:关于股东权益变动的提示性公告", date: "2026-10-29" }]).title, "青岛食品:关于股东权益变动的提示性公告");
});

test("网页片段：概况+图表，各连板层级表格附相关公告/新闻，首板按行业分组，跌停与炸板收起", () => {
    const html = limitUpFragment({ content: CONTENT, chartUrl: "https://pages.test/s/x/limit-up.png", app: QuoteApp.get("cmschina") });
    assert.match(html, /涨停6 跌停1 炸板2｜封板率75%<br>/);
    assert.match(html, /<img src="https:\/\/pages\.test\/s\/x\/limit-up\.png"/);
    assert.match(html, /<b>4连板（2只）<\/b>/);
    assert.match(html, /<tr class="sub"><td colspan="5">📰 2026-10-28｜<a href="https:\/\/finance\.eastmoney\.com\/a\/1\.html">/);
    assert.match(html, /weixin\.newone\.com\.cn/, "名称打开所选App");
    assert.match(html, /<b>首板 2只（按行业）<\/b>/);
    assert.match(html, /<details><summary>跌停 1只<\/summary>/);
    assert.match(html, /<details><summary>炸板 2只<\/summary>/);
});

function setup({ dataDate = "2026-10-29", buildError = null } = {}) {
    const calls = { photos: [], texts: [], completed: [], builds: 0 };
    const subscribers = [{ chat_id: "100" }, { chat_id: "200", quote_app: "xueqiu" }];
    const store = {
        async listDueSubscribers(job, date, max, options) {
            assert.equal(job, "limit-up");
            assert.deepEqual(options, { audience: "limitUp" });
            return subscribers.filter(s => !calls.completed.some(c => c.chatId === s.chat_id));
        },
        async claimDeliveryRun() { return 1; },
        async completeDeliveryRun(_job, chatId, _date, status, message) { calls.completed.push({ chatId, status, message }); },
        async failDeliveryRun() {},
        async deactivateSubscriber() {},
        async getSubscriber(chatId) { return subscribers.find(s => s.chat_id === chatId); }
    };
    const services = {
        cache: { date: "", content: null, published: false },
        dailyPage: null,
        limitUp: {
            async getDailyPools(dateStr) {
                calls.builds++;
                if (buildError) throw buildError;
                return { ...POOLS, date: dateStr, dataDate };
            }
        },
        news: {
            async searchNews() { return []; },
            async getAnnouncements(symbol) { return symbol === "001219" ? [{ title: "青岛食品:控股股东筹划股权转让", date: "2026-10-28", url: "u" }] : []; }
        },
        renderChart: () => Buffer.from("png"),
        async sendPhoto(chatId, photo, caption, filename, options) {
            calls.photos.push({ chatId, uploaded: Buffer.isBuffer(photo), caption, keyboard: options.replyMarkup });
            return { photo: [{ file_id: "f" }] };
        },
        async sendMessage(chatId, text) { calls.texts.push({ chatId, text }); },
        adminChatId: "admin",
        alerted: new Set()
    };
    return { calls, services, store };
}

test("涨停复盘调度：15:05起推送；图片只上传一次，按钮按各自选择的App；内容只生成一次并附连板股相关公告", async () => {
    const early = setup();
    assert.deepEqual(await runLimitUpTick(early.store, at("15:04"), early.services), { action: "outside-window" });

    const { calls, services, store } = setup();
    const result = await runLimitUpTick(store, at("15:10"), services);
    assert.equal(result.action, "processed");
    assert.equal(result.delivered, 2);
    assert.deepEqual(calls.photos.map(p => [p.chatId, p.uploaded]), [["100", true], ["200", false]]);
    assert.match(calls.photos[0].keyboard.inline_keyboard[0][0].url, /mlink\.eastmoney\.com/);
    assert.equal(calls.photos[1].keyboard.inline_keyboard[0][0].url, "https://xueqiu.com/S/SZ001219");
    assert.equal(services.cache.content.catalysts["001219"].title, "青岛食品:控股股东筹划股权转让");
    await runLimitUpTick(store, at("15:20"), services);
    assert.equal(calls.builds, 1);
});

test("休市（接口数据日期不是当天）时全部记为跳过；生成失败到最后时段才提醒管理员", async () => {
    const holiday = setup({ dataDate: "2026-10-28" });
    assert.deepEqual(await runLimitUpTick(holiday.store, at("15:10"), holiday.services), { action: "skipped", reason: "休市" });
    assert.deepEqual(holiday.calls.completed.map(c => [c.chatId, c.status, c.message]), [["100", "skipped", "休市"], ["200", "skipped", "休市"]]);
    assert.equal(holiday.calls.photos.length, 0);

    const failing = setup({ buildError: new Error("ECONNRESET") });
    assert.deepEqual(await runLimitUpTick(failing.store, at("15:10"), failing.services), { action: "build-failed", final: false });
    assert.equal(failing.calls.completed.length, 0, "还有机会重试");
    assert.deepEqual(await runLimitUpTick(failing.store, at("16:30"), failing.services), { action: "build-failed", final: true });
    assert.match(failing.calls.texts.find(t => t.chatId === "admin").text, /涨停复盘生成失败/);
    assert.deepEqual(failing.calls.completed.map(c => c.status), ["skipped", "skipped"]);
});

test("每日总结网页：复盘写入网页一次，每人的按钮里带各自的入口页；写入失败时照常推送、不带网页按钮", async () => {
    const { calls, services, store } = setup();
    const page = { limitUp: 0, indexes: [] };
    services.dailyPage = {
        async publishLimitUp({ date, content }) { page.limitUp++; assert.equal(date, "2026-10-29"); assert.equal(content.limitUp.length, 6); },
        async publishIndex(subscriber, date) { page.indexes.push(subscriber.chat_id); return `https://pages.test/p/${subscriber.chat_id}/${date}`; }
    };
    await runLimitUpTick(store, at("15:10"), services);
    assert.equal(page.limitUp, 1);
    assert.deepEqual(page.indexes, ["100", "200"]);
    assert.deepEqual(calls.photos[1].keyboard.inline_keyboard.at(-1), [{ text: "📄 打开今日总结", url: "https://pages.test/p/200/2026-10-29" }]);

    const broken = setup();
    broken.services.dailyPage = { async publishLimitUp() { throw new Error("storage down"); } };
    assert.equal((await runLimitUpTick(broken.store, at("15:10"), broken.services)).delivered, 2);
    assert.equal(broken.calls.photos[0].keyboard.inline_keyboard.flat().some(button => button.text.includes("今日总结")), false);
});
