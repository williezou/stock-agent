const HOLIDAY_API = "https://date.nager.at/api/v3/PublicHolidays";
const CN_TIMEZONE = "Asia/Shanghai";

function getChinaToday() {
    const now = new Date();
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

async function fetchChinaHolidays(httpClient, requestWithRetry, year) {
    const res = await requestWithRetry(() =>
        httpClient.get(`${HOLIDAY_API}/${year}/CN`)
    );
    const list = Array.isArray(res.data) ? res.data : [];
    return new Set(list.map(item => item.date));
}

async function isTradingDay({ httpClient, requestWithRetry, formatError }) {
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
        if (formatError) {
            console.log("⚠️ 节假日检查失败，将继续执行:", formatError(e));
        }
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

module.exports = { isTradingDay, nowChinaString, chinaDateString };
