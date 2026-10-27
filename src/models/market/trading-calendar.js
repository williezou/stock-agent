const { formatError } = require("../../lib/http");

const HOLIDAY_API = "https://date.nager.at/api/v3/PublicHolidays";
const CN_TIMEZONE = "Asia/Shanghai";

function getChinaToday(now = new Date()) {
    const dateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: CN_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(now);
    const weekday = new Intl.DateTimeFormat("en-US", {
        timeZone: CN_TIMEZONE,
        weekday: "short"
    }).format(now);
    return { dateStr, weekday };
}

function getChinaClock(now = new Date()) {
    const { dateStr, weekday } = getChinaToday(now);
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: CN_TIMEZONE,
        hour12: false,
        hour: "2-digit",
        minute: "2-digit"
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return {
        dateStr,
        weekday,
        hour: Number(values.hour),
        minute: Number(values.minute)
    };
}

function isAfterChinaClose(now = new Date(), closeHour = 15, closeMinute = 15) {
    const { hour, minute } = getChinaClock(now);
    return hour > closeHour || (hour === closeHour && minute >= closeMinute);
}

async function fetchChinaHolidays(httpClient, requestWithRetry, year) {
    const res = await requestWithRetry(() =>
        httpClient.get(`${HOLIDAY_API}/${year}/CN`)
    );
    const list = Array.isArray(res.data) ? res.data : [];
    return new Set(list.map(item => item.date));
}

// 周末与法定节假日不是交易日；节假日接口失败时按交易日处理（宁可多跑一次也不漏推）
async function isTradingDay({ httpClient, requestWithRetry }) {
    const { dateStr, weekday } = getChinaToday();
    if (weekday === "Sat" || weekday === "Sun") {
        return { ok: false, reason: "周末", dateStr };
    }
    try {
        const year = dateStr.slice(0, 4);
        const holidays = await fetchChinaHolidays(httpClient, requestWithRetry, year);
        if (holidays.has(dateStr)) {
            return { ok: false, reason: "法定节假日", dateStr };
        }
    } catch (e) {
        console.log("⚠️ 节假日检查失败，将继续执行:", formatError(e));
    }
    return { ok: true, reason: "", dateStr };
}

function nowChinaString() {
    return new Date().toLocaleString("zh-CN", {
        timeZone: CN_TIMEZONE,
        hour12: false
    });
}

function chinaDateString() {
    return getChinaToday().dateStr;
}

module.exports = {
    CN_TIMEZONE,
    chinaDateString,
    getChinaClock,
    getChinaToday,
    isAfterChinaClose,
    isTradingDay,
    nowChinaString
};
