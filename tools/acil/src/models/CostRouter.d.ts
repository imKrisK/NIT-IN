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
export declare enum QualityRequirement {
    DRAFT = "DRAFT",// Quick, rough output acceptable
    STANDARD = "STANDARD",// Normal developer work
    HIGH = "HIGH",// Code review, architecture decisions
    CRITICAL = "CRITICAL"
}
export interface RouteInput {
    sessionType: SessionType;
    qualityRequirement: QualityRequirement;
    availableCredits: number;
    contextSizeTokens: number;
    latencyRequirement: 'INTERACTIVE' | 'BATCH';
    preferredModelId?: ModelId;
    isThrottled: boolean;
}
export interface ModelScore {
    modelId: ModelId;
    qualityScore: number;
    costScore: number;
    latencyScore: number;
    compositeScore: number;
    estimatedCostPer1kTokens: number;
}
export interface RouteResult {
    selectedModel: ModelId;
    wasSubstituted: boolean;
    reason: string;
    scores: ModelScore[];
    estimatedCost: number;
}
export declare class CostRouter {
    /**
     * Select the optimal model for a given request.
     * NOVEL: cost-aware model routing with session-type quality minimums.
     */
    route(input: RouteInput): RouteResult;
    private _estimateCost;
}
//# sourceMappingURL=CostRouter.d.ts.map