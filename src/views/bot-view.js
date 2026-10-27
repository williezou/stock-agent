const { STOCK_LINK_LEGEND, StockLink } = require("./stock-link");

// 机器人的全部回复文案、Menu命令与键盘布局

// 注册到Telegram Menu的命令（/start不放入菜单，注册时手动输入）
const BOT_COMMANDS = [
    { command: "add", description: "添加每日追踪股票" },
    { command: "remove", description: "删除每日追踪股票" },
    { command: "list", description: "查看每日追踪列表" },
    { command: "longhu", description: "开启/关闭龙虎榜推送" },
    { command: "stop", description: "暂停每日推送" },
    { command: "cancel", description: "取消当前操作" }
];

// 旧版常驻按钮的文字；按钮键盘已由Menu命令取代，保留识别以兼容尚未刷新的聊天
const LEGACY_BUTTONS = {
    ADD: "➕ 添加股票",
    REMOVE: "➖ 删除股票",
    LIST: "📋 追踪列表"
};

const HELP_TEXT = "点击左下角 Menu 选择操作，或直接输入：\n/add 600519 添加股票\n/remove 600519 删除股票\n/list 查看追踪列表\n/longhu 开启/关闭每日龙虎榜推送";

const MESSAGES = {
    help: HELP_TEXT,
    unknownCommand: `未识别该指令。\n${HELP_TEXT}`,
    registered: `✅ 订阅已启用。你的自选股与其他用户完全独立。\n${HELP_TEXT}`,
    inviteRequired: "需要有效邀请码才能启用每日股票追踪。\n请输入：<code>/start 邀请码</code>",
    registrationClosed: "本机器人暂未开放注册，请联系机器人管理员。",
    subscribersFull: "当前订阅名额已满，请联系机器人管理员。",
    registerWithInvite: "请使用 <code>/start 邀请码</code> 完成注册。",
    registerFirst: "请先发送 /start 启用每日股票追踪。",
    stopped: "已暂停每日推送。你的自选股仍会保留，发送 /start 可随时恢复。",
    cancelled: "已取消当前操作。",
    emptyList: "当前没有每日追踪股票。",
    addPrompt: "请输入六位沪深A股代码，例如：<code>600519</code>\n发送 /cancel 可取消。",
    invalidAddCode: "代码格式不正确，仅支持0、3、6开头的六位沪深A股代码。请重新输入，或发送 /cancel。",
    nothingToRemove: "当前没有可删除的股票。",
    chooseToRemove: "请选择要删除的股票：",
    invalidRemoveCode: "代码格式不正确，删除命令示例：<code>/remove 600519</code>",
    removeCancelled: "已取消删除。",
    alreadyRemoved: "该股票已不在追踪列表中。",
    invalidSymbol: "股票代码无效。",
    unauthorizedCallback: "无权操作此机器人",
    operationFailed: "❌ 操作失败，请稍后重试。",
    seatPending: "正在生成席位表格，请稍候…",
    seatRecentlySent: "席位已发送，请查看上方消息",
    invalidLonghuArgument: "用法：<code>/longhu</code> 切换，<code>/longhu on</code> 开启，<code>/longhu off</code> 关闭。",
    webhookReady: "✅ 股票追踪菜单已启用，点击左下角 Menu 选择操作。",
    serviceStarted: "✅ 本机股票追踪服务已启动，点击左下角 Menu 选择操作。"
};

// 每次回复都移除旧的常驻按钮键盘，避免与Menu重复
function removeKeyboardMarkup() {
    return { remove_keyboard: true };
}

function addPromptMarkup() {
    return { force_reply: true, input_field_placeholder: "输入股票代码" };
}

function watchlistText(targets, maxStocks) {
    const lines = targets.map((target, index) =>
        `${index + 1}. ${StockLink.of(target).html()}`
    );
    return `<b>每日追踪列表（${targets.length}/${maxStocks}）</b>\n${lines.join("\n")}\n<i>${STOCK_LINK_LEGEND}</i>`;
}

function alreadyTrackedText(symbol, name) {
    return `${new StockLink(symbol, name).html()} 已在追踪列表中。`;
}

function watchlistFullText(maxStocks) {
    return `最多追踪${maxStocks}只股票，请先删除不需要的代码。`;
}

function addedText(symbol, name) {
    return `✅ 已添加 ${new StockLink(symbol, name).html()}，下个交易日将纳入收盘分析。`;
}

function removedText(symbol, removed) {
    const stock = new StockLink(symbol).html();
    return removed ? `✅ 已停止追踪 ${stock}。` : `未找到 ${stock}。`;
}

function longhuToggledText(enabled) {
    return enabled
        ? "✅ 已开启龙虎榜推送：交易日收盘后（约18:00-20:30）榜单发布完成即推送。发送 /longhu off 可关闭。"
        : "已关闭龙虎榜推送，自选股收盘报告不受影响。发送 /longhu on 可重新开启。";
}

function removeChoicesMarkup(targets) {
    const inlineKeyboard = targets.map(target => [{
        text: `删除 ${target.symbol} ${target.name}`,
        callback_data: `delete:${target.symbol}`
    }]);
    inlineKeyboard.push([{ text: "取消", callback_data: "delete_cancel" }]);
    return { inline_keyboard: inlineKeyboard };
}

function confirmRemoveText(symbol, name) {
    return `确认删除 ${new StockLink(symbol, name).html()}？`;
}

function confirmRemoveMarkup(symbol) {
    return {
        inline_keyboard: [[
            { text: "确认删除", callback_data: `delete_confirm:${symbol}` },
            { text: "取消", callback_data: "delete_cancel" }
        ]]
    };
}

module.exports = {
    BOT_COMMANDS,
    LEGACY_BUTTONS,
    MESSAGES,
    addPromptMarkup,
    addedText,
    alreadyTrackedText,
    confirmRemoveMarkup,
    confirmRemoveText,
    longhuToggledText,
    removeChoicesMarkup,
    removeKeyboardMarkup,
    removedText,
    watchlistFullText,
    watchlistText
};
