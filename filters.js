const NEW_STOCK_DAYS = 180; // 次新股排除窗口（天）

function applyStockFilters(list) {
    const today = new Date();
    const cutoff = new Date(today.getTime() - NEW_STOCK_DAYS * 24 * 3600 * 1000);

    return list.filter(s => {
        const code = String(s.symbol || "");
        const name = String(s.name || "");

        // 排除：北交所
        if (code.startsWith("8") || code.startsWith("4")) return false;

        // 排除：科创板（688/689）
        if (code.startsWith("688") || code.startsWith("689")) return false;

        // 排除：ST / 退市
        if (name.includes("ST") || name.includes("退")) return false;

        // 排除：次新股（上市不足 NEW_STOCK_DAYS）
        if (s.listingDate) {
            const d = new Date(s.listingDate);
            if (!isNaN(d) && d > cutoff) return false;
        }

        return true;
    });
}

module.exports = { applyStockFilters };
