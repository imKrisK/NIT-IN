"use strict";
/**
 * @nit-in/acil-learn — ACILLearn
 *
 * Framework-agnostic wrapper around MetaRecursiveLoop + DeveloperPatternIdentifier.
 * Designed for embedding in any Node.js AI tooling product:
 *
 *   - JetBrains plugin (Kotlin JVM calls Node.js sidecar)
 *   - Neovim LSP adapter
 *   - CI/CD pipeline cost gate
 *   - Custom LLM proxy (Nginx module → Node sidecar)
 *   - CLI tools (e.g. `llm-run` wrappers)
 *
 * Author: imKrisK — Wave 11 Patent Claim 1 (Meta-Recursive Session Calibration Loop)
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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACILLearn = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const acil_1 = require("@nit-in/acil");
// ── ACILLearn ───────────────────────────────────────────────────────────────
class ACILLearn {
    _config;
    _pipeline;
    _loop;
    _audit;
    _pending = new Map();
    constructor(config = {}) {
        const os = require('os');
        this._config = {
            storagePath: config.storagePath ?? '.acil-learn',
            monthlyBudget: config.monthlyBudget ?? 39.00,
            defaultModel: config.defaultModel ?? 'copilot-premium',
            developerId: config.developerId ?? os.hostname(),
        };
        this._audit = new acil_1.AuditTrail();
        this._pipeline = new acil_1.ACILPipeline({
            monthlyAllocation: this._config.monthlyBudget,
            audit: this._audit,
        });
        this._loop = new acil_1.MetaRecursiveLoop(this._pipeline);
    }
    /**
     * Load persisted state from storagePath.
     * Call once at startup before any predict() calls.
     */
    async load() {
        const auditFile = this._storagePath('acil-audit.json');
        const outcomesFile = this._storagePath('acil-outcomes.json');
        this._audit.load(auditFile);
        if (fs.existsSync(outcomesFile)) {
            await this._loop.load(outcomesFile);
        }
    }
    /**
     * Persist state to storagePath.
     * Call at shutdown and periodically (every N requests).
     */
    async save() {
        this._ensureStorageDir();
        this._audit.save(this._storagePath('acil-audit.json'));
        await this._loop.save(this._storagePath('acil-outcomes.json'));
    }
    /**
     * Generate a pre-execution prediction.
     * Returns adapted thresholds and archetype before any tokens are spent.
     */
    async predict(input) {
        const prediction = this._loop.calibrate(this._audit);
        const predictionId = crypto.randomUUID();
        const sessionType = input.sessionType ?? prediction.preClassifiedSession;
        const costEst = prediction.nextRequestCostEst > 0
            ? prediction.nextRequestCostEst
            : input.tokenEstimate * 0.00003; // fallback: rough GPT-4 rate
        this._pending.set(predictionId, {
            predictedCost: costEst,
            predictedType: sessionType,
        });
        return {
            predictionId,
            adaptedCCTThreshold: prediction.adaptedCCTThreshold,
            adaptedTSPMultiplier: prediction.adaptedTSPMultiplier,
            estimatedCostUsd: costEst,
            archetype: prediction.developerArchetype,
            predictedSessionType: sessionType,
            generation: prediction.generation,
            raw: prediction,
        };
    }
    /**
     * Record the actual outcome of a completed LLM request.
     * Closes the feedback loop — improves next predict() accuracy.
     */
    record(input) {
        const pending = this._pending.get(input.predictionId);
        if (!pending)
            return;
        this._pending.delete(input.predictionId);
        const outcome = {
            predictedCost: pending.predictedCost,
            actualCost: input.actualCost,
            predictedType: pending.predictedType,
            actualType: input.actualSessionType ?? pending.predictedType,
            cctApplied: input.cctApplied,
            semanticScore: input.semanticScore,
        };
        this._loop.recordOutcome(outcome);
    }
    /**
     * Identify the current developer archetype from audit history.
     * Useful for displaying in dashboards without running a full predict().
     */
    identifyArchetype() {
        const id = new acil_1.DeveloperPatternIdentifier();
        // Build session records from audit daily burns
        const burns = this._audit.dailyBurns();
        if (burns.length === 0)
            return null;
        const sessions = this._audit.export().map(e => ({
            sessionType: e.sessionType,
            totalTokens: e.usage.totalTokens,
            timestamp: e.timestamp instanceof Date ? e.timestamp : new Date(e.timestamp),
        }));
        const dailyRecords = burns.map(b => ({ date: b.date, grossCost: b.grossCost }));
        return id.identify(sessions, dailyRecords);
    }
    /** Fluent config accessor. */
    get config() { return this._config; }
    _storagePath(filename) {
        return path.join(this._config.storagePath, filename);
    }
    _ensureStorageDir() {
        if (!fs.existsSync(this._config.storagePath)) {
            fs.mkdirSync(this._config.storagePath, { recursive: true });
        }
    }
}
exports.ACILLearn = ACILLearn;
