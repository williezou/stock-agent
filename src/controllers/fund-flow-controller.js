const { config } = require("../config");
const telegram = require("../gateways/telegram");
const { createHttpClient, formatError, requestWithRetry } = require("../lib/http");
const { createFundFlowService } = require("../models/market/fund-flow");
const { isTradingDay } = require("../models/market/trading-calendar");
const { FundFlowMonitor } = require("../services/fund-flow-monitor");
const { generateFundFlowChart } = require("../views/charts/fund-flow-chart");
const { formatFundFlowAlert, formatFundFlowCaption, fundFlowKeyboard } = require("../views/fund-flow-view");

// 资金异动提醒控制器：按配置的时间段（FUND_FLOW_WINDOWS）各建一个监控实例，调度器每轮依次执行
function createMonitors(fundFlowConfig = config.fundFlow) {
    return FundFlowMonitor.parseWindows(fundFlowConfig.windows).map(window => new FundFlowMonitor({
        ...window,
        pollMinutes: fundFlowConfig.pollMinutes,
        minAmount: fundFlowConfig.minAmount,
        minRatio: fundFlowConfig.minRatio
    }));
}

// 推送内容：优先发图表（图片只上传一次，之后的订阅者引用 file_id），图片下方的股票按钮按各自自选股标 ⭐；
// 图表生成失败时退回文字版，保证不漏推。caption/text/keyboard/filePrefix 默认为资金异动，量价异动传入自己的格式
function prepareDelivery(content, {
    render,
    sendPhoto,
    sendMessage,
    caption = formatFundFlowCaption,
    text = formatFundFlowAlert,
    keyboard = fundFlowKeyboard,
    filePrefix = "fund-flow"
}) {
    let png = null;
    try {
        png = render(content);
    } catch (error) {
        console.error(`⚠️ ${content.label}异动图表生成失败，改发文字：${formatError(error)}`);
    }
    let fileId = null;
    return async (chatId, watchSymbols) => {
        const personal = { ...content, watchSymbols };
        if (!png) return sendMessage(chatId, text(personal));
        const message = await sendPhoto(chatId, fileId || png, caption(personal), `${filePrefix}-${content.time.replace(":", "")}.png`, {
            replyMarkup: keyboard(personal)
        });
        fileId = fileId || telegram.largestPhotoFileId(message);
    };
}

let defaults;
function getDefaults() {
    if (!defaults) {
        const httpClient = createHttpClient();
        defaults = {
            monitors: createMonitors(),
            fundFlow: createFundFlowService({ httpClient, requestWithRetry }),
            isTradingDay: now => isTradingDay({ httpClient, requestWithRetry, now })
        };
    }
    return defaults;
}

// 时间段不重叠时同一时刻只有一个实例在工作；重叠时各自独立拉取与推送
async function runFundFlowTick(store, now = new Date(), services = {}) {
    const { monitors, fundFlow, isTradingDay: checkTradingDay } = { ...getDefaults(), ...services };
    const active = monitors.filter(monitor => monitor.isActive(now));
    if (!active.length) return { action: "outside-window" };
    const sendMessage = services.sendMessage || telegram.sendMessage;
    const senders = {
        render: services.renderChart || generateFundFlowChart,
        sendPhoto: services.sendPhoto || telegram.sendPhoto,
        sendMessage
    };
    const deps = {
        fundFlow,
        isTradingDay: checkTradingDay,
        listSubscribers: () => store.listFundFlowSubscribers(),
        listWatchSymbols: async chatId => new Set((await store.list(chatId)).map(target => target.symbol)),
        prepare: content => prepareDelivery(content, senders),
        isBotBlocked: telegram.isBotBlockedError,
        deactivateSubscriber: chatId => store.deactivateSubscriber(chatId),
        alertContext: {
            notify: sendMessage,
            adminChatId: services.adminChatId ?? config.telegram.adminChatId,
            alerted: services.alerted || store.adminAlerts
        },
        // 监控状态与推送记录存库（保留7天）
        ...(typeof store.getFundFlowState === "function" && {
            loadState: (date, label) => store.getFundFlowState(date, label),
            saveState: (date, label, state) => store.saveFundFlowState(date, label, state),
            recordAlert: (date, label, content) => store.saveFundFlowAlert(date, label, content)
        })
    };
    const outcomes = [];
    for (const monitor of active) outcomes.push(await monitor.tick(now, deps));
    return outcomes.find(outcome => outcome.action === "processed") || outcomes.find(outcome => outcome.action === "fetch-failed") || outcomes[0];
}

module.exports = { createMonitors, prepareDelivery, runFundFlowTick };
