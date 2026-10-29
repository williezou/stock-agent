const crypto = require("crypto");
const { config } = require("../config");
const { formatError } = require("../lib/http");
const { publicUrl, putObject } = require("../gateways/page-storage");
const { generateStockChart } = require("../views/charts/stock-charts");
const { QuoteApp } = require("../views/quote-app");
const view = require("../views/daily-page-view");

// 每日总结网页：每个用户每天一个入口页，地址里的令牌由 DAILY_PAGE_SECRET 按用户与日期生成（别人猜不到，同一天重复写入地址不变）。
// 用户自己的内容（入口页、自选股收盘）放在 p/令牌/ 下；行情类内容所有用户共用，放在 s/按日期生成的令牌/ 下，只写一次
// （共用目录也用令牌，不拿到链接就猜不到任何文件地址，存储桶又禁止列目录，避免被人刷流量）。
// 共用片段里有股票名称链接，按行情App各写一份（*.<app>.html），入口页引用用户所选App的那份；图片不分App。
// 保留期由存储桶的生命周期规则控制（7天）
const HTML = "text/html; charset=utf-8";
const PNG = "image/png";
// 图片写入后不再变化，可以长时间缓存
const IMAGE_CACHE = "public, max-age=86400";

function token(input) {
    return crypto.createHmac("sha256", config.dailyPage.secret).update(input).digest("hex").slice(0, 32);
}

function pageToken(chatId, date) {
    return token(`${chatId}:${date}`);
}

function sharedToken(date) {
    return token(`shared:${date}`);
}

const paths = {
    index: (chatId, date) => `p/${pageToken(chatId, date)}/index.html`,
    close: (chatId, date) => `p/${pageToken(chatId, date)}/close.html`,
    shared: (date, name) => `s/${sharedToken(date)}/${name}`,
    sharedHtml: (date, name, app) => `s/${sharedToken(date)}/${name}.${app.key}.html`
};

// 共用片段按App各写一份
async function putSharedHtml(date, name, render) {
    for (const app of QuoteApp.all) await putObject(paths.sharedHtml(date, name, app), render(app), { contentType: HTML });
}

function pageUrl(chatId, date) {
    return publicUrl(paths.index(chatId, date));
}

// 入口页按用户的推送开关列出各段；各段内容还没写入时显示预计时间
async function publishIndex(subscriber, date) {
    const chatId = subscriber.chat_id;
    const app = QuoteApp.forSubscriber(subscriber);
    const sections = [{ id: "close", title: "📊 自选股收盘", url: publicUrl(paths.close(chatId, date)), pending: "收盘报告约15:30后生成（自选股为空时没有）" }];
    if (subscriber.limit_up_enabled !== false) {
        sections.push({ id: "limit-up", title: "🔥 涨停复盘", url: publicUrl(paths.sharedHtml(date, "limit-up", app)), pending: "收盘后约15:10生成" });
    }
    if (subscriber.fund_flow_enabled !== false || subscriber.volume_spike_enabled !== false) {
        sections.push({ id: "intraday", title: "⚡ 盘中异动回顾", url: publicUrl(paths.sharedHtml(date, "intraday", app)), pending: "收盘后汇总" });
    }
    if (subscriber.longhu_enabled !== false) {
        sections.push(
            { id: "longhu", title: "🐉 龙虎榜", url: publicUrl(paths.sharedHtml(date, "longhu", app)), pending: "龙虎榜约18:00-20:30发布后更新" },
            { id: "hot-money", title: "🐯 游资动向", url: publicUrl(paths.sharedHtml(date, "hot-money", app)), pending: "龙虎榜发布后更新" }
        );
    }
    await putObject(paths.index(chatId, date), view.dailyPageHtml({ date, sections }), { contentType: HTML });
    return pageUrl(chatId, date);
}

// 图表生成失败时该段只有文字
async function putChart(name, render) {
    let png;
    try {
        png = render();
    } catch (error) {
        console.error(`⚠️ 每日总结图表${name}生成失败：${formatError(error)}`);
        return null;
    }
    return putObject(name, png, { contentType: PNG, cacheControl: IMAGE_CACHE });
}

// 个股K线图所有用户共用：同一天同一只股票只写一次（进程内记录，重启后重写一次也无妨）
const writtenCharts = new Map();

async function stockChartUrl(report, date) {
    const name = paths.shared(date, `k-${report.meta.symbol}.png`);
    if (!writtenCharts.has(name)) writtenCharts.set(name, await putChart(name, () => generateStockChart(report)));
    return writtenCharts.get(name);
}

async function publishClose(subscriber, { reports, date }) {
    const chartUrls = new Map();
    for (const report of reports) chartUrls.set(report.meta.symbol, await stockChartUrl(report, date));
    await putObject(paths.close(subscriber.chat_id, date), view.closeFragment({ reports, date, chartUrls, app: QuoteApp.forSubscriber(subscriber) }), { contentType: HTML });
    return publishIndex(subscriber, date);
}

async function publishIntraday(date, alerts) {
    await putSharedHtml(date, "intraday", app => view.intradayFragment({ alerts, app }));
}

async function publishLonghu({ date, board, botUsername, render }) {
    const chartUrl = await putChart(paths.shared(date, "longhu.png"), () => render({ date, board }));
    await putSharedHtml(date, "longhu", app => view.longhuFragment({ date, board, botUsername, chartUrl, app }));
}

async function publishHotMoney({ date, content, render }) {
    const chartUrl = content.seats.length || content.highWinSeats.length
        ? await putChart(paths.shared(date, "hot-money.png"), () => render(content))
        : null;
    await putSharedHtml(date, "hot-money", app => view.hotMoneyFragment({ content, chartUrl, app }));
}

async function publishLimitUp({ date, content, render }) {
    const chartUrl = content.limitUp.length ? await putChart(paths.shared(date, "limit-up.png"), () => render(content)) : null;
    await putSharedHtml(date, "limit-up", app => view.limitUpFragment({ content, chartUrl, app }));
}

// A股扫描：所有用户共用的独立网页（按App各一份，不进入每人的入口页）；返回 app => 网页地址。
// 个股K线图与收盘报告同名共用（同一天同一只股票的日K相同）
async function publishScan({ date, now, picksByStyle, longhiData }) {
    const chartUrls = new Map();
    for (const style of Object.keys(picksByStyle)) {
        for (const { report } of picksByStyle[style]) {
            if (report && !chartUrls.has(report.meta.symbol)) chartUrls.set(report.meta.symbol, await stockChartUrl(report, date));
        }
    }
    await putSharedHtml(date, "scan", app => view.scanPageHtml({ date, now, picksByStyle, longhiData, chartUrls, app }));
    return app => publicUrl(paths.sharedHtml(date, "scan", app));
}

const dailyPage = { pageUrl, publishClose, publishHotMoney, publishIndex, publishIntraday, publishLimitUp, publishLonghu, publishScan };

// 控制器取用：测试注入 services.dailyPage；未配置时为 null，按原方式逐条推送
function resolveDailyPage(services = {}) {
    if (services.dailyPage !== undefined) return services.dailyPage;
    return config.dailyPage.enabled ? dailyPage : null;
}

module.exports = { dailyPage, pageToken, resolveDailyPage, sharedToken };
