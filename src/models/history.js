const RETENTION_DAYS = 7;

// 保留7天的历史数据：收盘报告、资金异动推送记录与监控状态、已发送的管理员告警
function createHistoryRepository(pool) {
    // 当日已生成的收盘报告：symbol → report
    async function getCachedReports(reportDate, symbols) {
        if (!symbols.length) return new Map();
        const result = await pool.query(
            "SELECT symbol, report FROM stock_reports WHERE report_date = $1 AND symbol = ANY($2::varchar[])",
            [reportDate, symbols]
        );
        return new Map(result.rows.map(row => [row.symbol, row.report]));
    }

    async function saveCachedReport(reportDate, symbol, report) {
        await pool.query(
            `INSERT INTO stock_reports (report_date, symbol, report, created_at)
             VALUES ($1, $2, $3::jsonb, NOW())
             ON CONFLICT (report_date, symbol) DO UPDATE SET report = EXCLUDED.report, created_at = NOW()`,
            [reportDate, symbol, JSON.stringify(report)]
        );
    }

    async function saveFundFlowAlert(alertDate, windowLabel, content) {
        await pool.query(
            "INSERT INTO fund_flow_alerts (alert_date, window_label, content) VALUES ($1, $2, $3::jsonb)",
            [alertDate, windowLabel, JSON.stringify(content)]
        );
    }

    async function getFundFlowState(stateDate, windowLabel) {
        const result = await pool.query(
            "SELECT state FROM fund_flow_state WHERE state_date = $1 AND window_label = $2",
            [stateDate, windowLabel]
        );
        return result.rows[0] ? result.rows[0].state : null;
    }

    async function saveFundFlowState(stateDate, windowLabel, state) {
        await pool.query(
            `INSERT INTO fund_flow_state (state_date, window_label, state, updated_at)
             VALUES ($1, $2, $3::jsonb, NOW())
             ON CONFLICT (state_date, window_label) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
            [stateDate, windowLabel, JSON.stringify(state)]
        );
    }

    // 管理员告警去重记录，接口与 Set 的 has/add 一致，可直接作为 alertAdmin 的 alerted
    const adminAlerts = {
        async has(key) {
            const result = await pool.query("SELECT 1 FROM admin_alerts WHERE alert_key = $1", [key]);
            return result.rowCount > 0;
        },
        async add(key) {
            await pool.query("INSERT INTO admin_alerts (alert_key) VALUES ($1) ON CONFLICT DO NOTHING", [key]);
        }
    };

    async function pruneHistory() {
        await pool.query(`DELETE FROM stock_reports WHERE report_date < CURRENT_DATE - ${RETENTION_DAYS}`);
        await pool.query(`DELETE FROM fund_flow_alerts WHERE alert_date < CURRENT_DATE - ${RETENTION_DAYS}`);
        await pool.query(`DELETE FROM fund_flow_state WHERE state_date < CURRENT_DATE - ${RETENTION_DAYS}`);
        await pool.query(`DELETE FROM admin_alerts WHERE sent_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`);
    }

    return {
        adminAlerts,
        getCachedReports,
        getFundFlowState,
        pruneHistory,
        saveCachedReport,
        saveFundFlowAlert,
        saveFundFlowState
    };
}

module.exports = { RETENTION_DAYS, createHistoryRepository };
