/**
 * ACIL — BurnProfile
 *
 * Per-developer historical token consumption profiles by session type.
 * Seeded with empirical baselines; calibrates to individual behavior over time.
 *
 * Used by BurnPredictor to personalize burn estimates.
 * The June 2026 imKrisK data provides the initial empirical baseline for AGENTIC:
 *   528 requests in 1 day = ~528 premium requests / ~6 hrs = 88 req/hr active session
 */
import { SessionType } from '../core/types';
export interface SessionBurnBaseline {
    minTokens: number;
    maxTokens: number;
    avgTokens: number;
    p95Tokens: number;
}
/**
 * Global empirical baselines (tokens per session).
 * Source: research data + inventor's June 2026 usage analysis.
 */
export declare const BASELINE_BURN_PROFILES: {
    AGENTIC: {
        minTokens: number;
        maxTokens: number;
        avgTokens: number;
        p95Tokens: number;
    };
    ARCHITECTURE: {
        minTokens: number;
        maxTokens: number;
        avgTokens: number;
        p95Tokens: number;
    };
    REVIEW: {
        minTokens: number;
        maxTokens: number;
        avgTokens: number;
        p95Tokens: number;
    };
    DEBUGGING: {
        minTokens: number;
        maxTokens: number;
        avgTokens: number;
        p95Tokens: number;
    };
    BOILERPLATE: {
        minTokens: number;
        maxTokens: number;
        avgTokens: number;
        p95Tokens: number;
    };
    DOCUMENTATION: {
        minTokens: number;
        maxTokens: number;
        avgTokens: number;
        p95Tokens: number;
    };
    UNKNOWN: {
        minTokens: number;
        maxTokens: number;
        avgTokens: number;
        p95Tokens: number;
    };
};
export declare class BurnProfile {
    private _observed;
    /**
     * Record an observed token count for a session type.
     * Grows the personal calibration dataset over time.
     */
    record(sessionType: SessionType, tokens: number): void;
    /**
     * Returns a personalized baseline for a session type.
     * Falls back to global baseline until enough personal data exists (min 5 samples).
     */
    getBaseline(sessionType: SessionType): SessionBurnBaseline;
    get observedCount(): Partial<Record<SessionType, number>>;
    /**
     * Persist personal calibration data to disk.
     * Atomic write (tmp → rename). Creates directory if needed.
     * Wave 10 Claim 2: developer-specific burn profile survives restarts.
     */
    save(filePath: string): void;
    /**
     * Load personal calibration data from disk.
     * Merges with any existing in-memory samples (no duplicates, just appends).
     * Silent no-op if file doesn't exist (first run).
     */
    load(filePath: string): void;
}
//# sourceMappingURL=BurnProfile.d.ts.map