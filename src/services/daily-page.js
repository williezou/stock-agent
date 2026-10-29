const crypto = require("crypto");
const { config } = require("../config");
const { formatError } = require("../lib/http");
const { publicUrl, putObject } = require("../gateways/page-storage");
const { generateStockChart } = require("../views/charts/stock-charts");
const view = require("../views/daily-page-view");

// 每日总结网页：每个用户每天一个入口页，地址里的令牌由 DAILY_PAGE_SECRET 按用户与日期生成（别人猜不到，同一天重复写入地址不变）。
// 用户自己的内容（入口页、自选股收盘）放在 p/令牌/ 下；行情类内容所有用户共用，放在 s/日期/ 下，只写一次。
// 保留期由存储桶的生命周期规则控制（7天）
const HTML = "text/html; charset=utf-8";
const PNG = "image/png";
// 图片写入后不再变化，可以长时间缓存
const IMAGE_CACHE = "public, max-age=86400";

function pageToken(chatId, date) {
    return crypto.createHmac("sha256", config.dailyPage.secret).update(`${chatId}:${date}`).digest("hex").slice(0, 32);
}

const paths = {
    index: (chatId, date) => `p/${pageToken(chatId, date)}/index.html`,
    close: (chatId, date) => `p/${pageToken(chatId, date)}/close.html`,
    shared: (date, name) => `s/${date}/${name}`
};

function pageUrl(chatId, date) {
    return publicUrl(paths.index(chatId, date));
}

// 入口页按用户的推送开关列出各段；各段内容还没写入时显示预计时间
async function publishIndex(subscriber, date) {
    const chatId = subscriber.chat_id;
    const sections = [{ id: "close", title: "📊 自选股收盘", url: publicUrl(paths.close(chatId, date)), pending: "收盘报告约15:30后生成（自选股为空时没有）" }];
    if (subscriber.fund_flow_enabled !== false || subscriber.volume_spike_enabled !== false) {
        sections.push({ id: "intraday", title: "⚡ 盘中异动回顾", url: publicUrl(paths.shared(date, "intraday.html")), pending: "收盘后汇总" });
    }
    if (subscriber.longhu_enabled !== false) {
        sections.push(
            { id: "longhu", title: "🐉 龙虎榜", url: publicUrl(paths.shared(date, "longhu.html")), pending: "龙虎榜约18:00-20:30发布后更新" },
            { id: "hot-money", title: "🐯 游资动向", url: publicUrl(paths.shared(date, "hot-money.html")), pending: "龙虎榜发布后更新" }
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
    await putObject(paths.close(subscriber.chat_id, date), view.closeFragment({ reports, date, chartUrls }), { contentType: HTML });
    return publishIndex(subscriber, date);
}

async function publishIntraday(date, alerts) {
    await putObject(paths.shared(date, "intraday.html"), view.intradayFragment({ alerts }), { contentType: HTML });
}

async function publishLonghu({ date, board, botUsername, render }) {
    const chartUrl = await putChart(paths.shared(date, "longhu.png"), () => render({ date, board }));
    await putObject(paths.shared(date, "longhu.html"), view.longhuFragment({ date, board, botUsername, chartUrl }), { contentType: HTML });
}

async function publishHotMoney({ date, content, render }) {
    const chartUrl = content.seats.length || content.highWinSeats.length
        ? await putChart(paths.shared(date, "hot-money.png"), () => render(content))
        : null;
    await putObject(paths.shared(date, "hot-money.html"), view.hotMoneyFragment({ content, chartUrl }), { contentType: HTML });
}

const dailyPage = { pageUrl, publishClose, publishHotMoney, publishIndex, publishIntraday, publishLonghu };

// 控制器取用：测试注入 services.dailyPage；未配置时为 null，按原方式逐条推送
function resolveDailyPage(services = {}) {
    if (services.dailyPage !== undefined) return services.dailyPage;
    return config.dailyPage.enabled ? dailyPage : null;
}

module.exports = { dailyPage, pageToken, resolveDailyPage };
