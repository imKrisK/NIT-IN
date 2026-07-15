"use strict";
/**
 * ACIL — PricingConfig
 *
 * Per-model token pricing table.
 * Prices in USD per 1,000 tokens (input / output / cached).
 * Source: published API pricing as of June 2026.
 *
 * This table is the foundation of the Cross-Model Cost Router (CMCR).
 * NOVEL: applying real-time per-model pricing to session-type-classified
 * events and routing to optimal model has no prior art.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.THROTTLE_SUBSTITUTION = exports.MODEL_PRICING = void 0;
const types_1 = require("../core/types");
exports.MODEL_PRICING = {
    [types_1.ModelId.CLAUDE_SONNET_4]: {
        modelId: types_1.ModelId.CLAUDE_SONNET_4,
        inputPer1k: 0.003,
        outputPer1k: 0.015,
        cachedPer1k: 0.0003,
        maxContextTokens: 200_000,
        qualityScore: 0.95,
        latencyP50Ms: 2000,
    },
    [types_1.ModelId.CLAUDE_HAIKU_3]: {
        modelId: types_1.ModelId.CLAUDE_HAIKU_3,
        inputPer1k: 0.00025,
        outputPer1k: 0.00125,
        cachedPer1k: 0.00003,
        maxContextTokens: 200_000,
        qualityScore: 0.75,
        latencyP50Ms: 800,
    },
    [types_1.ModelId.GPT_4O]: {
        modelId: types_1.ModelId.GPT_4O,
        inputPer1k: 0.0025,
        outputPer1k: 0.010,
        cachedPer1k: 0.00125,
        maxContextTokens: 128_000,
        qualityScore: 0.93,
        latencyP50Ms: 1800,
    },
    [types_1.ModelId.GPT_4O_MINI]: {
        modelId: types_1.ModelId.GPT_4O_MINI,
        inputPer1k: 0.00015,
        outputPer1k: 0.0006,
        cachedPer1k: 0.000075,
        maxContextTokens: 128_000,
        qualityScore: 0.72,
        latencyP50Ms: 600,
    },
    [types_1.ModelId.GEMINI_1_5_PRO]: {
        modelId: types_1.ModelId.GEMINI_1_5_PRO,
        inputPer1k: 0.00125,
        outputPer1k: 0.005,
        cachedPer1k: 0.0003125,
        maxContextTokens: 2_000_000,
        qualityScore: 0.90,
        latencyP50Ms: 2200,
    },
    [types_1.ModelId.GEMINI_1_5_FLASH]: {
        modelId: types_1.ModelId.GEMINI_1_5_FLASH,
        inputPer1k: 0.000075,
        outputPer1k: 0.0003,
        cachedPer1k: 0.00001875,
        maxContextTokens: 1_000_000,
        qualityScore: 0.68,
        latencyP50Ms: 500,
    },
    [types_1.ModelId.COPILOT_PREMIUM]: {
        modelId: types_1.ModelId.COPILOT_PREMIUM,
        inputPer1k: 0.04, // $0.04 per premium request (GitHub billing unit)
        outputPer1k: 0.0, // Bundled into request price
        cachedPer1k: 0.0,
        maxContextTokens: 200_000,
        qualityScore: 0.95,
        latencyP50Ms: 2000,
    },
    [types_1.ModelId.COPILOT_STANDARD]: {
        modelId: types_1.ModelId.COPILOT_STANDARD,
        inputPer1k: 0.0, // Included in subscription — zero marginal cost
        outputPer1k: 0.0,
        cachedPer1k: 0.0,
        maxContextTokens: 128_000,
        qualityScore: 0.80,
        latencyP50Ms: 1200,
    },
    [types_1.ModelId.LOCAL]: {
        modelId: types_1.ModelId.LOCAL,
        inputPer1k: 0.0,
        outputPer1k: 0.0,
        cachedPer1k: 0.0,
        maxContextTokens: 32_000,
        qualityScore: 0.55,
        latencyP50Ms: 500,
    },
    [types_1.ModelId.UNKNOWN]: {
        modelId: types_1.ModelId.UNKNOWN,
        inputPer1k: 0.0,
        outputPer1k: 0.0,
        cachedPer1k: 0.0,
        maxContextTokens: 0,
        qualityScore: 0.0,
        latencyP50Ms: 0,
    },
};
/**
 * Throttle substitution table — maps premium models to cost-efficient alternatives.
 * Applied by the RTCE when entering THROTTLE state.
 *
 * NOVEL: model-downgrade as a graduated throttle step (not hard stop) has no prior art.
 * Source: Wave 10 Claim 7 / Document 03.
 */
exports.THROTTLE_SUBSTITUTION = {
    [types_1.ModelId.CLAUDE_SONNET_4]: types_1.ModelId.CLAUDE_HAIKU_3, // ~12× cost reduction
    [types_1.ModelId.GPT_4O]: types_1.ModelId.GPT_4O_MINI, // ~17× cost reduction
    [types_1.ModelId.GEMINI_1_5_PRO]: types_1.ModelId.GEMINI_1_5_FLASH, // ~17× cost reduction
    [types_1.ModelId.COPILOT_PREMIUM]: types_1.ModelId.COPILOT_STANDARD, // Free tier fallback
};
