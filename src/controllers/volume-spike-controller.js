const { config } = require("../config");
const telegram = require("../gateways/telegram");
const { createHttpClient, requestWithRetry } = require("../lib/http");
const { createMarketSnapshotService } = require("../models/market/market-snapshot");
const { isTradingDay } = require("../models/market/trading-calendar");
const { FundFlowMonitor } = require("../services/fund-flow-monitor");
const { VolumeSpikeMonitor } = require("../services/volume-spike-monitor");
const { formatVolumeSpikeAlert } = require("../views/volume-spike-view");

// 量价异动提醒控制器：按配置的时间段（VOLUME_SPIKE_WINDOWS）各建一个监控实例；接收者为 /spike 开启的用户
function createVolumeSpikeMonitors(spikeConfig = config.volumeSpike) {
    return FundFlowMonitor.parseWindows(spikeConfig.windows).map(window => new VolumeSpikeMonitor({
        ...window,
        lookbackMinutes: spikeConfig.lookbackMinutes,
        pushMinutes: spikeConfig.pushMinutes,
        minAmount: spikeConfig.minAmount,
        minChangePct: spikeConfig.minChangePct
    }));
}

let defaults;
function getDefaults() {
    if (!defaults) {
        const httpClient = createHttpClient();
        defaults = {
            monitors: createVolumeSpikeMonitors(),
            snapshot: createMarketSnapshotService({ httpClient, requestWithRetry }),
            isTradingDay: now => isTradingDay({ httpClient, requestWithRetry, now })
        };
    }
    return defaults;
}

async function runVolumeSpikeTick(store, now = new Date(), services = {}) {
    const { monitors, snapshot, isTradingDay: checkTradingDay } = { ...getDefaults(), ...services };
    const active = monitors.filter(monitor => monitor.isActive(now));
    if (!active.length) return { action: "outside-window" };
    const sendMessage = services.sendMessage || telegram.sendMessage;
    const deps = {
        snapshot,
        isTradingDay: checkTradingDay,
        listSubscribers: () => store.listVolumeSpikeSubscribers(),
        listWatchSymbols: async chatId => new Set((await store.list(chatId)).map(target => target.symbol)),
        // 纯文字推送，按各自自选股标 ⭐
        prepare: content => async (chatId, watchSymbols) => sendMessage(chatId, formatVolumeSpikeAlert({ ...content, watchSymbols })),
        isBotBlocked: telegram.isBotBlockedError,
        deactivateSubscriber: chatId => store.deactivateSubscriber(chatId),
        alertContext: {
            notify: sendMessage,
            adminChatId: services.adminChatId ?? config.telegram.adminChatId,
            alerted: services.alerted || store.adminAlerts
        },
        // 已推送股票与推送记录存库（与资金异动共用表，保留7天）
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

module.exports = { createVolumeSpikeMonitors, runVolumeSpikeTick };
