const test = require("node:test");
const assert = require("node:assert/strict");
const { computeChipDistribution, dayDistribution } = require("../../src/services/chip-distribution");
const { generateStockChart } = require("../../src/views/charts/stock-charts");
const { chipsLine, formatOverviewCaption } = require("../../src/views/daily-report-view");

// 先在10元附近横盘、再涨到20元附近横盘：换手率高时旧筹码基本转手到20元附近
function rows({ turnover = 5, days = 60 } = {}) {
    return Array.from({ length: days }, (_, index) => {
        const base = index < days / 2 ? 10 : 20;
        return { date: `d${index}`, open: base, close: base, high: base * 1.02, low: base * 0.98, volume: 1000, turnover };
    });
}

test("当天成交在最低到最高价之间呈三角形分布，合计为1；一字板全部落在一个价位", () => {
    const weights = dayDistribution({ low: 9, high: 11, close: 10 }, 0, 0.5, 30);
    assert.ok(Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
    assert.equal(weights.indexOf(Math.max(...weights)), 20, "峰值在(高+低+收)/3 = 10");
    assert.deepEqual(dayDistribution({ low: 10, high: 10, close: 10 }, 0, 0.5, 30).filter(Boolean), [1]);
});

test("旧筹码按换手率转手：高换手时成本移到新价位、获利盘接近100%；低换手时仍有大量低位筹码", () => {
    const fast = computeChipDistribution(rows({ turnover: 20 }));
    assert.ok(fast.avgCost > 19 && fast.avgCost < 21, `平均成本 ${fast.avgCost}`);
    assert.ok(fast.range90.low > 18);
    assert.ok(Math.abs(fast.weights.reduce((sum, value) => sum + value, 0) - 1) < 1e-4);

    const slow = computeChipDistribution(rows({ turnover: 1 }));
    assert.ok(slow.avgCost < 17, "低换手时低位筹码转手少，平均成本明显低于现价");
    assert.ok(slow.range90.low < 11, "90%筹码区间包含10元附近");
    assert.ok(slow.profitRatio > 0.5);
    assert.ok(slow.range90.concentration > slow.range70.concentration, "90%区间比70%区间宽");
});

test("缺换手率（腾讯备用数据）或不足20天时不计算", () => {
    const missing = rows();
    missing[3].turnover = NaN;
    assert.equal(computeChipDistribution(missing), null);
    assert.equal(computeChipDistribution(rows({ days: 10 })), null);
});

test("说明行与K线图：有筹码时显示一行并在K线右侧画分布，没有时不显示", () => {
    const chips = computeChipDistribution(rows({ turnover: 1 }));
    assert.match(chipsLine(chips), /^🧱 筹码（估算）：平均成本 \d+\.\d{2}｜获利盘 \d+%｜90%筹码 \d+\.\d{2}～\d+\.\d{2}（集中度 \d+\.\d%）$/);
    assert.equal(chipsLine(null), "");
    const klines = rows({ turnover: 1 }).map(row => ({ ...row, changePct: 0 }));
    const report = chip => ({ meta: { exchangeCode: "600519.SH" }, klines, analysis: { support: 19, resistance: 21, chips: chip } });
    assert.equal(generateStockChart(report(chips)).subarray(1, 4).toString(), "PNG");
    assert.equal(generateStockChart(report(null)).subarray(1, 4).toString(), "PNG");
});

test("收盘总览：有筹码时图例才提到右侧的筹码分布", () => {
    const report = chips => ({ meta: { symbol: "600519", name: "贵州茅台" }, plan: { recommendation: "观望" }, analysis: { latest: { close: 10, changePct: 1 }, volumeRatio: 1, chips } });
    assert.match(formatOverviewCaption([report(computeChipDistribution(rows()))], "2026-10-29"), /个股图右侧为筹码分布/);
    assert.doesNotMatch(formatOverviewCaption([report(null)], "2026-10-29"), /筹码/);
});
