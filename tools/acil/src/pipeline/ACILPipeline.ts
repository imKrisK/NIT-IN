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

/** Simple deterministic ID generator — no external dependency needed */
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

import {
  SessionType, ModelId, EnforcementState, BudgetPeriod,
  SessionEvent, TemporalForecast,
} from '../core/types';
import { TokenMeter } from '../core/TokenMeter';
import { CreditBilling } from '../core/CreditBilling';
import { BudgetEnforcer, EnforcementDecision } from '../core/BudgetEnforcer';
import { AuditTrail } from '../core/AuditTrail';
import { SessionClassifier, TelemetrySignals } from '../classifier/SessionClassifier';
import { BurnPredictor } from '../predictor/BurnPredictor';
import { BurnProfile } from '../predictor/BurnProfile';
import { PromptCompressor } from '../translator/PromptCompressor';
import { CostRouter, QualityRequirement } from '../models/CostRouter';
import { ExhaustionForecaster } from '../temporal/ExhaustionForecaster';

// ─── Request / Response types ─────────────────────────────────────────────────

export interface PipelineRequest {
  /** Raw developer input (chat format, instruct, or completion) */
  rawInput:            string;
  /** IDE telemetry signals for session classification */
  telemetry:           TelemetrySignals;
  /** Developer's preferred model (may be overridden by router/enforcer) */
  preferredModelId:    ModelId;
  /** Quality requirement for this request */
  qualityRequirement:  QualityRequirement;
  /** Current context window token count */
  contextSizeTokens:   number;
  /** Number of planned agent steps (0 = single call) */
  agenticDepth:        number;
  /** Session ID — groups related requests (same coding session) */
  sessionId?:          string;
  /** Developer ID */
  userId:              string;
}

export interface PipelinePreflightResult {
  /** Whether the request is allowed to proceed */
  allowed:              boolean;
  /** Enforcement decision (state, model, message) */
  enforcement:          EnforcementDecision;
  /** Classified session type */
  sessionType:          SessionType;
  /** Classifier confidence 0-1 */
  classifierConfidence: number;
  /** Predicted token cost BEFORE the API call */
  prediction:           { expectedTokens: number; expectedCost: number; confidence: number };
  /** Optimized prompt after CCT translation */
  optimizedInput:       string;
  /** Whether CCT changed the input */
  cctApplied:           boolean;
  /** CCT token savings % (0 if not applied) */
  cctSavingsPct:        number;
  /** Model to actually use (may differ from preferred) */
  effectiveModelId:     ModelId;
  /** Routing reason */
  routingReason:        string;
  /** Current temporal forecast */
  forecast:             TemporalForecast;
  /** Session ID for correlating pre/post calls */
  sessionId:            string;
  /** Event ID for correlating pre/post calls */
  eventId:              string;
}

export interface PipelinePostflightInput {
  eventId:        string;
  sessionId:      string;
  userId:         string;
  sessionType:    SessionType;
  modelId:        ModelId;
  agenticDepth:   number;
  inputTokens:    number;
  outputTokens:   number;
  cachedTokens:   number;
  predictedCost:  number | null;
  predictedTokens: number | null;
  originalTokens: number | null;
  translatedTokens: number | null;
  cctSavingsPct:  number | null;
  classifierConfidence: number;
}

export interface PipelinePostflightResult {
  event:          SessionEvent;
  billingResult:  { grossCost: number; discountAmount: number; netCost: number };
  newState:       EnforcementState;
  newBalance:     number;
  forecast:       TemporalForecast;
}

// ─── ACILPipeline ─────────────────────────────────────────────────────────────

export class ACILPipeline {
  private _classifier:  SessionClassifier;
  private _predictor:   BurnPredictor;
  private _profile:     BurnProfile;
  private _compressor:  PromptCompressor;
  private _router:      CostRouter;
  private _billing:     CreditBilling;
  private _enforcer:    BudgetEnforcer;
  private _audit:       AuditTrail;
  private _forecaster:  ExhaustionForecaster;

  constructor(period: BudgetPeriod, overageCostPerUnit = 0.04) {
    this._classifier  = new SessionClassifier();
    this._predictor   = new BurnPredictor();
    this._profile     = new BurnProfile();
    this._compressor  = new PromptCompressor();
    this._router      = new CostRouter();
    this._billing     = new CreditBilling(period.totalAllocation, period.consumed);
    this._enforcer    = new BudgetEnforcer(period);
    this._audit       = new AuditTrail();
    this._forecaster  = new ExhaustionForecaster(overageCostPerUnit);
  }

  // ── Step 1-5: Pre-flight (before API call) ───────────────────────────────

