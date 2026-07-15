/**
 * ACIL — SessionClassifier
 *
 * Rule-based v1 Session-Type Classifier (STC).
 * Classifies an active developer session into a cost-relevant SessionType
 * BEFORE any AI API call is made.
 *
 * NOVEL CLAIM (Wave 10 Claim 1 + Claim 2):
 * No prior art classifies developer IDE sessions by work type before
 * token consumption begins. This is the anchor claim of the ACIL patent.
 *
 * Phase 1 implementation: rule-based (no ML required for MVP + filing).
 * Phase 1+ (post-filing): replace with fine-tuned classifier model.
 *
 * Signal inputs (from IDE telemetry stream):
 *   - fileChanges:        files opened/modified in current window
 *   - queryText:          developer's natural language input
 *   - toolCallSignatures: detected agent tool invocations
 *   - contextRatio:       fraction of context that is new query vs. existing code
 *   - newFileCount:       files created (not modified) in this session
 *   - errorContext:       presence of stack traces, error messages in context
 */
import { SessionType } from '../core/types';
export interface TelemetrySignals {
    queryText: string;
    toolCallSignatures: string[];
    newFileCount: number;
    modifiedFileCount: number;
    contextRatio: number;
    hasErrorContext: boolean;
    existingFileSimilarity: number;
}
export interface ClassificationResult {
    sessionType: SessionType;
    confidence: number;
    signals: string[];
}
export declare class SessionClassifier {
    /**
     * Classify a session from telemetry signals.
     * Returns the most likely SessionType and a confidence score.
     *
     * Decision priority (highest to lowest):
     *   1. AGENTIC  — tool call signatures detected
     *   2. ARCHITECTURE — new files + design keywords
     *   3. DEBUGGING — error context present
     *   4. DOCUMENTATION — documentation keywords
     *   5. BOILERPLATE — high file similarity to existing
     *   6. REVIEW — high existing-code context ratio, no errors
     */
    classify(signals: TelemetrySignals): ClassificationResult;
    private _containsAny;
}
//# sourceMappingURL=SessionClassifier.d.ts.map