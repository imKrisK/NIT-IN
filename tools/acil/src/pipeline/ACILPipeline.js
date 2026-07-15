"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACILPipeline = void 0;
/** Simple deterministic ID generator — no external dependency needed */
function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}
const types_1 = require("../core/types");
const TokenMeter_1 = require("../core/TokenMeter");
const CreditBilling_1 = require("../core/CreditBilling");
const BudgetEnforcer_1 = require("../core/BudgetEnforcer");
const AuditTrail_1 = require("../core/AuditTrail");
const SessionClassifier_1 = require("../classifier/SessionClassifier");
const BurnPredictor_1 = require("../predictor/BurnPredictor");
const BurnProfile_1 = require("../predictor/BurnProfile");
const PromptCompressor_1 = require("../translator/PromptCompressor");
const CostRouter_1 = require("../models/CostRouter");
const ExhaustionForecaster_1 = require("../temporal/ExhaustionForecaster");
// ─── ACILPipeline ─────────────────────────────────────────────────────────────
class ACILPipeline {
    _classifier;
    _predictor;
    _profile;
    _compressor;
    _router;
    _billing;
    _enforcer;
    _audit;
    _forecaster;
    constructor(period, overageCostPerUnit = 0.04) {
        this._classifier = new SessionClassifier_1.SessionClassifier();
        this._predictor = new BurnPredictor_1.BurnPredictor();
        this._profile = new BurnProfile_1.BurnProfile();
        this._compressor = new PromptCompressor_1.PromptCompressor();
        this._router = new CostRouter_1.CostRouter();
        this._billing = new CreditBilling_1.CreditBilling(period.totalAllocation, period.consumed);
        this._enforcer = new BudgetEnforcer_1.BudgetEnforcer(period);
        this._audit = new AuditTrail_1.AuditTrail();
        this._forecaster = new ExhaustionForecaster_1.ExhaustionForecaster(overageCostPerUnit);
    }
    // ── Step 1-5: Pre-flight (before API call) ───────────────────────────────
    /**
     * Run all pre-execution steps. Returns whether the request is allowed
     * and what optimized input/model to use.
     *
     * Called by the VS Code extension BEFORE sending to the LLM API.
     */
    preflight(req) {
        const eventId = uuidv4();
        const sessionId = req.sessionId ?? uuidv4();
        // Step 1: Classify session type
        const classification = this._classifier.classify(req.telemetry);
        const sessionType = classification.sessionType;
        // Step 2: Predict burn cost
        const prediction = this._predictor.predict({
            sessionType,
            modelId: req.preferredModelId,
            contextWindowSize: req.contextSizeTokens,
            proposedQueryTokens: Math.ceil(req.rawInput.length / 4),
            agenticDepth: req.agenticDepth,
            profile: this._profile,
        });
        // Step 3: CCT — translate chat format to completion format
        const compression = this._compressor.compress(req.rawInput, sessionType);
        const optimizedInput = compression.applied ? compression.compressedText : req.rawInput;
        // Step 4: Route to optimal model
        const route = this._router.route({
            sessionType,
            qualityRequirement: req.qualityRequirement,
            availableCredits: this._enforcer.balance,
            contextSizeTokens: req.contextSizeTokens,
            latencyRequirement: req.agenticDepth > 0 ? 'BATCH' : 'INTERACTIVE',
            preferredModelId: req.preferredModelId,
            isThrottled: this._enforcer.peekState() === types_1.EnforcementState.THROTTLE,
        });
        // Step 5: Enforce budget
        const enforcement = this._enforcer.evaluate(route.selectedModel, sessionType);
        // Refresh temporal forecast
        const forecast = this._forecaster.forecast({
            currentBalance: this._enforcer.balance,
            periodResetDate: this._enforcer.period.resetDate,
            burnHistory: this._audit.dailyBurns(),
            useRequestMetric: false,
        });
        return {
            allowed: enforcement.allowed,
            enforcement,
            sessionType,
            classifierConfidence: classification.confidence,
            prediction: { expectedTokens: prediction.expectedTokens, expectedCost: prediction.expectedCost, confidence: prediction.confidence },
            optimizedInput,
            cctApplied: compression.applied,
            cctSavingsPct: compression.savingsPct,
            effectiveModelId: enforcement.effectiveModelId,
            routingReason: route.reason,
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
    postflight(input) {
        // Step 7: Meter actual token usage
        const meter = new TokenMeter_1.TokenMeter(input.sessionType, input.modelId);
        meter.record(input.inputTokens, input.outputTokens, input.cachedTokens);
        // Step 8: Compute billing
        const billing = this._billing.bill(meter.accumulated, input.modelId);
        // Step 9: Deduct from enforcer balance (gross cost — tracks quota consumption)
        // Use grossCost so the enforcer balance reflects total included quota consumed,
        // not just overage. This is what enables enforcement to fire before quota is 100% gone.
        this._enforcer.deduct(billing.grossCost);
        // Step 10: Build and append SessionEvent to audit trail
        const event = {
            eventId: input.eventId,
            sessionId: input.sessionId,
            userId: input.userId,
            timestamp: new Date(),
            sessionType: input.sessionType,
            confidence: input.classifierConfidence,
            modelId: input.modelId,
            agenticDepth: input.agenticDepth,
            usage: meter.accumulated,
            grossCost: billing.grossCost,
            discountAmount: billing.discountAmount,
            netCost: billing.netCost,
            balanceBefore: this._enforcer.balance + billing.netCost, // before deduction
            balanceAfter: this._enforcer.balance,
            predictedCost: input.predictedCost,
            predictedTokens: input.predictedTokens,
            originalTokens: input.originalTokens,
            translatedTokens: input.translatedTokens,
            cctSavingsPct: input.cctSavingsPct,
            // Model substitution tracking — Wave 10 Claim 7
            wasDowngraded: input.wasDowngraded,
            originalModelId: input.originalModelId,
            substitutionSavingsUsd: input.wasDowngraded && input.originalModelId
                ? (() => {
                    const origBilling = this._billing.bill(meter.accumulated, input.originalModelId);
                    return Math.max(0, origBilling.grossCost - billing.grossCost);
                })()
                : null,
        };
        this._audit.append(event);
        this._audit.logEnforcementState(this._enforcer.currentState);
        // Record burn data to developer profile for future personalized predictions
        this._profile.record(input.sessionType, meter.accumulated.totalTokens);
        // Step 11: Refresh temporal forecast with updated burn history
        const forecast = this._forecaster.forecast({
            currentBalance: this._enforcer.balance,
            periodResetDate: this._enforcer.period.resetDate,
            burnHistory: this._audit.dailyBurns(),
            useRequestMetric: false,
        });
        return {
            event,
            billingResult: {
                grossCost: billing.grossCost,
                discountAmount: billing.discountAmount,
                netCost: billing.netCost,
            },
            newState: this._enforcer.currentState,
            newBalance: this._enforcer.balance,
            forecast,
        };
    }
    // ── Accessors ─────────────────────────────────────────────────────────────
    get audit() { return this._audit; }
    get enforcer() { return this._enforcer; }
    get profile() { return this._profile; }
    get balance() { return this._enforcer.balance; }
    get currentState() { return this._enforcer.currentState; }
    get totalAllocation() { return this._enforcer.period.totalAllocation; }
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
    forecast() {
        return this._forecaster.forecast({
            currentBalance: this._enforcer.balance,
            periodResetDate: this._enforcer.period.resetDate,
            burnHistory: this._audit.dailyBurns(),
            useRequestMetric: false,
        });
    }
    /**
     * Sync external balance data (e.g. from GitHub API poll).
     */
    syncBalance(consumed) {
        this._billing.sync(consumed);
    }
}
exports.ACILPipeline = ACILPipeline;
