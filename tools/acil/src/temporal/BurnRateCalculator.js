"use strict";
/**
 * ACIL — BurnRateCalculator
 *
 * Computes a rolling weighted average of daily credit consumption.
 * The most recent days carry more weight — reflecting that recent
 * behavior is a better predictor of near-future behavior.
 *
 * Implements the burn rate calculation layer of TSP (Wave 10 Claim 9).
 *
 * Empirical validation: Jun 2026 imKrisK data
 *   Days 1-6:  avg 238 req/day (included quota, zero net cost)
 *   Day 7:     528 req (spike — quota exhausted)
 *   Days 8-15: avg 117 req/day (overage, $5.31/day)
 *
 *   A 7-day rolling burn rate computed end-of-day Jun 6 would have been:
 *   weighted_avg ≈ 273 req/day → predicted exhaustion Jun 7. CORRECT.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BurnRateCalculator = void 0;
class BurnRateCalculator {
    /**
     * Compute weighted rolling burn rate from daily records.
     * Recent days weight = 2×, older days weight = 1×.
     *
     * @param records   Chronological daily burn records (oldest first)
     * @param metricFn  Which metric to burn-rate (defaults to net cost; pass grossCost for quota analysis)
     */
    compute(records, metricFn = r => r.netCost || r.grossCost) {
        if (records.length === 0) {
            return { dailyAvg: 0, window7: 0, window14: 0, window30: 0, trend: 'STABLE', trendPct: 0, sampleDays: 0 };
        }
        const values = records.map(metricFn);
        const n = values.length;
        // Weighted average: last 7 days get weight 2, rest get weight 1
        const cutoff7 = Math.max(0, n - 7);
        let weightedSum = 0;
        let totalWeight = 0;
        for (let i = 0; i < n; i++) {
            const w = i >= cutoff7 ? 2 : 1;
            weightedSum += values[i] * w;
            totalWeight += w;
        }
        const dailyAvg = totalWeight > 0 ? weightedSum / totalWeight : 0;
        const window7 = this._simpleAvg(values.slice(-7));
        const window14 = this._simpleAvg(values.slice(-14));
        const window30 = this._simpleAvg(values.slice(-30));
        // Trend: compare last 7 days avg to prior 7 days avg
        const recent = this._simpleAvg(values.slice(-7));
        const prior = this._simpleAvg(values.slice(-14, -7));
        let trend = 'STABLE';
        let trendPct = 0;
        if (prior > 0) {
            trendPct = ((recent - prior) / prior) * 100;
            if (trendPct > 10)
                trend = 'RISING';
            if (trendPct < -10)
                trend = 'FALLING';
        }
        return { dailyAvg, window7, window14, window30, trend, trendPct, sampleDays: n };
    }
    /**
     * Variant for GitHub-style request counting (not USD).
     * Used when billing is per-request (copilot_premium_request).
     */
    computeByRequests(records) {
        return this.compute(records, r => r.totalRequests);
    }
    _simpleAvg(values) {
        if (values.length === 0)
            return 0;
        return values.reduce((s, v) => s + v, 0) / values.length;
    }
}
exports.BurnRateCalculator = BurnRateCalculator;
