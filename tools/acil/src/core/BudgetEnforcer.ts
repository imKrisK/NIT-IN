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

import {
  EnforcementState,
  BudgetPeriod,
  ModelId,
  SessionType,
} from './types';
import { THROTTLE_SUBSTITUTION } from '../models/PricingConfig';

export interface EnforcementDecision {
  allowed:          boolean;
  state:            EnforcementState;
  effectiveModelId: ModelId;          // May differ from requested if throttled
  wasDowngraded:    boolean;          // true if model was substituted
  message:          string | null;    // User-facing notification text
  balanceRemaining: number;
  balancePct:       number;           // 0.0–1.0
}

/** Threshold boundaries (balance percentage triggers). */
const THRESHOLDS = {
  ADVISORY:  0.50,
  WARNING:   0.25,
  THROTTLE:  0.10,
  CRITICAL:  0.05,
  EXHAUSTED: 0.00,
} as const;

export class BudgetEnforcer {
  private _period: BudgetPeriod;

  constructor(period: BudgetPeriod) {
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
  evaluate(requestedModel: ModelId, sessionType: SessionType): EnforcementDecision {
    const pct   = this._balancePct();
    const state = this._computeState(pct);
    this._period.enforcementState = state;

    switch (state) {
      case EnforcementState.NORMAL:
        return this._allow(requestedModel, state, pct, null);

      case EnforcementState.ADVISORY:
        return this._allow(
          requestedModel, state, pct,
          `Advisory: ${this._fmtPct(pct)} credits remaining. Burn rate is elevated.`,
        );

      case EnforcementState.WARNING:
        return this._allow(
          requestedModel, state, pct,
          `Warning: Only ${this._fmtPct(pct)} credits remaining. Consider switching to a lighter session type.`,
        );

      case EnforcementState.THROTTLE: {
        // NOVEL CLAIM 7: Transparent model downgrade — user keeps working,
        // ACIL silently substitutes a cheaper model.
        const downgrade  = THROTTLE_SUBSTITUTION[requestedModel];
        const effectiveModel = downgrade ?? requestedModel;
        const wasDowngraded  = !!downgrade;
        return {
          allowed:          true,
          state,
          effectiveModelId: effectiveModel,
          wasDowngraded,
          message: wasDowngraded
            ? `Throttle: Model downgraded ${requestedModel} → ${effectiveModel} to preserve budget. ${this._fmtPct(pct)} remaining.`
            : `Throttle: ${this._fmtPct(pct)} credits remaining. Optimize session if possible.`,
          balanceRemaining: this._period.remaining,
          balancePct:       pct,
        };
      }

      case EnforcementState.CRITICAL:
        // Block new agentic sessions; allow simple calls through
        if (sessionType === SessionType.AGENTIC) {
          return {
            allowed:          false,
            state,
            effectiveModelId: requestedModel,
            wasDowngraded:    false,
            message:          `Critical: Agentic session blocked. Only ${this._fmtPct(pct)} credits remain. Simple requests still allowed.`,
            balanceRemaining: this._period.remaining,
            balancePct:       pct,
          };
        }
        return this._allow(
          requestedModel, state, pct,
          `Critical: ${this._fmtPct(pct)} credits remaining. Agentic sessions blocked. Reset: ${this._period.resetDate.toLocaleDateString()}.`,
        );

      case EnforcementState.EXHAUSTED:
        return {
          allowed:          false,
          state,
          effectiveModelId: requestedModel,
          wasDowngraded:    false,
          message:          `Exhausted: Credit quota depleted. Next reset: ${this._period.resetDate.toLocaleDateString()}. Overage charges apply.`,
          balanceRemaining: 0,
          balancePct:       0,
        };
    }
  }

  /**
   * Deduct cost from balance after a completed API call.
   * Called by the metering pipeline post-call.
   */
  deduct(netCost: number): void {
    this._period.consumed   += netCost;
    this._period.remaining   = Math.max(0, this._period.totalAllocation - this._period.consumed);
    this._period.enforcementState = this._computeState(this._balancePct());
  }

  get currentState(): EnforcementState {
    return this._period.enforcementState;
  }

  /**
   * Returns the enforcement state computed from current balance
   * without mutating stored state. Used by the pipeline to check
   * throttle status before routing.
   */
  peekState(): EnforcementState {
    return this._computeState(this._balancePct());
  }

  get balance(): number {
    return this._period.remaining;
  }

  get period(): Readonly<BudgetPeriod> {
    return { ...this._period };
  }

  private _balancePct(): number {
    if (this._period.totalAllocation === 0) return 0;
    return this._period.remaining / this._period.totalAllocation;
  }

  private _computeState(pct: number): EnforcementState {
    if (pct <= THRESHOLDS.EXHAUSTED) return EnforcementState.EXHAUSTED;
    if (pct <= THRESHOLDS.CRITICAL)  return EnforcementState.CRITICAL;
    if (pct <= THRESHOLDS.THROTTLE)  return EnforcementState.THROTTLE;
    if (pct <= THRESHOLDS.WARNING)   return EnforcementState.WARNING;
    if (pct <= THRESHOLDS.ADVISORY)  return EnforcementState.ADVISORY;
    return EnforcementState.NORMAL;
  }

  private _allow(model: ModelId, state: EnforcementState, pct: number, message: string | null): EnforcementDecision {
    return { allowed: true, state, effectiveModelId: model, wasDowngraded: false, message, balanceRemaining: this._period.remaining, balancePct: pct };
  }

  private _fmtPct(pct: number): string {
    return `${Math.round(pct * 100)}%`;
  }
}
