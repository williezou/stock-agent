// 行情App：推送与回复中股票名称链接打开哪个平台，由用户用 /app 选择（存在订阅者的 quote_app 字段）。
// Telegram 只允许 http(s)/tg 链接，各平台都用能唤起App的网页地址

// 东方财富：iOS 通用链接 mlink.eastmoney.com/h52n/*（其 apple-app-site-association 指向东方财富App）：已装App时点击直接进入个股页，
// 未装时打开中转页。id 参数为App内部地址，格式取自东方财富手机版行情页的“打开App”按钮（仅iOS写法）
const EASTMONEY_APP_LINK = "https://mlink.eastmoney.com/h52n/nlink.html?type=localurl&id=";

function eastmoneyMarket(symbol) {
    return symbol.startsWith("6") ? 1 : 0;
}

// 雪球的代码带交易所前缀：沪市6/9开头，北交所4/8/92开头，其余为深市
function xueqiuCode(symbol) {
    if (/^(?:4|8|92)/.test(symbol)) return `BJ${symbol}`;
    return `${/^[69]/.test(symbol) ? "SH" : "SZ"}${symbol}`;
}

// 招商证券：App个股页分享截图里的二维码地址。分享页在浏览器里打开后自动跳 cmschinaapp://stock/quote/stock?jsonParam=…
// （未安装时显示下载）。jsonParam 为 {"stock":[{"ZQSETCODE":市场,"ZQCODE":代码}],"index":0}，path 参数里再编码一次；
// 市场代码沪市1、深市0（取自600999、000001的分享二维码），北交所按同系惯例取2（未验证）
const CMS_SHARE_LINK = "https://weixin.newone.com.cn/app/share/index.html?path=stock/";

function cmsMarket(symbol) {
    if (/^(?:4|8|92)/.test(symbol)) return "2";
    return /^[69]/.test(symbol) ? "1" : "0";
}

function cmsStockUrl(symbol) {
    const jsonParam = JSON.stringify({ stock: [{ ZQSETCODE: cmsMarket(symbol), ZQCODE: symbol }], index: 0 });
    return `${CMS_SHARE_LINK}${encodeURIComponent(`quote/stock?jsonParam=${encodeURIComponent(jsonParam)}`)}`;
}

class QuoteApp {
    constructor({ key, label, aliases = [], stockUrl }) {
        this.key = key;
        this.label = label;
        this.aliases = aliases;
        this.buildUrl = stockUrl;
    }

    stockUrl(symbol) {
        return this.buildUrl(String(symbol));
    }

    static get all() {
        return APPS;
    }

    static get DEFAULT() {
        return APPS[0];
    }

    // 按 key 取；未设置或已下线的平台退回默认
    static get(key) {
        return APPS.find(app => app.key === key) || QuoteApp.DEFAULT;
    }

    static forSubscriber(subscriber) {
        return QuoteApp.get(subscriber && subscriber.quote_app);
    }

    // 所有用户共用的推送内容按App各生成一次：返回 app => render(app) 的缓存版本
    static memo(render) {
        const cache = new Map();
        return app => {
            const key = (app || QuoteApp.DEFAULT).key;
            if (!cache.has(key)) cache.set(key, render(QuoteApp.get(key)));
            return cache.get(key);
        };
    }

    // /app 参数：key、中文名或别名（不区分大小写），无法识别时返回null
    static find(input) {
        const text = String(input || "").trim().toLowerCase();
        return APPS.find(app => app.key === text || app.label === text || app.aliases.includes(text)) || null;
    }
}

const APPS = [
    new QuoteApp({
        key: "eastmoney",
        label: "东方财富",
        aliases: ["东财", "em"],
        stockUrl: symbol => `${EASTMONEY_APP_LINK}${encodeURIComponent(`eastmoney://page/stockpage?code=${symbol}&market=${eastmoneyMarket(symbol)}`)}`
    }),
    // 同花顺不提供：其分享链接与通用链接都只能打开手机网页或App首页，进不了App个股页（实测）
    // 雪球个股页（已装App时 iOS 可直接打开App）
    new QuoteApp({
        key: "xueqiu",
        label: "雪球",
        aliases: ["xq"],
        stockUrl: symbol => `https://xueqiu.com/S/${xueqiuCode(symbol)}`
    }),
    new QuoteApp({
        key: "cmschina",
        label: "招商证券",
        aliases: ["招商", "cms", "智远一户通"],
        stockUrl: cmsStockUrl
    })
];

module.exports = { QuoteApp };
