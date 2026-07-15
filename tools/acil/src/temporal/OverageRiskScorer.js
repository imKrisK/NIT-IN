"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OverageRiskScorer = void 0;
class OverageRiskScorer {
    _overageCostPerUnit; // $ per request or $ per credit unit
    constructor(overageCostPerUnit = 0.04) {
        this._overageCostPerUnit = overageCostPerUnit;
    }
    /**
     * Score overage risk given current balance, burn rate, and time to reset.
     *
     * @param balance          Current remaining credits (units or USD)
     * @param burnRate         Daily burn rate result from BurnRateCalculator
     * @param daysUntilReset   Days remaining in billing period
     */
    score(balance, burnRate, daysUntilReset) {
        const dailyBurn = burnRate.dailyAvg;
        if (dailyBurn <= 0 || balance <= 0) {
            return this._result(balance <= 0 ? 1.0 : 0.0, balance, daysUntilReset, dailyBurn);
        }
        // Days until balance hits zero at current burn rate
        const daysUntilExhaustion = balance / dailyBurn;
        if (daysUntilExhaustion >= daysUntilReset) {
            // Survives to reset — low base risk, but rising trend inflates slightly
            const trendInflation = burnRate.trend === 'RISING' ? 0.15 : 0;
            const baseScore = Math.max(0, 0.1 - ((daysUntilExhaustion - daysUntilReset) / daysUntilReset) * 0.1);
            return this._result(Math.min(0.35, baseScore + trendInflation), balance, daysUntilReset, dailyBurn);
        }
        // Will exhaust before reset
        const urgency = 1 - (daysUntilExhaustion / daysUntilReset);
        // Logistic shaping: urgency 0→1 maps to risk 0.5→1.0
        const raw = 0.5 + urgency * 0.5;
        // Rising trend adds up to 0.15
        const trendBonus = burnRate.trend === 'RISING' ? 0.15 : 0;
        const finalScore = Math.min(1.0, raw + trendBonus);
        return this._result(finalScore, balance, daysUntilReset, dailyBurn);
    }
    _result(score, balance, daysUntilReset, dailyBurn) {
        const daysUntilExhaustion = dailyBurn > 0 ? balance / dailyBurn : null;
        const willExhaust = daysUntilExhaustion !== null && daysUntilExhaustion < daysUntilReset;
        const excessDays = willExhaust && daysUntilExhaustion !== null
            ? daysUntilReset - daysUntilExhaustion
            : 0;
        const projectedOverageCost = willExhaust
            ? excessDays * dailyBurn * this._overageCostPerUnit
            : 0;
        let label = 'NONE';
        if (score >= 0.95)
            label = 'CERTAIN';
        else if (score >= 0.70)
            label = 'HIGH';
        else if (score >= 0.40)
            label = 'MODERATE';
        else if (score >= 0.15)
            label = 'LOW';
        return {
            score: Math.round(score * 1000) / 1000,
            label,
            daysUntilReset,
            daysUntilExhaustion: willExhaust ? daysUntilExhaustion : null,
            projectedOverageCost: Math.round(projectedOverageCost * 100) / 100,
        };
    }
}
exports.OverageRiskScorer = OverageRiskScorer;
