"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BudgetEnforcer = void 0;
const types_1 = require("./types");
const PricingConfig_1 = require("../models/PricingConfig");
/** Threshold boundaries (balance percentage triggers). */
const THRESHOLDS = {
    ADVISORY: 0.50,
    WARNING: 0.25,
    THROTTLE: 0.10,
    CRITICAL: 0.05,
    EXHAUSTED: 0.00,
};
class BudgetEnforcer {
    _period;
    constructor(period) {
        this._period = { ...period };
    }
    /**
     * Evaluate whether a proposed AI request should be allowed, and if so,
     * on which model. Returns an EnforcementDecision.
     *
     * This is the core RTCE decision gate — called BEFORE every API call.
     * NOVEL: no prior art applies graduated LLM enforcement with model
     * substitution as an intermediate throttle step.
     */
    evaluate(requestedModel, sessionType) {
        const pct = this._balancePct();
        const state = this._computeState(pct);
        this._period.enforcementState = state;
        switch (state) {
            case types_1.EnforcementState.NORMAL:
                return this._allow(requestedModel, state, pct, null);
            case types_1.EnforcementState.ADVISORY:
                return this._allow(requestedModel, state, pct, `Advisory: ${this._fmtPct(pct)} credits remaining. Burn rate is elevated.`);
            case types_1.EnforcementState.WARNING:
                return this._allow(requestedModel, state, pct, `Warning: Only ${this._fmtPct(pct)} credits remaining. Consider switching to a lighter session type.`);
            case types_1.EnforcementState.THROTTLE: {
                // NOVEL CLAIM 7: Transparent model downgrade — user keeps working,
                // ACIL silently substitutes a cheaper model.
                const downgrade = PricingConfig_1.THROTTLE_SUBSTITUTION[requestedModel];
                const effectiveModel = downgrade ?? requestedModel;
                const wasDowngraded = !!downgrade;
                return {
                    allowed: true,
                    state,
                    effectiveModelId: effectiveModel,
                    wasDowngraded,
                    message: wasDowngraded
                        ? `Throttle: Model downgraded ${requestedModel} → ${effectiveModel} to preserve budget. ${this._fmtPct(pct)} remaining.`
                        : `Throttle: ${this._fmtPct(pct)} credits remaining. Optimize session if possible.`,
                    balanceRemaining: this._period.remaining,
                    balancePct: pct,
                };
            }
            case types_1.EnforcementState.CRITICAL:
                // Block new agentic sessions; allow simple calls through
                if (sessionType === types_1.SessionType.AGENTIC) {
                    return {
                        allowed: false,
                        state,
                        effectiveModelId: requestedModel,
                        wasDowngraded: false,
                        message: `Critical: Agentic session blocked. Only ${this._fmtPct(pct)} credits remain. Simple requests still allowed.`,
                        balanceRemaining: this._period.remaining,
                        balancePct: pct,
                    };
                }
                return this._allow(requestedModel, state, pct, `Critical: ${this._fmtPct(pct)} credits remaining. Agentic sessions blocked. Reset: ${this._period.resetDate.toLocaleDateString()}.`);
            case types_1.EnforcementState.EXHAUSTED:
                return {
                    allowed: false,
                    state,
                    effectiveModelId: requestedModel,
                    wasDowngraded: false,
                    message: `Exhausted: Credit quota depleted. Next reset: ${this._period.resetDate.toLocaleDateString()}. Overage charges apply.`,
                    balanceRemaining: 0,
                    balancePct: 0,
                };
        }
    }
    /**
     * Deduct cost from balance after a completed API call.
     * Called by the metering pipeline post-call.
     */
    deduct(netCost) {
        this._period.consumed += netCost;
        this._period.remaining = Math.max(0, this._period.totalAllocation - this._period.consumed);
        this._period.enforcementState = this._computeState(this._balancePct());
    }
    get currentState() {
        return this._period.enforcementState;
    }
    /**
     * Returns the enforcement state computed from current balance
     * without mutating stored state. Used by the pipeline to check
     * throttle status before routing.
     */
    peekState() {
        return this._computeState(this._balancePct());
    }
    get balance() {
        return this._period.remaining;
    }
    get period() {
        return { ...this._period };
    }
    _balancePct() {
        if (this._period.totalAllocation === 0)
            return 0;
        return this._period.remaining / this._period.totalAllocation;
    }
    _computeState(pct) {
        if (pct <= THRESHOLDS.EXHAUSTED)
            return types_1.EnforcementState.EXHAUSTED;
        if (pct <= THRESHOLDS.CRITICAL)
            return types_1.EnforcementState.CRITICAL;
        if (pct <= THRESHOLDS.THROTTLE)
            return types_1.EnforcementState.THROTTLE;
        if (pct <= THRESHOLDS.WARNING)
            return types_1.EnforcementState.WARNING;
        if (pct <= THRESHOLDS.ADVISORY)
            return types_1.EnforcementState.ADVISORY;
        return types_1.EnforcementState.NORMAL;
    }
    _allow(model, state, pct, message) {
        return { allowed: true, state, effectiveModelId: model, wasDowngraded: false, message, balanceRemaining: this._period.remaining, balancePct: pct };
    }
    _fmtPct(pct) {
        return `${Math.round(pct * 100)}%`;
    }
}
exports.BudgetEnforcer = BudgetEnforcer;
