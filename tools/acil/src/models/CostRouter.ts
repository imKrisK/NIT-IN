/**
 * ACIL — CostRouter (Cross-Model Cost Router, CMCR)
 *
 * Routes AI requests to the optimal model based on a multi-dimensional
 * scoring function: quality × cost_efficiency × latency.
 *
 * NOVEL CLAIM (Wave 10 Claim 3 + Claim 7):
 * No prior art routes developer AI requests to optimal models based on
 * real-time credit balance, task quality requirements, and per-model pricing.
 *
 * Powered by patent_32 Continuation 1 (Cascade Failure Prediction) blueprint:
 * when primary model is throttled, router activates fallback chain without
 * interrupting the developer session.
 */

import { ModelId, SessionType } from '../core/types';
import { MODEL_PRICING, THROTTLE_SUBSTITUTION } from './PricingConfig';

export enum QualityRequirement {
  DRAFT    = 'DRAFT',     // Quick, rough output acceptable
  STANDARD = 'STANDARD',  // Normal developer work
  HIGH     = 'HIGH',      // Code review, architecture decisions
  CRITICAL = 'CRITICAL',  // Security, production code, patent drafts
}

export interface RouteInput {
  sessionType:        SessionType;
  qualityRequirement: QualityRequirement;
  availableCredits:   number;          // Remaining budget (USD)
  contextSizeTokens:  number;          // Current context window size
  latencyRequirement: 'INTERACTIVE' | 'BATCH';
  preferredModelId?:  ModelId;         // Developer's current selection
  isThrottled:        boolean;         // RTCE currently in THROTTLE state
}

export interface ModelScore {
  modelId:         ModelId;
  qualityScore:    number;
  costScore:       number;             // Inverted cost — higher = cheaper
  latencyScore:    number;
  compositeScore:  number;
  estimatedCostPer1kTokens: number;
}

export interface RouteResult {
  selectedModel:   ModelId;
  wasSubstituted:  boolean;            // true if preferred model was overridden
  reason:          string;
  scores:          ModelScore[];       // All candidate models ranked
  estimatedCost:   number;             // For a ~2K token interaction
}

const QUALITY_WEIGHTS = {
  quality:  0.4,
  cost:     0.4,
  latency:  0.2,
} as const;

// Minimum quality scores required per QualityRequirement
const MIN_QUALITY: Record<QualityRequirement, number> = {
  [QualityRequirement.DRAFT]:    0.0,
  [QualityRequirement.STANDARD]: 0.65,
  [QualityRequirement.HIGH]:     0.80,
  [QualityRequirement.CRITICAL]: 0.90,
};

export class CostRouter {
  /**
   * Select the optimal model for a given request.
   * NOVEL: cost-aware model routing with session-type quality minimums.
   */
  route(input: RouteInput): RouteResult {
    // If throttled, use substitution table first
    if (input.isThrottled && input.preferredModelId) {
      const sub = THROTTLE_SUBSTITUTION[input.preferredModelId];
      if (sub) {
        return {
          selectedModel:  sub,
          wasSubstituted: true,
          reason:         `Throttle: ${input.preferredModelId} → ${sub} (budget protection, transparent downgrade)`,
          scores:         [],
          estimatedCost:  this._estimateCost(sub, 2000),
        };
      }
    }

    // CRITICAL always uses best available model
    if (input.qualityRequirement === QualityRequirement.CRITICAL) {
      const best = input.preferredModelId ?? ModelId.CLAUDE_SONNET_4;
      return {
        selectedModel:  best,
        wasSubstituted: false,
        reason:         'CRITICAL quality: using premium model regardless of cost',
        scores:         [],
        estimatedCost:  this._estimateCost(best, 2000),
      };
    }

    // Score all models
    const minQuality = MIN_QUALITY[input.qualityRequirement];
    const candidates = Object.values(ModelId).filter(id => {
      const p = MODEL_PRICING[id];
      return (
        p.qualityScore >= minQuality &&
        p.maxContextTokens >= input.contextSizeTokens &&
        id !== ModelId.UNKNOWN
      );
    });

    if (candidates.length === 0) {
      return {
        selectedModel:  ModelId.COPILOT_STANDARD,
        wasSubstituted: true,
        reason:         'No qualifying models found — fallback to standard',
        scores:         [],
        estimatedCost:  0,
      };
    }

    // Compute composite scores
    const maxCost = Math.max(...candidates.map(id => {
      const p = MODEL_PRICING[id];
      return (p.inputPer1k + p.outputPer1k);
    }));
    const maxLatency = Math.max(...candidates.map(id => MODEL_PRICING[id].latencyP50Ms));

    const scored: ModelScore[] = candidates.map(id => {
      const p = MODEL_PRICING[id];
      const totalCostPer1k = p.inputPer1k + p.outputPer1k;
      const costScore    = maxCost > 0 ? 1 - (totalCostPer1k / maxCost) : 1.0;
      const latencyScore = maxLatency > 0 ? 1 - (p.latencyP50Ms / maxLatency) : 1.0;
      const composite    =
        p.qualityScore * QUALITY_WEIGHTS.quality +
        costScore      * QUALITY_WEIGHTS.cost    +
        latencyScore   * QUALITY_WEIGHTS.latency;

      return {
        modelId:                  id,
        qualityScore:             p.qualityScore,
        costScore,
        latencyScore,
        compositeScore:           Math.round(composite * 1000) / 1000,
        estimatedCostPer1kTokens: totalCostPer1k,
      };
    }).sort((a, b) => b.compositeScore - a.compositeScore);

    const selected = scored[0];
    const wasSubstituted = !!(input.preferredModelId && selected.modelId !== input.preferredModelId);

    return {
      selectedModel:  selected.modelId,
      wasSubstituted,
      reason:         wasSubstituted
        ? `Routed to ${selected.modelId} (score ${selected.compositeScore}) over preferred ${input.preferredModelId}`
        : `Optimal model: ${selected.modelId} (score ${selected.compositeScore})`,
      scores:         scored,
      estimatedCost:  this._estimateCost(selected.modelId, 2000),
    };
  }

  private _estimateCost(modelId: ModelId, totalTokens: number): number {
    const p = MODEL_PRICING[modelId];
    const input  = totalTokens * 0.3;
    const output = totalTokens * 0.7;
    return Math.round(((input / 1000) * p.inputPer1k + (output / 1000) * p.outputPer1k) * 10000) / 10000;
  }
}
