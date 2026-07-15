"use strict";
/**
 * ACIL — TokenMeter
 *
 * Counts and accumulates token consumption per LLM API call.
 * Applies the Intertrust VDE "metering method" pattern (public domain,
 * US5892900A expired 2016, US8291238B2 expired 2018) to LLM inference tokens.
 *
 * Intertrust's disclosed pattern: EVENT → METER → BILLING → BUDGET
 * ACIL applies:  SESSION_EVENT → TOKEN_METER → CREDIT_BILLING → BUDGET_ENFORCER
 *
 * The novel element (Wave 10 Claim 1): session_type is classified BEFORE
 * metering begins, allowing the meter to apply session-type-specific
 * weighting and burn profiles. No prior art meters by pre-classified session type.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenMeter = void 0;
const types_1 = require("./types");
/**
 * Session-type weight multipliers.
 * AGENTIC sessions carry higher metering weight because each agent step
 * compounds context and response size. These values are derived from the
 * inventor's empirical June 2026 usage data.
 *
 * NOVEL: applying session-type multipliers at the metering layer
 * (before billing) has no prior art in LLM tooling.
 */
const SESSION_TYPE_WEIGHT = {
    [types_1.SessionType.AGENTIC]: 4.0, // Each step chains context: very high actual cost
    [types_1.SessionType.ARCHITECTURE]: 2.5, // Deep context, long outputs
    [types_1.SessionType.REVIEW]: 1.5, // Moderate context, analytical output
    [types_1.SessionType.DEBUGGING]: 1.2, // Medium context
    [types_1.SessionType.BOILERPLATE]: 0.8, // Repetitive, compressible
    [types_1.SessionType.DOCUMENTATION]: 0.7, // Low context overhead
    [types_1.SessionType.UNKNOWN]: 1.0, // Neutral
};
class TokenMeter {
    _accumulated = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 };
    _sessionType;
    _modelId;
    constructor(sessionType, modelId) {
        this._sessionType = sessionType;
        this._modelId = modelId;
    }
    /**
     * Record a single API call's token usage.
     * Accumulates into running session totals (Intertrust bitmap accumulator pattern).
     */
    record(input, output, cached = 0) {
        const usage = {
            inputTokens: input,
            outputTokens: output,
            cachedTokens: cached,
            totalTokens: input + output,
        };
        this._accumulated.inputTokens += usage.inputTokens;
        this._accumulated.outputTokens += usage.outputTokens;
        this._accumulated.cachedTokens += usage.cachedTokens;
        this._accumulated.totalTokens += usage.totalTokens;
        const weight = SESSION_TYPE_WEIGHT[this._sessionType];
        const weightedCost = usage.totalTokens * weight;
        return {
            usage,
            sessionType: this._sessionType,
            modelId: this._modelId,
            agenticDepth: 0,
            meteredAt: new Date(),
            weightedCost,
        };
    }
    /** Running session totals (all calls combined). */
    get accumulated() {
        return { ...this._accumulated };
    }
    /** Session-type weight for this meter instance. */
    get weight() {
        return SESSION_TYPE_WEIGHT[this._sessionType];
    }
    /** Reset accumulator (e.g. new session starts). */
    reset() {
        this._accumulated = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 };
    }
    /** Static utility: build a TokenUsage object from raw values. */
    static usage(input, output, cached = 0) {
        return { inputTokens: input, outputTokens: output, cachedTokens: cached, totalTokens: input + output };
    }
}
exports.TokenMeter = TokenMeter;
