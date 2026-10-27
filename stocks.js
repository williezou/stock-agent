const DEFAULT_TARGETS = [
    {
        symbol: "600887",
        name: "伊利股份",
        exchangeCode: "600887.SH",
        quoteUrl: "https://quote.eastmoney.com/sh600887.html",
        keywords: ["三季报", "季报", "回购", "资产减值", "利润", "公告"]
    },
    {
        symbol: "002380",
        name: "科远智慧",
        exchangeCode: "002380.SZ",
        quoteUrl: "https://quote.eastmoney.com/sz002380.html",
        keywords: ["工业AI", "人工智能", "机器人", "三季报", "季报", "订单", "公告"]
    }
];

function normalizeSymbol(input) {
    const match = String(input || "").trim().toUpperCase().match(/^(?:SH|SZ)?(\d{6})(?:\.(?:SH|SZ))?$/);
    if (!match) return null;
    const symbol = match[1];
    return /^[036]\d{5}$/.test(symbol) ? symbol : null;
}

function exchangeForSymbol(symbol) {
    return String(symbol).startsWith("6") ? "SH" : "SZ";
}

function buildTarget(symbol, name, keywords) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) throw new Error("仅支持沪深A股六位代码（0、3、6开头）");
    const exchange = exchangeForSymbol(normalized);
    const stockName = String(name || normalized).trim();
    return {
        symbol: normalized,
        name: stockName,
        exchangeCode: `${normalized}.${exchange}`,
        quoteUrl: `https://quote.eastmoney.com/${exchange.toLowerCase()}${normalized}.html`,
        keywords: Array.isArray(keywords) && keywords.length
            ? keywords
            : [stockName, "公告", "业绩", "季报", "回购", "订单"]
    };
}

module.exports = { DEFAULT_TARGETS, buildTarget, exchangeForSymbol, normalizeSymbol };
