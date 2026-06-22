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

import { ModelId } from '../core/types';

export interface ModelPricing {
  modelId:           ModelId;
  inputPer1k:        number;   // USD per 1,000 input tokens
  outputPer1k:       number;   // USD per 1,000 output tokens
  cachedPer1k:       number;   // USD per 1,000 cached tokens (usually discounted)
  maxContextTokens:  number;   // Context window size
  qualityScore:      number;   // 0.0–1.0 relative quality (for routing)
  latencyP50Ms:      number;   // Typical latency in ms (for routing)
}

export const MODEL_PRICING: Record<ModelId, ModelPricing> = {
  [ModelId.CLAUDE_SONNET_4]: {
    modelId:          ModelId.CLAUDE_SONNET_4,
    inputPer1k:       0.003,
    outputPer1k:      0.015,
    cachedPer1k:      0.0003,
    maxContextTokens: 200_000,
    qualityScore:     0.95,
    latencyP50Ms:     2000,
  },
  [ModelId.CLAUDE_HAIKU_3]: {
    modelId:          ModelId.CLAUDE_HAIKU_3,
    inputPer1k:       0.00025,
    outputPer1k:      0.00125,
    cachedPer1k:      0.00003,
    maxContextTokens: 200_000,
    qualityScore:     0.75,
    latencyP50Ms:     800,
  },
  [ModelId.GPT_4O]: {
    modelId:          ModelId.GPT_4O,
    inputPer1k:       0.0025,
    outputPer1k:      0.010,
    cachedPer1k:      0.00125,
    maxContextTokens: 128_000,
    qualityScore:     0.93,
    latencyP50Ms:     1800,
  },
  [ModelId.GPT_4O_MINI]: {
    modelId:          ModelId.GPT_4O_MINI,
    inputPer1k:       0.00015,
    outputPer1k:      0.0006,
    cachedPer1k:      0.000075,
    maxContextTokens: 128_000,
    qualityScore:     0.72,
    latencyP50Ms:     600,
  },
  [ModelId.GEMINI_1_5_PRO]: {
    modelId:          ModelId.GEMINI_1_5_PRO,
    inputPer1k:       0.00125,
    outputPer1k:      0.005,
    cachedPer1k:      0.0003125,
    maxContextTokens: 2_000_000,
    qualityScore:     0.90,
    latencyP50Ms:     2200,
  },
  [ModelId.GEMINI_1_5_FLASH]: {
    modelId:          ModelId.GEMINI_1_5_FLASH,
    inputPer1k:       0.000075,
    outputPer1k:      0.0003,
    cachedPer1k:      0.00001875,
    maxContextTokens: 1_000_000,
    qualityScore:     0.68,
    latencyP50Ms:     500,
  },
  [ModelId.COPILOT_PREMIUM]: {
    modelId:          ModelId.COPILOT_PREMIUM,
    inputPer1k:       0.04,       // $0.04 per premium request (GitHub billing unit)
    outputPer1k:      0.0,        // Bundled into request price
    cachedPer1k:      0.0,
    maxContextTokens: 200_000,
    qualityScore:     0.95,
    latencyP50Ms:     2000,
  },
  [ModelId.COPILOT_STANDARD]: {
    modelId:          ModelId.COPILOT_STANDARD,
    inputPer1k:       0.0,        // Included in subscription — zero marginal cost
    outputPer1k:      0.0,
    cachedPer1k:      0.0,
    maxContextTokens: 128_000,
    qualityScore:     0.80,
    latencyP50Ms:     1200,
  },
  [ModelId.LOCAL]: {
    modelId:          ModelId.LOCAL,
    inputPer1k:       0.0,
    outputPer1k:      0.0,
    cachedPer1k:      0.0,
    maxContextTokens: 32_000,
    qualityScore:     0.55,
    latencyP50Ms:     500,
  },
  [ModelId.UNKNOWN]: {
    modelId:          ModelId.UNKNOWN,
    inputPer1k:       0.0,
    outputPer1k:      0.0,
    cachedPer1k:      0.0,
    maxContextTokens: 0,
    qualityScore:     0.0,
    latencyP50Ms:     0,
  },
};

/**
 * Throttle substitution table — maps premium models to cost-efficient alternatives.
 * Applied by the RTCE when entering THROTTLE state.
 *
 * NOVEL: model-downgrade as a graduated throttle step (not hard stop) has no prior art.
 * Source: Wave 10 Claim 7 / Document 03.
 */
export const THROTTLE_SUBSTITUTION: Partial<Record<ModelId, ModelId>> = {
  [ModelId.CLAUDE_SONNET_4]:  ModelId.CLAUDE_HAIKU_3,    // ~12× cost reduction
  [ModelId.GPT_4O]:           ModelId.GPT_4O_MINI,       // ~17× cost reduction
  [ModelId.GEMINI_1_5_PRO]:   ModelId.GEMINI_1_5_FLASH,  // ~17× cost reduction
  [ModelId.COPILOT_PREMIUM]:  ModelId.COPILOT_STANDARD,  // Free tier fallback
};
