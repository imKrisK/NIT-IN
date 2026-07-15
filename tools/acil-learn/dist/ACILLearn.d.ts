/**
 * @nit-in/acil-learn — ACILLearn
 *
 * Framework-agnostic wrapper around MetaRecursiveLoop + DeveloperPatternIdentifier.
 * Designed for embedding in any Node.js AI tooling product:
 *
 *   - JetBrains plugin (Kotlin JVM calls Node.js sidecar)
 *   - Neovim LSP adapter
 *   - CI/CD pipeline cost gate
 *   - Custom LLM proxy (Nginx module → Node sidecar)
 *   - CLI tools (e.g. `llm-run` wrappers)
 *
 * Author: imKrisK — Wave 11 Patent Claim 1 (Meta-Recursive Session Calibration Loop)
 */
import type { RecursivePrediction, ArchetypeProfile, SessionType, ModelId } from '@nit-in/acil';
export interface LearnConfig {
    /** Directory to persist outcomes and archetype state. Default: '.acil-learn' */
    storagePath?: string;
    /** Monthly token credit budget in USD. Default: 39.00 */
    monthlyBudget?: number;
    /** Model to use for cost calculations. Default: 'copilot-premium' */
    defaultModel?: ModelId;
    /** Developer identifier (for multi-developer deployments). Default: os.hostname() */
    developerId?: string;
}
export interface PredictInput {
    /** Estimated input tokens for the upcoming request */
    tokenEstimate: number;
    /** Known session type (if determinable pre-request). Omit for auto-classify. */
    sessionType?: SessionType;
    /** Current time (defaults to now) — used for calendar weighting */
    now?: Date;
}
export interface PredictOutput {
    /** Unique ID for this prediction — pass back to record() to close the loop */
    predictionId: string;
    /** Recommended CCT compression threshold for this request */
    adaptedCCTThreshold: number;
    /** Burn rate multiplier adjusted for developer archetype */
    adaptedTSPMultiplier: number;
    /** Predicted cost in USD */
    estimatedCostUsd: number;
    /** Developer archetype derived from history */
    archetype: ArchetypeProfile | null;
    /** Pre-classified session type */
    predictedSessionType: SessionType;
    /** Loop calibration generation count */
    generation: number;
    /** Raw recursive prediction (full details) */
    raw: RecursivePrediction;
}
export interface RecordInput {
    /** Must match the predictionId returned by predict() */
    predictionId: string;
    /** Actual cost of the completed request in USD */
    actualCost: number;
    /** Actual token count used */
    actualTokens: number;
    /** Whether CCT compression was applied */
    cctApplied: boolean;
    /** Semantic similarity score if CCT was evaluated (0.0–1.0) */
    semanticScore?: number;
    /** Actual session type (if different from prediction) */
    actualSessionType?: SessionType;
}
export declare class ACILLearn {
    private _config;
    private _pipeline;
    private _loop;
    private _audit;
    private _pending;
    constructor(config?: LearnConfig);
    /**
     * Load persisted state from storagePath.
     * Call once at startup before any predict() calls.
     */
    load(): Promise<void>;
    /**
     * Persist state to storagePath.
     * Call at shutdown and periodically (every N requests).
     */
    save(): Promise<void>;
    /**
     * Generate a pre-execution prediction.
     * Returns adapted thresholds and archetype before any tokens are spent.
     */
    predict(input: PredictInput): Promise<PredictOutput>;
    /**
     * Record the actual outcome of a completed LLM request.
     * Closes the feedback loop — improves next predict() accuracy.
     */
    record(input: RecordInput): void;
    /**
     * Identify the current developer archetype from audit history.
     * Useful for displaying in dashboards without running a full predict().
     */
    identifyArchetype(): ArchetypeProfile | null;
    /** Fluent config accessor. */
    get config(): Readonly<Required<LearnConfig>>;
    private _storagePath;
    private _ensureStorageDir;
}
//# sourceMappingURL=ACILLearn.d.ts.map