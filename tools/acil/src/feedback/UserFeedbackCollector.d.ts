/**
 * ACIL — UserFeedbackCollector
 *
 * Tracks developer accept/reject decisions on ACIL recommendations so the
 * MetaRecursiveLoop can learn which suggestions are trusted vs. ignored.
 *
 * Three feedback signals collected:
 *   1. Model substitution — did developer accept the cheaper model suggestion?
 *   2. CCT compression — did developer let the compressed prompt through?
 *   3. Budget enforcement — did developer override a soft-block?
 *
 * Feedback is persisted to `acil-feedback.json` alongside audit data.
 * The MetaRecursiveLoop calls `getSignals()` during calibrate() to adjust:
 *   - Model substitution confidence weight
 *   - CCT threshold (if developer keeps rejecting, raise it)
 *   - Soft-block override rate (signals budget misconfiguration)
 *
 * Author: imKrisK — Wave 11 Learning Layer
 */
export type FeedbackAction = 'MODEL_SUB_ACCEPTED' | 'MODEL_SUB_REJECTED' | 'CCT_ACCEPTED' | 'CCT_REJECTED' | 'SOFT_BLOCK_OVERRIDDEN' | 'AGENTIC_CONFIRMED' | 'AGENTIC_CANCELLED' | 'BUDGET_INCREASED' | 'BUDGET_IGNORED';
export interface FeedbackEvent {
    action: FeedbackAction;
    timestamp: string;
    context?: string;
    sessionType?: string;
}
export interface FeedbackSignals {
    /** 0.0–1.0 — higher = developer trusts model substitutions */
    modelSubAcceptRate: number;
    /** 0.0–1.0 — higher = developer accepts CCT compressions */
    cctAcceptRate: number;
    /** 0.0–1.0 — higher = developer overrides blocks frequently */
    softBlockOverrideRate: number;
    /** 0.0–1.0 — higher = agentic sessions confirmed rather than cancelled */
    agenticConfirmRate: number;
    /** Total feedback events recorded */
    totalEvents: number;
    /** Recommendation: whether to loosen or tighten CCT threshold */
    cctThresholdBias: 'loosen' | 'tighten' | 'stable';
    /** Whether model sub confidence should increase/decrease */
    modelSubConfidenceBias: 'increase' | 'decrease' | 'stable';
}
export declare class UserFeedbackCollector {
    private _events;
    record(action: FeedbackAction, context?: string, sessionType?: string): void;
    /** Convenience: record model sub accepted or rejected in one call. */
    recordModelSub(accepted: boolean, fromModel: string, toModel: string): void;
    /** Convenience: record CCT accepted or rejected. */
    recordCCT(accepted: boolean, savingsPct: number, sessionType?: string): void;
    /** Convenience: record agentic gate decision. */
    recordAgentic(confirmed: boolean): void;
    /** Convenience: record soft-block outcome. */
    recordSoftBlock(overridden: boolean): void;
    /** Compute learning signals for MetaRecursiveLoop.calibrate(). */
    getSignals(): FeedbackSignals;
    /** Recent events (last N), newest first. */
    recent(n?: number): FeedbackEvent[];
    get totalEvents(): number;
    save(filePath: string): void;
    load(filePath: string): void;
}
//# sourceMappingURL=UserFeedbackCollector.d.ts.map