const { computeChipDistribution } = require("./chip-distribution");

function average(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sma(values, period) {
    if (!Array.isArray(values) || values.length < period) return null;
    return average(values.slice(-period));
}

function emaSeries(values, period) {
    if (!Array.isArray(values) || values.length === 0) return [];
    const alpha = 2 / (period + 1);
    const out = [values[0]];
    for (let i = 1; i < values.length; i++) {
        out.push(values[i] * alpha + out[i - 1] * (1 - alpha));
    }
    return out;
}

function calculateMacd(closes) {
    if (!Array.isArray(closes) || closes.length < 26) return null;
    const fast = emaSeries(closes, 12);
    const slow = emaSeries(closes, 26);
    const diffs = closes.map((_, index) => fast[index] - slow[index]);
    const signal = emaSeries(diffs, 9);
    const last = closes.length - 1;
    return {
        dif: diffs[last],
        dea: signal[last],
        histogram: (diffs[last] - signal[last]) * 2
    };
}

function calculateRsi(closes, period = 14) {
    if (!Array.isArray(closes) || closes.length <= period) return null;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change >= 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        const gain = Math.max(change, 0);
        const loss = Math.max(-change, 0);
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    const relativeStrength = avgGain / avgLoss;
    return 100 - 100 / (1 + relativeStrength);
}

function calculateKdj(klines, period = 9) {
    if (!Array.isArray(klines) || klines.length < period) return null;
    let k = 50;
    let d = 50;
    for (let i = period - 1; i < klines.length; i++) {
        const window = klines.slice(i - period + 1, i + 1);
        const highest = Math.max(...window.map(item => item.high));
        const lowest = Math.min(...window.map(item => item.low));
        const rsv = highest === lowest
            ? 50
            : ((klines[i].close - lowest) / (highest - lowest)) * 100;
        k = (2 * k + rsv) / 3;
        d = (2 * d + k) / 3;
    }
    return { k, d, j: 3 * k - 2 * d };
}

function calculateBollinger(closes, period = 20, multiplier = 2) {
    if (!Array.isArray(closes) || closes.length < period) return null;
    const window = closes.slice(-period);
    const middle = average(window);
    const variance = average(window.map(value => (value - middle) ** 2));
    const deviation = Math.sqrt(variance);
    return {
        middle,
        upper: middle + multiplier * deviation,
        lower: middle - multiplier * deviation
    };
}

function weightedClose(klines) {
    const totalVolume = klines.reduce((sum, item) => sum + item.volume, 0);
    if (!totalVolume) return null;
    return klines.reduce((sum, item) => sum + item.close * item.volume, 0) / totalVolume;
}

function nearestLevel(levels, price, direction) {
    const valid = levels.filter(Number.isFinite);
    if (direction === "below") {
        const candidates = valid.filter(level => level <= price);
        return candidates.length ? Math.max(...candidates) : Math.min(...valid);
    }
    const candidates = valid.filter(level => level >= price);
    return candidates.length ? Math.min(...candidates) : Math.max(...valid);
}

function analyzeKlines(klines) {
    if (!Array.isArray(klines) || klines.length < 20) {
        throw new Error("至少需要20个交易日的数据才能生成收盘分析");
    }

    // 成交额、换手率为可选字段（备用数据源的历史K线可能缺失）：分析只读取最新一根的这两个值，展示时缺失显示为“不可用”
    const rows = klines.filter(item =>
        item &&
        Number.isFinite(item.open) &&
        Number.isFinite(item.close) &&
        Number.isFinite(item.high) &&
        Number.isFinite(item.low) &&
        Number.isFinite(item.volume) &&
        Number.isFinite(item.changePct)
    );
    if (rows.length < 20) throw new Error("有效日线数据不足20个交易日");

    const latest = rows.at(-1);
    const previous = rows.at(-2);
    const closes = rows.map(item => item.close);
    const ma = {
        ma5: sma(closes, 5),
        ma10: sma(closes, 10),
        ma20: sma(closes, 20),
        ma60: sma(closes, 60)
    };
    const macd = calculateMacd(closes);
    const rsi = calculateRsi(closes, 14);
    const kdj = calculateKdj(rows, 9);
    const bollinger = calculateBollinger(closes, 20, 2);
    const prior = rows.slice(0, -1);
    const prior20 = prior.slice(-20);
    const recent20 = rows.slice(-20);
    const prior5Volume = average(prior.slice(-5).map(item => item.volume));
    const volumeRatio = prior5Volume ? latest.volume / prior5Volume : null;
    const previousHigh20 = Math.max(...prior20.map(item => item.high));
    const recentLow20 = Math.min(...recent20.map(item => item.low));
    const recentHigh20 = Math.max(...recent20.map(item => item.high));
    const support = nearestLevel(
        [ma.ma5, ma.ma10, ma.ma20, bollinger && bollinger.middle, recentLow20],
        latest.close,
        "below"
    );
    const resistance = nearestLevel(
        [previousHigh20, bollinger && bollinger.upper, recentHigh20],
        latest.close,
        "above"
    );

    return {
        latest,
        previous,
        ma,
        macd,
        rsi,
        kdj,
        bollinger,
        volumeRatio,
        previousHigh20,
        recentLow20,
        recentHigh20,
        support,
        resistance,
        weightedClose20: weightedClose(recent20),
        // 筹码分布用全部日K（约140天）估算；缺换手率时为 null
        chips: computeChipDistribution(rows)
    };
}

function buildTradePlan(analysis) {
    const { latest, ma, rsi, kdj, bollinger, volumeRatio, previousHigh20, support, recentLow20 } = analysis;
    const price = latest.close;
    const reference = Number.isFinite(support) && support > 0 ? support : (ma.ma20 || price);
    const entryLow = reference * 0.99;
    const entryHigh = reference * 1.01;
    const entry = (entryLow + entryHigh) / 2;
    const structuralStop = Number.isFinite(recentLow20) && recentLow20 < entry
        ? recentLow20 * 0.995
        : entry * 0.92;
    const stop = Math.max(entry * 0.92, structuralStop);
    const target = entry * 1.15;
    const rewardRisk = (target - entry) / Math.max(entry - stop, 0.01);
    const breakoutTrigger = previousHigh20 * 1.003;
    const overheated =
        (Number.isFinite(rsi) && rsi >= 70) ||
        (kdj && kdj.j >= 100) ||
        (bollinger && price >= bollinger.upper * 0.99 && latest.changePct > 0);
    const breakoutConfirmed =
        price >= breakoutTrigger &&
        Number.isFinite(volumeRatio) &&
        volumeRatio >= 1.2;
    const inPullbackZone = price >= entryLow && price <= entryHigh;

    let recommendation = "观望";
    let reason = `等待回踩${entryLow.toFixed(2)}～${entryHigh.toFixed(2)}元企稳，或放量站稳${breakoutTrigger.toFixed(2)}元`;
    if (overheated) {
        reason = `指标偏热，不追高；等待回踩${entryLow.toFixed(2)}～${entryHigh.toFixed(2)}元并缩量企稳`;
    } else if (breakoutConfirmed) {
        recommendation = "条件性试仓";
        reason = `已出现放量突破信号，可等待${breakoutTrigger.toFixed(2)}元上方确认后小仓试探`;
    } else if (inPullbackZone && latest.changePct > -4) {
        recommendation = "等待企稳后试仓";
        reason = `价格进入参考回踩区，需等待止跌或放量转强确认`;
    }

    return {
        recommendation,
        reason,
        entryLow,
        entryHigh,
        stop,
        target,
        rewardRisk,
        breakoutTrigger,
        overheated,
        breakoutConfirmed
    };
}

module.exports = {
    analyzeKlines,
    buildTradePlan,
    calculateBollinger,
    calculateKdj,
    calculateMacd,
    calculateRsi,
    emaSeries,
    sma
};
