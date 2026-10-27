const fs = require("node:fs");
const { GlobalFonts } = require("@napi-rs/canvas");

// 中文图表字体。Docker镜像安装了文泉驿微米黑（fonts-wqy-microhei），按文件路径显式注册，
// 不依赖系统字体自动扫描；macOS 本地运行时使用系统自带的冬青黑体/黑体
const FONT_FILES = [
    { path: "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", family: "WenQuanYi Micro Hei" }
];
const PREFERRED_FAMILIES = [
    "WenQuanYi Micro Hei",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "PingFang SC",
    "Hiragino Sans GB",
    "Heiti SC",
    "Heiti TC",
    "Microsoft YaHei"
];

let cached;

function registerKnownFontFiles() {
    for (const { path, family } of FONT_FILES) {
        if (fs.existsSync(path)) GlobalFonts.registerFromPath(path, family);
    }
}

// 找不到任何中文字体时抛错，调用方应退回文字消息
function cjkFontFamily() {
    if (cached) return cached;
    registerKnownFontFiles();
    const installed = new Set(GlobalFonts.families.map(item => item.family));
    cached = PREFERRED_FAMILIES.find(family => installed.has(family));
    if (!cached) throw new Error("未找到可用的中文字体，无法生成中文图表");
    return cached;
}

function font(size, weight = "normal") {
    return `${weight} ${size}px "${cjkFontFamily()}"`;
}

module.exports = { cjkFontFamily, font };
