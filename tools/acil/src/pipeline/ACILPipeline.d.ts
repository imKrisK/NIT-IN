/**
 * ACIL — Pipeline
 *
 * The main orchestrator. Connects all ACIL components into a single
 * `pipeline.process(request)` call.
 *
 * This is the integration layer that all consumer surfaces (VS Code extension,
 * dashboard API, CLI) call. Every AI API request flows through this pipeline
 * BEFORE it reaches the LLM provider.
 *
 * Flow:
 *   1. SessionClassifier     → classify work type from IDE telemetry
 *   2. BurnPredictor         → estimate token cost before sending
 *   3. PromptCompressor      → CCT: translate chat format → completion format
 *   4. CostRouter            → select optimal model for task
 *   5. BudgetEnforcer        → enforce credit state, block/throttle if needed
 *   6. [API CALL HAPPENS HERE — external]
 *   7. TokenMeter            → meter actual token usage
 *   8. CreditBilling         → compute gross/discount/net cost
 *   9. BudgetEnforcer.deduct → update balance
 *  10. AuditTrail.append     → persist SessionEvent
 *  11. ExhaustionForecaster  → refresh temporal forecast
 *
 * NOVEL: This exact pipeline — pre-execution classification + prediction +
 * translation + routing + graduated enforcement + post-execution metering +
 * temporal forecasting — as a unified system has no prior art.
 */
import { SessionType, ModelId, EnforcementState, BudgetPeriod, SessionEvent, TemporalForecast } from '../core/types';
import { BudgetEnforcer, EnforcementDecision } from '../core/BudgetEnforcer';
import { AuditTrail } from '../core/AuditTrail';
import { TelemetrySignals } from '../classifier/SessionClassifier';
import { BurnProfile } from '../predictor/BurnProfile';
import { QualityRequirement } from '../models/CostRouter';
export interface PipelineRequest {
    /** Raw developer input (chat format, instruct, or completion) */
    rawInput: string;
    /** IDE telemetry signals for session classification */
    telemetry: TelemetrySignals;
    /** Developer's preferred model (may be overridden by router/enforcer) */
    preferredModelId: ModelId;
    /** Quality requirement for this request */
    qualityRequirement: QualityRequirement;
    /** Current context window token count */
    contextSizeTokens: number;
    /** Number of planned agent steps (0 = single call) */
    agenticDepth: number;
    /** Session ID — groups related requests (same coding session) */
    sessionId?: string;
    /** Developer ID */
    userId: string;
}
export interface PipelinePreflightResult {
    /** Whether the request is allowed to proceed */
    allowed: boolean;
    /** Enforcement decision (state, model, message) */
    enforcement: EnforcementDecision;
    /** Classified session type */
    sessionType: SessionType;
    /** Classifier confidence 0-1 */
    classifierConfidence: number;
    /** Predicted token cost BEFORE the API call */
    prediction: {
        expectedTokens: number;
        expectedCost: number;
        confidence: number;
    };
    /** Optimized prompt after CCT translation */
    optimizedInput: string;
    /** Whether CCT changed the input */
    cctApplied: boolean;
    /** CCT token savings % (0 if not applied) */
    cctSavingsPct: number;
    /** Model to actually use (may differ from preferred) */
    effectiveModelId: ModelId;
    /** Routing reason */
    routingReason: string;
    /** Current temporal forecast */
    forecast: TemporalForecast;
    /** Session ID for correlating pre/post calls */
    sessionId: string;
    /** Event ID for correlating pre/post calls */
    eventId: string;
}
export interface PipelinePostflightInput {
    eventId: string;
    sessionId: string;
    userId: string;
    sessionType: SessionType;
    modelId: ModelId;
    agenticDepth: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    predictedCost: number | null;
    predictedTokens: number | null;
    originalTokens: number | null;
    translatedTokens: number | null;
    cctSavingsPct: number | null;
    classifierConfidence: number;
    wasDowngraded?: boolean;
    originalModelId?: ModelId | null;
}
export interface PipelinePostflightResult {
    event: SessionEvent;
    billingResult: {
        grossCost: number;
        discountAmount: number;
        netCost: number;
    };
    newState: EnforcementState;
    newBalance: number;
    forecast: TemporalForecast;
}
export declare class ACILPipeline {
    private _classifier;
    private _predictor;
    private _profile;
    private _compressor;
    private _router;
    private _billing;
    private _enforcer;
    private _audit;
    private _forecaster;
    constructor(period: BudgetPeriod, overageCostPerUnit?: number);
    /**
     * Run all pre-execution steps. Returns whether the request is allowed
     * and what optimized input/model to use.
     *
     * Called by the VS Code extension BEFORE sending to the LLM API.
     */
    preflight(req: PipelineRequest): PipelinePreflightResult;
    /**
     * Record actual usage after the API call completes.
     * Updates balance, audit trail, and temporal forecast.
     *
     * Called by the VS Code extension AFTER the LLM API responds.
     */
    postflight(input: PipelinePostflightInput): PipelinePostflightResult;
    get audit(): AuditTrail;
    get enforcer(): BudgetEnforcer;
    get profile(): BurnProfile;
    get balance(): number;
    get currentState(): EnforcementState;
    get totalAllocation(): number;
    /**
     * Current burn statistics (daily avg, 7/14-day windows, trend).
     * Used by dashboard + any consumer needing rate data without a full forecast.
     */
    burnStats(): import("..").BurnRateResult;
    /**
     * Current temporal forecast (on-demand refresh).
     */
    forecast(): TemporalForecast;
    /**
     * Sync external balance data (e.g. from GitHub API poll).
     */
    syncBalance(consumed: number): void;
}
//# sourceMappingURL=ACILPipeline.d.ts.map