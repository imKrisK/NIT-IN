/**
 * ACIL — BudgetEnforcer
 *
 * Maintains a developer's credit balance and enforces graduated budget controls.
 *
 * Implements Intertrust's "descending use counter" UDE pattern
 * (US5892900A expired 2016, US8291238B2 expired 2018 — public domain):
 * - Balance counts DOWN from allocation toward zero
 * - Threshold triggers produce notifications at each level
 * - Hard stop at zero
 *
 * NOVEL CLAIMS (Wave 10):
 * - Claim 4: Six graduated enforcement states (NORMAL → ADVISORY → WARNING →
 *   THROTTLE → CRITICAL → EXHAUSTED) — no prior art in LLM tooling
 * - Claim 7: Transparent model-downgrade at THROTTLE state — novel intermediate
 *   response between warning and hard stop
 * - Claim 9 (TSP): Integration with temporal forecaster to show CALENDAR DATE
 *   of predicted exhaustion, not just current balance
 *
 * Real-world calibration: June 2026 imKrisK GitHub account
 *   - 1,469 included requests/month
 *   - Exhausted day 7 of 30 (528-request agentic spike on Jun 7)
 *   - $111 overage projected — ZERO warnings issued by GitHub
 *   - BudgetEnforcer would have triggered ADVISORY at ~734 requests consumed
 */
import { EnforcementState, BudgetPeriod, ModelId, SessionType } from './types';
export interface EnforcementDecision {
    allowed: boolean;
    state: EnforcementState;
    effectiveModelId: ModelId;
    wasDowngraded: boolean;
    message: string | null;
    balanceRemaining: number;
    balancePct: number;
}
export declare class BudgetEnforcer {
    private _period;
    constructor(period: BudgetPeriod);
    /**
     * Evaluate whether a proposed AI request should be allowed, and if so,
     * on which model. Returns an EnforcementDecision.
     *
     * This is the core RTCE decision gate — called BEFORE every API call.
     * NOVEL: no prior art applies graduated LLM enforcement with model
     * substitution as an intermediate throttle step.
     */
    evaluate(requestedModel: ModelId, sessionType: SessionType): EnforcementDecision;
    /**
     * Deduct cost from balance after a completed API call.
     * Called by the metering pipeline post-call.
     */
    deduct(netCost: number): void;
    get currentState(): EnforcementState;
    /**
     * Returns the enforcement state computed from current balance
     * without mutating stored state. Used by the pipeline to check
     * throttle status before routing.
     */
    peekState(): EnforcementState;
    get balance(): number;
    get period(): Readonly<BudgetPeriod>;
    private _balancePct;
    private _computeState;
    private _allow;
    private _fmtPct;
}
//# sourceMappingURL=BudgetEnforcer.d.ts.map