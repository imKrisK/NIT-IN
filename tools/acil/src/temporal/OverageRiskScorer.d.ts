/**
 * ACIL — OverageRiskScorer
 *
 * Computes a 0.0–1.0 probability that a developer will exceed their included
 * credit quota before the billing period resets.
 *
 * Part of TSP (Wave 10 Claim 9). Feeds the EnforcementDecision and alert system.
 *
 * Scoring model: logistic function over projected_exhaustion_distance
 *   - exhaustion before reset → score approaches 1.0
 *   - exhaustion well after reset → score approaches 0.0
 *   - also factors in burn rate trend (rising trend inflates score)
 */
import { BurnRateResult } from './BurnRateCalculator';
export interface OverageRiskResult {
    score: number;
    label: 'NONE' | 'LOW' | 'MODERATE' | 'HIGH' | 'CERTAIN';
    daysUntilReset: number;
    daysUntilExhaustion: number | null;
    projectedOverageCost: number;
}
export declare class OverageRiskScorer {
    private _overageCostPerUnit;
    constructor(overageCostPerUnit?: number);
    /**
     * Score overage risk given current balance, burn rate, and time to reset.
     *
     * @param balance          Current remaining credits (units or USD)
     * @param burnRate         Daily burn rate result from BurnRateCalculator
     * @param daysUntilReset   Days remaining in billing period
     */
    score(balance: number, burnRate: BurnRateResult, daysUntilReset: number): OverageRiskResult;
    private _result;
}
//# sourceMappingURL=OverageRiskScorer.d.ts.map