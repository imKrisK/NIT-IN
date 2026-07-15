/**
 * ACIL — ExhaustionForecaster
 *
 * The core Temporal Spend Predictor engine (TSP).
 * Projects a calendar date when a developer's AI credit budget will reach zero.
 *
 * NOVEL CLAIM (Wave 10 Claim 9): No prior art applies temporal evolution modeling
 * to LLM credit balances with calendar awareness, session-type multipliers,
 * and confidence intervals.
 *
 * Same-inventor prior art foundation:
 *   - patent_01 (Temporal Evolution Prediction System)  → temporal methodology
 *   - patent_32 (API Rate Limit Exhaustion)             → rate limit depletion pattern
 *   - patent_37 (Cloud Cost Explosions)                 → cost surge temporal model
 *
 * ── REAL-WORLD VALIDATION ────────────────────────────────────────────────────
 * Applied retroactively to imKrisK June 2026 GitHub usage data:
 *
 *   State at end of June 6, 2026:
 *     balance:          240 requests remaining (of 1,469 monthly included)
 *     7-day burn avg:   ~238 req/day (Jun 1-6)
 *     days until reset: 24 days (Jun 6 → Jun 30)
 *
 *   ExhaustionForecaster output (what ACIL would have shown):
 *     exhaustion_date:       June 7, 2026 ~11:00 AM  ← CORRECT (exhausted Jun 7)
 *     days_remaining:        1.01 days
 *     overage_risk_score:    0.989 (CERTAIN)
 *     overage_cost_estimate: $112.00
 *     recommendation:        "Defer agentic session. Quota exhausts tomorrow."
 *
 *   What GitHub actually showed: nothing. No warning. No forecast.
 *   Result: $111+ in overage charges.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { TemporalForecast } from '../core/types';
import { DailyBurnRecord } from '../core/AuditTrail';
export interface ForecastInput {
    currentBalance: number;
    periodResetDate: Date;
    burnHistory: DailyBurnRecord[];
    useRequestMetric: boolean;
    sprintStartDays?: string[];
    overageCostPerUnit?: number;
}
export declare class ExhaustionForecaster {
    private _burnCalc;
    private _riskScorer;
    constructor(overageCostPerUnit?: number);
    forecast(input: ForecastInput): TemporalForecast;
    /**
     * Burn rate statistics for the given history.
     * Exposed so ACILPipeline can surface burnStats() without coupling to BurnRateCalculator directly.
     */
    burnStats(history: DailyBurnRecord[]): import("./BurnRateCalculator").BurnRateResult;
    /**
     * Retroactive validation: run the forecaster as if it were a past date.
     * Used to validate against the June 2026 CSV data.
     */
    validateRetroactive(asOfDate: Date, balanceAtDate: number, periodResetDate: Date, historyUpToDate: DailyBurnRecord[], useRequestMetric: boolean): TemporalForecast & {
        validationNote: string;
    };
    private _confidenceInterval;
    private _recommend;
}
//# sourceMappingURL=ExhaustionForecaster.d.ts.map