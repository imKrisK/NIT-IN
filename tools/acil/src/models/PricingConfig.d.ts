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
    modelId: ModelId;
    inputPer1k: number;
    outputPer1k: number;
    cachedPer1k: number;
    maxContextTokens: number;
    qualityScore: number;
    latencyP50Ms: number;
}
export declare const MODEL_PRICING: Record<ModelId, ModelPricing>;
/**
 * Throttle substitution table — maps premium models to cost-efficient alternatives.
 * Applied by the RTCE when entering THROTTLE state.
 *
 * NOVEL: model-downgrade as a graduated throttle step (not hard stop) has no prior art.
 * Source: Wave 10 Claim 7 / Document 03.
 */
export declare const THROTTLE_SUBSTITUTION: Partial<Record<ModelId, ModelId>>;
//# sourceMappingURL=PricingConfig.d.ts.map