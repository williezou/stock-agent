// Telegram 对消息与图片说明的长度限制按“解析HTML实体后的可见文字”计算，标签与链接地址不计入
function visibleLength(html) {
    return String(html || "")
        .replace(/<[^>]*>/g, "")
        .replace(/&(?:lt|gt|amp|quot|#39);/g, "_")
        .length;
}

// Telegram 单条消息最多识别100个格式实体（加粗、链接、代码等），超出部分会被静默忽略
const MAX_ENTITIES = 100;

function entityCount(html) {
    return (String(html || "").match(/<(?:a|b|i|u|s|code|pre|tg-spoiler|blockquote)[\s>]/g) || []).length;
}

module.exports = { MAX_ENTITIES, entityCount, visibleLength };
