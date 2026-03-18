const MID_MAX_CHANGE_PCT = 0.04; // 中线：更稳健，排除过度拉升（4%+）
const MID_MAX_VOL = 0.03; // 中线：最大波动
const INTRADAY_MIN_MOVE = 0.04; // 日内：高波动
const SHORT_MIN_RISE = 0.02; // 短线最小涨幅
const SHORT_MAX_RISE = 0.06; // 短线最大涨幅
const SWING_MIN_RISE = 0.0; // 波段最小涨幅
const SWING_MAX_RISE = 0.03; // 波段最大涨幅
const SWING_MAX_VOL = 0.05; // 波段最大波动
const GAP_THRESHOLD = 0.03;

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

module.exports = { computeFeatures, scoreByStyle };
