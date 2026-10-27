const { STYLE_ORDER } = require("../constants");

// 选股：按日内/短线/波段/中线四种风格对当日快照打分，并过滤、去重出每类入选股票

const MID_MAX_CHANGE_PCT = 0.04; // 中线：更稳健，排除过度拉升（4%+）
const MID_MAX_VOL = 0.03; // 中线：最大波动
const INTRADAY_MIN_MOVE = 0.04; // 日内：高波动
const SHORT_MIN_RISE = 0.02; // 短线最小涨幅
const SHORT_MAX_RISE = 0.06; // 短线最大涨幅
const SWING_MIN_RISE = 0.0; // 波段最小涨幅
const SWING_MAX_RISE = 0.03; // 波段最大涨幅
const SWING_MAX_VOL = 0.05; // 波段最大波动
const GAP_THRESHOLD = 0.03;

// 放宽版阈值（兜底）
const RELAXED = {
    intradayMinMove: 0.02,
    shortMinRise: 0.01,
    shortMaxRise: 0.08,
    swingMinRise: -0.01,
    swingMaxRise: 0.05,
    swingMaxVol: 0.06,
    midMaxChange: 0.03,
    midMaxVol: 0.03,
    midMinChange: -0.02
};

function computeFeatures(stock) {
    const gap = stock.prevClose > 0 ? (stock.price - stock.prevClose) / stock.prevClose : 0;
    const changePct = (stock.changePct || 0) / 100;
    const volume = stock.volume || 0;
    const volumeScore = Math.log10(volume + 1); // 粗略流动性
    const volatility = Math.abs(changePct);
    const trendUp = stock.price > stock.prevClose;
    return { gap, changePct, volume, volumeScore, volatility, trendUp };
}

function scoreByStyle(style, features, news, announcements) {
    const hasCatalyst = (news && news.length > 0) || (announcements && announcements.length > 0);
    let score = 0;

    if (style === "intraday") {
        if (features.volatility < INTRADAY_MIN_MOVE) {
            return null;
        }
        score += Math.min(features.volatility * 120, 6);
        score += Math.min(features.volumeScore, 4);
        if (Math.abs(features.gap) >= GAP_THRESHOLD) score += 2;
        if (hasCatalyst) score += 2;
    } else if (style === "short") {
        if (features.changePct < SHORT_MIN_RISE || features.changePct > SHORT_MAX_RISE) {
            return null;
        }
        score += Math.min(Math.max(features.changePct, 0) * 120, 6);
        score += Math.min(features.volumeScore, 3);
        if (features.trendUp) score += 1;
        if (hasCatalyst) score += 2;
    } else if (style === "swing") {
        if (
            features.volatility > SWING_MAX_VOL ||
            features.changePct < SWING_MIN_RISE ||
            features.changePct > SWING_MAX_RISE
        ) {
            return null;
        }
        score += Math.min(Math.max(features.changePct, 0) * 80, 4);
        score += Math.min(features.volumeScore, 3);
        if (hasCatalyst) score += 1;
    } else if (style === "mid") {
        if (features.changePct > MID_MAX_CHANGE_PCT || features.volatility > MID_MAX_VOL) {
            return null;
        }
        score += Math.min(Math.max(features.changePct, 0) * 30, 2.0);
        score += Math.min(features.volumeScore, 3.0);
        if (hasCatalyst) score += 1;
        if (features.changePct < -0.01) score -= 1.5;
    }

    return score;
}

function scoreByStyleRelaxed(style, features, news, announcements) {
    const hasCatalyst = (news && news.length > 0) || (announcements && announcements.length > 0);
    let score = 0;

    if (style === "intraday") {
        if (features.volatility < RELAXED.intradayMinMove) return null;
        score += Math.min(features.volatility * 120, 6);
        score += Math.min(features.volumeScore, 4);
        if (Math.abs(features.gap) >= GAP_THRESHOLD) score += 2;
        if (hasCatalyst) score += 2;
    } else if (style === "short") {
        if (features.changePct < RELAXED.shortMinRise || features.changePct > RELAXED.shortMaxRise) return null;
        score += Math.min(Math.max(features.changePct, 0) * 120, 6);
        score += Math.min(features.volumeScore, 3);
        if (features.trendUp) score += 1;
        if (hasCatalyst) score += 2;
    } else if (style === "swing") {
        if (
            features.volatility > RELAXED.swingMaxVol ||
            features.changePct < RELAXED.swingMinRise ||
            features.changePct > RELAXED.swingMaxRise
        ) {
            return null;
        }
        score += Math.min(Math.max(features.changePct, 0) * 80, 4);
        score += Math.min(features.volumeScore, 3);
        if (hasCatalyst) score += 1;
    } else if (style === "mid") {
        if (
            features.changePct > RELAXED.midMaxChange ||
            features.changePct < RELAXED.midMinChange ||
            features.volatility > RELAXED.midMaxVol
        ) {
            return null;
        }
        score += Math.min(Math.max(features.changePct, 0) * 30, 2.0);
        score += Math.min(features.volumeScore, 3.0);
        if (hasCatalyst) score += 1;
        if (features.changePct < -0.01) score -= 1.5;
    }

    return score;
}

// 严格去重：每只股票只出现在一个风格中，优先归入其得分最高的风格，不足时宁缺毋滥
function pickByStyle(fullLists, styles, perStyle) {
    const best = new Map();
    for (const style of styles) {
        for (const item of fullLists[style] || []) {
            const prev = best.get(item.symbol);
            if (!prev || item.score > prev.score) best.set(item.symbol, { style, score: item.score });
        }
    }
    const assigned = new Set();
    const picks = Object.fromEntries(styles.map(style => [style, []]));
    const take = (style, item) => {
        if (picks[style].length >= perStyle || assigned.has(item.symbol)) return;
        assigned.add(item.symbol);
        picks[style].push(item);
    };
    for (const style of styles) {
        for (const item of fullLists[style] || []) {
            if (best.get(item.symbol).style === style) take(style, item);
        }
    }
    for (const style of styles) {
        for (const item of fullLists[style] || []) take(style, item);
    }
    return picks;
}

const NEW_STOCK_DAYS = 180; // 次新股排除窗口（天）

// 排除北交所、科创板、ST/退市与次新股
function applyStockFilters(list) {
    const cutoff = new Date(Date.now() - NEW_STOCK_DAYS * 24 * 3600 * 1000);
    return list.filter(s => {
        const code = String(s.symbol || "");
        const name = String(s.name || "");
        if (code.startsWith("8") || code.startsWith("4")) return false;
        if (code.startsWith("688") || code.startsWith("689")) return false;
        if (name.includes("ST") || name.includes("退")) return false;
        if (s.listingDate) {
            const listed = new Date(s.listingDate);
            if (!isNaN(listed) && listed > cutoff) return false;
        }
        return true;
    });
}

module.exports = { STYLE_ORDER, applyStockFilters, computeFeatures, pickByStyle, scoreByStyle, scoreByStyleRelaxed };
