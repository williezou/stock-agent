// 跨层共享的常量：业务模型、视图与网关都可引用，避免视图依赖服务层或网关

// 扫描的四种交易风格（顺序即展示顺序与去重优先级）
const STYLE_ORDER = ["intraday", "short", "swing", "mid"];
const STYLE_LABELS = {
    intraday: "日内",
    short: "短线",
    swing: "波段",
    mid: "中线"
};

// Telegram webhook回调路径（HTTP服务路由与setWebhook注册地址共用）
const WEBHOOK_PATH = "/telegram/webhook";

// Telegram消息长度上限
const TELEGRAM_TEXT_LIMIT = 4096;
const PHOTO_CAPTION_LIMIT = 1024;

module.exports = { PHOTO_CAPTION_LIMIT, STYLE_LABELS, STYLE_ORDER, TELEGRAM_TEXT_LIMIT, WEBHOOK_PATH };
