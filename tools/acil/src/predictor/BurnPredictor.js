"use strict";
/**
 * ACIL — BurnPredictor
 *
 * Pre-Execution Burn Rate Predictor (PEBP).
 * Estimates token consumption and cost BEFORE an AI API call is made.
 *
 * NOVEL CLAIM (Wave 10 Claim 2 + Claim 6):
 * No prior art predicts LLM session token consumption before the API call
 * is transmitted. This is fundamentally different from post-execution reporting.
 *
 * The prediction runs in <50ms and is displayed in the VS Code status bar
 * as a pre-flight cost estimate before the developer confirms a request.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BurnPredictor = void 0;
const PricingConfig_1 = require("../models/PricingConfig");
class BurnPredictor {
    /**
     * Context window multiplier: larger context → model generates longer responses.
     * Empirical: every 10K tokens of context adds ~8% to expected output length.
     */
    _contextMultiplier(contextTokens) {
        return 1.0 + Math.min(2.0, (contextTokens / 10_000) * 0.08);
    }
    /**
     * Agentic depth multiplier: each agent step compounds context size.
     * Empirical: each step adds ~2-3× the single-call cost in accumulated context.
     * Wave 10 Claim 6: agentic_depth multiplier applied per step.
     */
    _agenticMultiplier(depth) {
        if (depth === 0)
            return 1.0;
        // Geometric growth: depth 1=2x, depth 2=3.5x, depth 5=10x, depth 10=25x
        return 1.0 + depth * (1.0 + depth * 0.15);
    }
    /**
     * Predict token consumption and cost for a proposed interaction.
     * Called BEFORE the API call is transmitted.
     */
    predict(input) {
        const baseline = input.profile.getBaseline(input.sessionType);
        const pricing = PricingConfig_1.MODEL_PRICING[input.modelId];
        const ctxMult = this._contextMultiplier(input.contextWindowSize);
        const agentMult = this._agenticMultiplier(input.agenticDepth);
        const combined = ctxMult * agentMult;
        const expectedTokens = Math.round((baseline.avgTokens + input.proposedQueryTokens) * combined);
        const minTokens = Math.round((baseline.minTokens + input.proposedQueryTokens) * ctxMult);
        const maxTokens = Math.round((baseline.p95Tokens + input.proposedQueryTokens) * combined * 1.2);
        // Assume ~30% input, ~70% output split (typical LLM interaction)
        const estimatedInput = Math.round(expectedTokens * 0.3);
        const estimatedOutput = Math.round(expectedTokens * 0.7);
        const expectedCost = (estimatedInput / 1000) * pricing.inputPer1k +
            (estimatedOutput / 1000) * pricing.outputPer1k;
        // Confidence degrades with high agentic depth (unpredictable chains)
        const confidence = Math.max(0.3, 0.90 - input.agenticDepth * 0.08);
        return {
            expectedTokens,
            minTokens,
            maxTokens,
            expectedCost: Math.round(expectedCost * 10000) / 10000,
            confidence,
            timeToExhaustion: null, // Caller injects balance context if needed
        };
    }
}
exports.BurnPredictor = BurnPredictor;
