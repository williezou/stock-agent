// 筹码分布（估算）：按日K的换手率逐日衰减旧筹码、叠加当天新筹码。
// 当天成交在最低价到最高价之间呈三角形分布（峰值在 (高+低+收)/3），旧筹码按换手率等比例转手：
//   筹码[i] = 筹码[i] ×（1 − 换手率）+ 当天分布[i] × 换手率
// 第一天的成交作为初始筹码。各家 App 的参数不同，结果只作参考；任何一天缺换手率（如腾讯备用数据）就不计算
const BINS = 120;

function dayDistribution(row, low, step, bins) {
    const weights = new Array(bins).fill(0);
    const index = price => Math.min(bins - 1, Math.max(0, Math.round((price - low) / step)));
    const from = index(row.low);
    const to = index(row.high);
    if (from === to) {
        weights[from] = 1;
        return weights;
    }
    const peak = (row.high + row.low + row.close) / 3;
    let total = 0;
    for (let i = from; i <= to; i++) {
        const price = low + i * step;
        const weight = price <= peak
            ? (price - row.low) / Math.max(peak - row.low, 1e-9)
            : (row.high - price) / Math.max(row.high - peak, 1e-9);
        weights[i] = Math.max(weight, 0.02);
        total += weights[i];
    }
    for (let i = from; i <= to; i++) weights[i] /= total;
    return weights;
}

// 累计到 q 比例时的价格
function quantile(prices, weights, q) {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
        sum += weights[i];
        if (sum >= q) return prices[i];
    }
    return prices.at(-1);
}

function range(prices, weights, share) {
    const tail = (1 - share) / 2;
    const low = quantile(prices, weights, tail);
    const high = quantile(prices, weights, 1 - tail);
    return { low, high, concentration: (high - low) / (high + low) };
}

// rows：按日期升序的日K（含 high/low/close 与换手率%）。返回 null 表示数据不足或缺换手率
function computeChipDistribution(rows, { bins = BINS } = {}) {
    if (!Array.isArray(rows) || rows.length < 20) return null;
    if (rows.some(row => !Number.isFinite(row.turnover) || row.turnover < 0 || !Number.isFinite(row.high) || !Number.isFinite(row.low))) return null;
    const low = Math.min(...rows.map(row => row.low));
    const high = Math.max(...rows.map(row => row.high));
    if (!(high > low)) return null;
    const step = (high - low) / (bins - 1);
    const prices = Array.from({ length: bins }, (_, i) => low + i * step);

    let chips = new Array(bins).fill(0);
    rows.forEach((row, index) => {
        const rate = index === 0 ? 1 : Math.min(1, row.turnover / 100);
        const today = dayDistribution(row, low, step, bins);
        chips = chips.map((value, i) => value * (1 - rate) + today[i] * rate);
    });
    const total = chips.reduce((sum, value) => sum + value, 0);
    const weights = chips.map(value => value / total);

    const close = rows.at(-1).close;
    return {
        prices: prices.map(price => Number(price.toFixed(4))),
        weights: weights.map(weight => Number(weight.toFixed(6))),
        close,
        avgCost: prices.reduce((sum, price, i) => sum + price * weights[i], 0),
        profitRatio: weights.reduce((sum, weight, i) => sum + (prices[i] <= close ? weight : 0), 0),
        range90: range(prices, weights, 0.9),
        range70: range(prices, weights, 0.7)
    };
}

module.exports = { computeChipDistribution, dayDistribution };
