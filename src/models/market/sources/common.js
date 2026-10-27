const { BROWSER_USER_AGENT } = require("../../../lib/http");

// 代码不存在、无日K等数据层面的“查无此股”，不代表数据源故障，不计入熔断
function notFound(message) {
    return Object.assign(new Error(message), { notFound: true });
}

function isNotFound(error) {
    return Boolean(error && (error.notFound || error.response?.status === 404));
}

// 由相邻两根K线的收盘价推算振幅、涨跌幅、涨跌额（备用源不直接提供这些字段）
function withPrevCloseFields(row, prevClose) {
    return {
        ...row,
        amp: prevClose ? ((row.high - row.low) / prevClose) * 100 : NaN,
        changePct: prevClose ? (row.close / prevClose - 1) * 100 : NaN,
        change: row.close - prevClose
    };
}

module.exports = { BROWSER_USER_AGENT, isNotFound, notFound, withPrevCloseFields };
