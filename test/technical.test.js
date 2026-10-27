const test = require("node:test");
const assert = require("node:assert/strict");
const {
    analyzeKlines,
    buildTradePlan,
    calculateBollinger,
    calculateRsi,
    sma
} = require("../technical");

function makeKlines(length = 80) {
    return Array.from({ length }, (_, index) => {
        const close = 20 + index * 0.08 + Math.sin(index / 3) * 0.2;
        const previous = index === 0 ? close : 20 + (index - 1) * 0.08 + Math.sin((index - 1) / 3) * 0.2;
        return {
            date: new Date(Date.UTC(2026, 6, 1 + index)).toISOString().slice(0, 10),
            open: close - 0.05,
            close,
            high: close + 0.2,
            low: close - 0.2,
            volume: 100000 + index * 1000,
            amount: close * (100000 + index * 1000) * 100,
            changePct: ((close - previous) / previous) * 100,
            turnover: 2 + index / 100
        };
    });
}

test("基础指标能够从足量日线计算", () => {
    const closes = [1, 2, 3, 4, 5];
    assert.equal(sma(closes, 5), 3);
    assert.equal(calculateRsi(Array.from({ length: 20 }, (_, i) => i + 1)), 100);
    const boll = calculateBollinger(Array.from({ length: 20 }, () => 10));
    assert.deepEqual(boll, { lower: 10, middle: 10, upper: 10 });
});

test("分析结果包含完整技术指标和不超过8%的计划止损", () => {
    const analysis = analyzeKlines(makeKlines());
    const plan = buildTradePlan(analysis);
    const entry = (plan.entryLow + plan.entryHigh) / 2;
    const plannedLoss = (entry - plan.stop) / entry;

    assert.ok(Number.isFinite(analysis.ma.ma60));
    assert.ok(Number.isFinite(analysis.macd.dif));
    assert.ok(Number.isFinite(analysis.rsi));
    assert.ok(Number.isFinite(analysis.kdj.j));
    assert.ok(Number.isFinite(analysis.weightedClose20));
    assert.ok(plannedLoss <= 0.0800001);
    assert.ok(Math.abs(plan.target / entry - 1.15) < 1e-10);
});
