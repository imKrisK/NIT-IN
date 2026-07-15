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
import { DailyBurnRecord } from '../core/AuditTrail';
export interface BurnRateResult {
    dailyAvg: number;
    window7: number;
    window14: number;
    window30: number;
    trend: 'RISING' | 'STABLE' | 'FALLING';
    trendPct: number;
    sampleDays: number;
}
export declare class BurnRateCalculator {
    /**
     * Compute weighted rolling burn rate from daily records.
     * Recent days weight = 2×, older days weight = 1×.
     *
     * @param records   Chronological daily burn records (oldest first)
     * @param metricFn  Which metric to burn-rate (defaults to net cost; pass grossCost for quota analysis)
     */
    compute(records: DailyBurnRecord[], metricFn?: (r: DailyBurnRecord) => number): BurnRateResult;
    /**
     * Variant for GitHub-style request counting (not USD).
     * Used when billing is per-request (copilot_premium_request).
     */
    computeByRequests(records: DailyBurnRecord[]): BurnRateResult;
    private _simpleAvg;
}
//# sourceMappingURL=BurnRateCalculator.d.ts.map