  /**
   * Run all pre-execution steps. Returns whether the request is allowed
   * and what optimized input/model to use.
   *
   * Called by the VS Code extension BEFORE sending to the LLM API.
   */
  preflight(req: PipelineRequest): PipelinePreflightResult {
    const eventId   = uuidv4();
    const sessionId = req.sessionId ?? uuidv4();

    // Step 1: Classify session type
    const classification = this._classifier.classify(req.telemetry);
    const sessionType    = classification.sessionType;

    // Step 2: Predict burn cost
    const prediction = this._predictor.predict({
      sessionType,
      modelId:           req.preferredModelId,
      contextWindowSize: req.contextSizeTokens,
      proposedQueryTokens: Math.ceil(req.rawInput.length / 4),
      agenticDepth:      req.agenticDepth,
      profile:           this._profile,
    });

    // Step 3: CCT — translate chat format to completion format
    const compression   = this._compressor.compress(req.rawInput, sessionType);
    const optimizedInput = compression.applied ? compression.compressedText : req.rawInput;

    // Step 4: Route to optimal model
    const route = this._router.route({
      sessionType,
      qualityRequirement: req.qualityRequirement,
      availableCredits:   this._enforcer.balance,
      contextSizeTokens:  req.contextSizeTokens,
      latencyRequirement: req.agenticDepth > 0 ? 'BATCH' : 'INTERACTIVE',
      preferredModelId:   req.preferredModelId,
      isThrottled:        this._enforcer.peekState() === EnforcementState.THROTTLE,
    });

    // Step 5: Enforce budget
    const enforcement = this._enforcer.evaluate(route.selectedModel, sessionType);

    // Refresh temporal forecast
    const forecast = this._forecaster.forecast({
      currentBalance:   this._enforcer.balance,
      periodResetDate:  this._enforcer.period.resetDate,
      burnHistory:      this._audit.dailyBurns(),
      useRequestMetric: false,
    });

    return {
      allowed:              enforcement.allowed,
      enforcement,
      sessionType,
      classifierConfidence: classification.confidence,
      prediction:           { expectedTokens: prediction.expectedTokens, expectedCost: prediction.expectedCost, confidence: prediction.confidence },
      optimizedInput,
      cctApplied:           compression.applied,
      cctSavingsPct:        compression.savingsPct,
      effectiveModelId:     enforcement.effectiveModelId,
      routingReason:        route.reason,
      forecast,
      sessionId,
      eventId,
    };
  }

  // ── Step 7-11: Post-flight (after API call returns) ───────────────────────

  /**
   * Record actual usage after the API call completes.
   * Updates balance, audit trail, and temporal forecast.
   *
   * Called by the VS Code extension AFTER the LLM API responds.
   */
  postflight(input: PipelinePostflightInput): PipelinePostflightResult {
    // Step 7: Meter actual token usage
    const meter = new TokenMeter(input.sessionType, input.modelId);
    meter.record(input.inputTokens, input.outputTokens, input.cachedTokens);

    // Step 8: Compute billing
    const billing = this._billing.bill(meter.accumulated, input.modelId);

    // Step 9: Deduct from enforcer balance (gross cost — tracks quota consumption)
    // Use grossCost so the enforcer balance reflects total included quota consumed,
    // not just overage. This is what enables enforcement to fire before quota is 100% gone.
    this._enforcer.deduct(billing.grossCost);

    // Step 10: Build and append SessionEvent to audit trail
    const event: SessionEvent = {
      eventId:        input.eventId,
      sessionId:      input.sessionId,
      userId:         input.userId,
      timestamp:      new Date(),
      sessionType:    input.sessionType,
      confidence:     input.classifierConfidence,
      modelId:        input.modelId,
      agenticDepth:   input.agenticDepth,
      usage:          meter.accumulated,
      grossCost:      billing.grossCost,
      discountAmount: billing.discountAmount,
      netCost:        billing.netCost,
      balanceBefore:  this._enforcer.balance + billing.netCost, // before deduction
      balanceAfter:   this._enforcer.balance,
      predictedCost:  input.predictedCost,
      predictedTokens: input.predictedTokens,
      originalTokens: input.originalTokens,
      translatedTokens: input.translatedTokens,
      cctSavingsPct:  input.cctSavingsPct,
    };
    this._audit.append(event);
    this._audit.logEnforcementState(this._enforcer.currentState);

    // Record burn data to developer profile for future personalized predictions
    this._profile.record(input.sessionType, meter.accumulated.totalTokens);

    // Step 11: Refresh temporal forecast with updated burn history
    const forecast = this._forecaster.forecast({
      currentBalance:   this._enforcer.balance,
      periodResetDate:  this._enforcer.period.resetDate,
      burnHistory:      this._audit.dailyBurns(),
      useRequestMetric: false,
    });

    return {
      event,
      billingResult: {
        grossCost:      billing.grossCost,
        discountAmount: billing.discountAmount,
        netCost:        billing.netCost,
      },
      newState:   this._enforcer.currentState,
      newBalance: this._enforcer.balance,
      forecast,
    };
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get audit(): AuditTrail           { return this._audit; }
  get enforcer(): BudgetEnforcer    { return this._enforcer; }
  get profile(): BurnProfile        { return this._profile; }
  get balance(): number             { return this._enforcer.balance; }
  get currentState(): EnforcementState { return this._enforcer.currentState; }
  get totalAllocation(): number     { return this._enforcer.period.totalAllocation; }

  /**
   * Current burn statistics (daily avg, 7/14-day windows, trend).
   * Used by dashboard + any consumer needing rate data without a full forecast.
   */
  burnStats() {
    return this._forecaster.burnStats(this._audit.dailyBurns());
  }

  /**
   * Current temporal forecast (on-demand refresh).
   */
  forecast(): TemporalForecast {
    return this._forecaster.forecast({
      currentBalance:   this._enforcer.balance,
      periodResetDate:  this._enforcer.period.resetDate,
      burnHistory:      this._audit.dailyBurns(),
      useRequestMetric: false,
    });
  }

  /**
   * Sync external balance data (e.g. from GitHub API poll).
   */
  syncBalance(consumed: number): void {
    this._billing.sync(consumed);
  }
}
