/**
 * ACIL — Public API
 * AI Credit Intelligence Layer — Phase 0-6 Exports
 */

// Core types
export * from './core/types';

// Phase 0 — Metering Engine
export { TokenMeter }       from './core/TokenMeter';
export { CreditBilling }    from './core/CreditBilling';
export { BudgetEnforcer }   from './core/BudgetEnforcer';
export { AuditTrail }       from './core/AuditTrail';
export type { MeterResult }        from './core/TokenMeter';
export type { BillingResult }      from './core/CreditBilling';
export type { EnforcementDecision } from './core/BudgetEnforcer';
export type { DailyBurnRecord, AuditSummary } from './core/AuditTrail';

// Model pricing and routing config
export { MODEL_PRICING, THROTTLE_SUBSTITUTION } from './models/PricingConfig';
export type { ModelPricing } from './models/PricingConfig';

// Phase 3/4 — Cost Router (CMCR)
export { CostRouter, QualityRequirement } from './models/CostRouter';
export type { RouteInput, RouteResult, ModelScore } from './models/CostRouter';

// Phase 4 — Pipeline Orchestrator
export { ACILPipeline } from './pipeline/ACILPipeline';
export { MetaRecursiveLoop } from './pipeline/MetaRecursiveLoop';
export type { RecursivePrediction, LoopOutcome } from './pipeline/MetaRecursiveLoop';
export type {
  PipelineRequest,
  PipelinePreflightResult,
  PipelinePostflightInput,
  PipelinePostflightResult,
} from './pipeline/ACILPipeline';

// Phase 1 — Session Classifier
export { SessionClassifier }  from './classifier/SessionClassifier';
export type { TelemetrySignals, ClassificationResult } from './classifier/SessionClassifier';

// Phase 2 — Burn Predictor + Developer Pattern Identifier
export { BurnPredictor }  from './predictor/BurnPredictor';
export { BurnProfile, BASELINE_BURN_PROFILES } from './predictor/BurnProfile';
export { DeveloperPatternIdentifier } from './predictor/DeveloperPatternIdentifier';
export type { ArchetypeProfile, DeveloperArchetype } from './predictor/DeveloperPatternIdentifier';
export type { PredictInput } from './predictor/BurnPredictor';
export type { SessionBurnBaseline } from './predictor/BurnProfile';

// Phase 5 — Chat-to-Completion Translator (CCT)
export { PromptCompressor, InputFormat } from './translator/PromptCompressor';
export type { CompressionResult }        from './translator/PromptCompressor';
export { SemanticEquivalenceChecker }    from './translator/SemanticEquivalenceChecker';
export type { EquivalenceResult, EmbedFn, SemanticEquivalenceOptions } from './translator/SemanticEquivalenceChecker';

// Phase 6 — Temporal Spend Predictor (TSP)
export { BurnRateCalculator }     from './temporal/BurnRateCalculator';
export { CalendarAwareModifier }  from './temporal/CalendarAwareModifier';
export { OverageRiskScorer }      from './temporal/OverageRiskScorer';
export { ExhaustionForecaster }   from './temporal/ExhaustionForecaster';
export type { BurnRateResult }    from './temporal/BurnRateCalculator';
export type { CalendarModifiers } from './temporal/CalendarAwareModifier';
export type { OverageRiskResult } from './temporal/OverageRiskScorer';
export type { ForecastInput }     from './temporal/ExhaustionForecaster';
