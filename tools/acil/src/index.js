"use strict";
/**
 * ACIL — Public API
 * AI Credit Intelligence Layer — Phase 0-6 Exports
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentOrchestrator = exports.ControlledHallucinationEngine = exports.ContradictionDetector = exports.SharedBudgetPool = exports.ExhaustionForecaster = exports.OverageRiskScorer = exports.CalendarAwareModifier = exports.BurnRateCalculator = exports.SemanticEquivalenceChecker = exports.InputFormat = exports.PromptCompressor = exports.DeveloperPatternIdentifier = exports.BASELINE_BURN_PROFILES = exports.BurnProfile = exports.BurnPredictor = exports.SessionClassifier = exports.UserFeedbackCollector = exports.MetaRecursiveLoop = exports.ACILPipeline = exports.QualityRequirement = exports.CostRouter = exports.THROTTLE_SUBSTITUTION = exports.MODEL_PRICING = exports.AuditTrail = exports.BudgetEnforcer = exports.CreditBilling = exports.TokenMeter = void 0;
// Core types
__exportStar(require("./core/types"), exports);
// Phase 0 — Metering Engine
var TokenMeter_1 = require("./core/TokenMeter");
Object.defineProperty(exports, "TokenMeter", { enumerable: true, get: function () { return TokenMeter_1.TokenMeter; } });
var CreditBilling_1 = require("./core/CreditBilling");
Object.defineProperty(exports, "CreditBilling", { enumerable: true, get: function () { return CreditBilling_1.CreditBilling; } });
var BudgetEnforcer_1 = require("./core/BudgetEnforcer");
Object.defineProperty(exports, "BudgetEnforcer", { enumerable: true, get: function () { return BudgetEnforcer_1.BudgetEnforcer; } });
var AuditTrail_1 = require("./core/AuditTrail");
Object.defineProperty(exports, "AuditTrail", { enumerable: true, get: function () { return AuditTrail_1.AuditTrail; } });
// Model pricing and routing config
var PricingConfig_1 = require("./models/PricingConfig");
Object.defineProperty(exports, "MODEL_PRICING", { enumerable: true, get: function () { return PricingConfig_1.MODEL_PRICING; } });
Object.defineProperty(exports, "THROTTLE_SUBSTITUTION", { enumerable: true, get: function () { return PricingConfig_1.THROTTLE_SUBSTITUTION; } });
// Phase 3/4 — Cost Router (CMCR)
var CostRouter_1 = require("./models/CostRouter");
Object.defineProperty(exports, "CostRouter", { enumerable: true, get: function () { return CostRouter_1.CostRouter; } });
Object.defineProperty(exports, "QualityRequirement", { enumerable: true, get: function () { return CostRouter_1.QualityRequirement; } });
// Phase 4 — Pipeline Orchestrator
var ACILPipeline_1 = require("./pipeline/ACILPipeline");
Object.defineProperty(exports, "ACILPipeline", { enumerable: true, get: function () { return ACILPipeline_1.ACILPipeline; } });
var MetaRecursiveLoop_1 = require("./pipeline/MetaRecursiveLoop");
Object.defineProperty(exports, "MetaRecursiveLoop", { enumerable: true, get: function () { return MetaRecursiveLoop_1.MetaRecursiveLoop; } });
// Feedback learning layer (Wave 11)
var UserFeedbackCollector_1 = require("./feedback/UserFeedbackCollector");
Object.defineProperty(exports, "UserFeedbackCollector", { enumerable: true, get: function () { return UserFeedbackCollector_1.UserFeedbackCollector; } });
// Phase 1 — Session Classifier
var SessionClassifier_1 = require("./classifier/SessionClassifier");
Object.defineProperty(exports, "SessionClassifier", { enumerable: true, get: function () { return SessionClassifier_1.SessionClassifier; } });
// Phase 2 — Burn Predictor + Developer Pattern Identifier
var BurnPredictor_1 = require("./predictor/BurnPredictor");
Object.defineProperty(exports, "BurnPredictor", { enumerable: true, get: function () { return BurnPredictor_1.BurnPredictor; } });
var BurnProfile_1 = require("./predictor/BurnProfile");
Object.defineProperty(exports, "BurnProfile", { enumerable: true, get: function () { return BurnProfile_1.BurnProfile; } });
Object.defineProperty(exports, "BASELINE_BURN_PROFILES", { enumerable: true, get: function () { return BurnProfile_1.BASELINE_BURN_PROFILES; } });
var DeveloperPatternIdentifier_1 = require("./predictor/DeveloperPatternIdentifier");
Object.defineProperty(exports, "DeveloperPatternIdentifier", { enumerable: true, get: function () { return DeveloperPatternIdentifier_1.DeveloperPatternIdentifier; } });
// Phase 5 — Chat-to-Completion Translator (CCT)
var PromptCompressor_1 = require("./translator/PromptCompressor");
Object.defineProperty(exports, "PromptCompressor", { enumerable: true, get: function () { return PromptCompressor_1.PromptCompressor; } });
Object.defineProperty(exports, "InputFormat", { enumerable: true, get: function () { return PromptCompressor_1.InputFormat; } });
var SemanticEquivalenceChecker_1 = require("./translator/SemanticEquivalenceChecker");
Object.defineProperty(exports, "SemanticEquivalenceChecker", { enumerable: true, get: function () { return SemanticEquivalenceChecker_1.SemanticEquivalenceChecker; } });
// Phase 6 — Temporal Spend Predictor (TSP)
var BurnRateCalculator_1 = require("./temporal/BurnRateCalculator");
Object.defineProperty(exports, "BurnRateCalculator", { enumerable: true, get: function () { return BurnRateCalculator_1.BurnRateCalculator; } });
var CalendarAwareModifier_1 = require("./temporal/CalendarAwareModifier");
Object.defineProperty(exports, "CalendarAwareModifier", { enumerable: true, get: function () { return CalendarAwareModifier_1.CalendarAwareModifier; } });
var OverageRiskScorer_1 = require("./temporal/OverageRiskScorer");
Object.defineProperty(exports, "OverageRiskScorer", { enumerable: true, get: function () { return OverageRiskScorer_1.OverageRiskScorer; } });
var ExhaustionForecaster_1 = require("./temporal/ExhaustionForecaster");
Object.defineProperty(exports, "ExhaustionForecaster", { enumerable: true, get: function () { return ExhaustionForecaster_1.ExhaustionForecaster; } });
// Wave 12 — Multi-Agent Orchestration
var SharedBudgetPool_1 = require("./orchestration/SharedBudgetPool");
Object.defineProperty(exports, "SharedBudgetPool", { enumerable: true, get: function () { return SharedBudgetPool_1.SharedBudgetPool; } });
var ContradictionDetector_1 = require("./orchestration/ContradictionDetector");
Object.defineProperty(exports, "ContradictionDetector", { enumerable: true, get: function () { return ContradictionDetector_1.ContradictionDetector; } });
var ControlledHallucinationEngine_1 = require("./orchestration/ControlledHallucinationEngine");
Object.defineProperty(exports, "ControlledHallucinationEngine", { enumerable: true, get: function () { return ControlledHallucinationEngine_1.ControlledHallucinationEngine; } });
var AgentOrchestrator_1 = require("./orchestration/AgentOrchestrator");
Object.defineProperty(exports, "AgentOrchestrator", { enumerable: true, get: function () { return AgentOrchestrator_1.AgentOrchestrator; } });
