/**
 * ACIL — MetaRecursiveLoop
 *
 * The self-calibrating intelligence layer. ACIL analyzing its own data
 * to rewrite its own compression rules, burn rate multipliers, and
 * session classifications — BEFORE each new prompt is sent.
 *
 * ═══════════════════════════════════════════════════════════════
 * CONCEPT: Reverse-engineered from Patent 29 (Meta-Recursive Learning)
 * Applied to: CCT + TSP + ACIL pipeline
 * Author: imKrisK (@imKrisK · github.com/imKrisK)
 * Patent: Wave 11 — Meta-Recursive ACIL Calibration
 * ═══════════════════════════════════════════════════════════════
 *
 * The Loop (runs BEFORE every preflight):
 *
 *   1. OBSERVE — collect live session data (AuditTrail events)
 *   2. IDENTIFY — classify developer archetype (DeveloperPatternIdentifier)
 *   3. PREDICT — forecast next session type + cost BEFORE token burn
 *   4. ADAPT — rewrite CCT threshold + TSP multiplier based on archetype
 *   5. PRE-CLASSIFY — feed prediction into SessionClassifier as a prior
 *   6. TRANSMIT — the adapted pipeline processes the request
 *   7. RECORD — postflight updates the loop with actual outcome
 *   8. → REPEAT (continuous)
 *
 * This is Wave 10 Claim 2 (pre-execution prediction) made recursive:
 * the prediction model itself is updated by its own prediction accuracy.
 *
 * Wave 11 Claim Structure (preview):
 *   - Claim 1: Meta-recursive session calibration loop
 *   - Claim 2: Developer archetype identification from request history
 *   - Claim 3: CCT threshold dynamic adjustment per archetype
 *   - Claim 4: TSP multiplier live rewriting per developer pattern
 *   - Claim 5: Prediction accuracy tracking (predicted vs actual)
 *
 * ═══════════════════════════════════════════════════════════════
 * TEMPORAL PREDICTION (per patent_29 reverse engineering):
 *
 * After 7 days of ACIL usage, the MetaRecursiveLoop accumulates enough
 * signal to identify the developer archetype with >80% confidence.
 * At that point, ACIL's pre-execution cost predictions should be within
 * 15% of actual — compared to 30-40% error for fresh installs.
 *
 * Compounding effect: each loop iteration improves the next prediction.
 * This is the "recursive self-improvement" from patent_29 applied to
 * token credit governance.
 * ═══════════════════════════════════════════════════════════════
 */
import { SessionType } from '../core/types';
import { ArchetypeProfile } from '../predictor/DeveloperPatternIdentifier';
import { AuditTrail } from '../core/AuditTrail';
import { UserFeedbackCollector } from '../feedback/UserFeedbackCollector';
export interface RecursivePrediction {
    /** Archetype derived from historical patterns */
    developerArchetype: ArchetypeProfile | null;
    /** Pre-classified session type (before developer types anything) */
    preClassifiedSession: SessionType;
    /** Predicted token cost for the NEXT request ($) */
    nextRequestCostEst: number;
    /** Adjusted CCT threshold (0.0–1.0) for this developer's pattern */
    adaptedCCTThreshold: number;
    /** Adjusted TSP multiplier for this developer's burn rate */
    adaptedTSPMultiplier: number;
    /** Accuracy of previous predictions (0.0–1.0, null if <5 data points) */
    predictionAccuracy: number | null;
    /** Calibration generation — how many times the loop has run */
    generation: number;
    /** Timestamp of this calibration */
    calibratedAt: Date;
}
export interface LoopOutcome {
    predictedCost: number;
    actualCost: number;
    predictedType: SessionType;
    actualType: SessionType;
    timestamp: Date;
}
export declare class MetaRecursiveLoop {
    private _identifier;
    private _generation;
    private _outcomes;
    private _lastProfile;
    private _feedback;
    private _lastCalibrated;
    private _lastPrediction;
    private static readonly CACHE_TTL_MS;
    constructor(feedback?: UserFeedbackCollector);
    /** Attach or replace the feedback collector (can be set after construction). */
    setFeedback(feedback: UserFeedbackCollector): void;
    /**
     * Run the meta-recursive calibration loop.
     * TTL-cached: returns the last result if called within 60 seconds.
     * Prevents double-calibrate from /status + preflight on the same request.
     */
    calibrate(audit: AuditTrail): RecursivePrediction;
    /**
     * Record the actual outcome after a session completes.
     * This is the feedback that closes the loop — actual vs predicted.
     * Each call to recordOutcome() improves the NEXT calibration.
     */
    recordOutcome(outcome: LoopOutcome): void;
    /**
     * Generate a human-readable calibration report.
     * Shown in @acil /status and the dashboard.
     */
    report(): string;
    get lastProfile(): ArchetypeProfile | null;
    get generation(): number;
    /**
     * Persist prediction outcomes to disk (atomic write).
     * Call on VS Code deactivate() alongside audit.save().
     */
    save(filePath: string): void;
    /**
     * Load persisted outcomes from previous VS Code session.
     * Silent no-op if file doesn't exist (first run).
     */
    load(filePath: string): void;
    /**
     * Adapt CCT compression threshold to match developer's session type.
     * AGENT_HEAVY developers get more aggressive CCT (lower threshold = more compression).
     * CODE_REVIEWERS get conservative CCT (higher threshold = less compression).
     */
    private _adaptCCTThreshold;
    /**
     * Compute prediction accuracy from recorded outcomes.
     * Accuracy = fraction of sessions where predicted type matched actual type
     * AND predicted cost was within 20% of actual cost.
     */
    private _computeAccuracy;
}
//# sourceMappingURL=MetaRecursiveLoop.d.ts.map