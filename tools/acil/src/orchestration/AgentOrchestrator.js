"use strict";
/**
 * ACIL Wave 12 — AgentOrchestrator
 *
 * Coordinates all Wave 12 primitives into a unified orchestration layer:
 *
 *   SharedBudgetPool       — single balance across all AI agents
 *   ContradictionDetector  — flags conflicting agent outputs
 *   ControlledHallucination— exact cost measurement via shadow inference
 *
 * This is the top-level Wave 12 API. IDE adapters and MCP tools
 * interact with this class rather than the individual components.
 *
 * Usage:
 *   const orch = new AgentOrchestrator({ monthlyBudget: 39 });
 *   orch.registerAgent('copilot', onStateChange);
 *   orch.registerAgent('cursor', onStateChange);
 *
 *   // Before any agent sends a request:
 *   const gate = await orch.preflight('copilot', prompt, sessionType, cost);
 *   if (!gate.allowed) return blocked response;
 *
 *   // After agent responds:
 *   const check = orch.checkResponse('copilot', responseText);
 *   if (check.resolution === 'flag') show contradiction warning;
 *
 * Patent: Wave 12 Claims 1, 4, 7, 9
 * Author: imKrisK
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentOrchestrator = void 0;
const SharedBudgetPool_1 = require("./SharedBudgetPool");
const ContradictionDetector_1 = require("./ContradictionDetector");
const ControlledHallucinationEngine_1 = require("./ControlledHallucinationEngine");
const types_1 = require("../core/types");
class AgentOrchestrator {
    _pool;
    _detector;
    _hallucinate;
    _agents = new Map(); // source → unregister fn
    constructor(config) {
        this._pool = new SharedBudgetPool_1.SharedBudgetPool(config.monthlyBudget, config.initialBalance);
        this._detector = new ContradictionDetector_1.ContradictionDetector();
        this._hallucinate = new ControlledHallucinationEngine_1.ControlledHallucinationEngine({
            activateOnStates: config.shadowEnabled === false
                ? []
                : [types_1.EnforcementState.CRITICAL, types_1.EnforcementState.WARNING],
        });
    }
    /** Register an agent consumer. Each agent gets pool state changes pushed to it. */
    registerAgent(source, onStateChange) {
        if (this._agents.has(source))
            this.unregisterAgent(source);
        const unregister = this._pool.register(source, onStateChange);
        this._agents.set(source, unregister);
    }
    unregisterAgent(source) {
        this._agents.get(source)?.();
        this._agents.delete(source);
    }
    /**
     * Pre-execution gate — call before any agent fires an LLM request.
     * Handles budget debit, shadow measurement if warranted.
     */
    async preflight(source, originalPrompt, compressedPrompt, sessionType, estimatedCost, modelCostPerKTok = 0.005) {
        const poolState = this._pool.peek();
        // Shadow measurement for exact cost differential
        let shadowMeasure;
        if ([types_1.EnforcementState.CRITICAL, types_1.EnforcementState.WARNING].includes(poolState.enforcementState)) {
            shadowMeasure = await this._hallucinate.measure(originalPrompt, compressedPrompt, sessionType, modelCostPerKTok, poolState.enforcementState);
            // Use exact measured cost if available
            if (shadowMeasure.measurement === 'exact') {
                estimatedCost = shadowMeasure.exactCostCompressed;
            }
        }
        // Debit from shared pool
        const debit = await this._pool.debit(source, estimatedCost);
        return {
            allowed: debit.allowed,
            source,
            enforcementState: debit.enforcementState,
            poolSnapshot: this._pool.peek(),
            shadowMeasure,
            reason: debit.reason,
        };
    }
    /**
     * Post-response check — call after any agent delivers a response.
     * Detects contradictions against other agents' recent responses.
     */
    checkResponse(source, responseText) {
        const contradiction = this._detector.detect(source, responseText);
        const shouldSurface = contradiction.resolution !== 'block';
        const warningMessage = contradiction.flagMessage;
        return { contradiction, source, shouldSurface, warningMessage };
    }
    /** Wire the shadow inference function (called once on extension activate). */
    setShadowFn(fn) {
        this._hallucinate.setShadowFn(fn);
    }
    /** Reset contradiction history (e.g. on new file/workspace). */
    resetSession() {
        this._detector.clearHistory();
    }
    /** Pool snapshot — used by MCP acil_status and dashboard. */
    poolSnapshot() { return this._pool.peek(); }
    /** Set pool balance (from reconcileBalance command). */
    setBalance(balance) { this._pool.setBalance(balance); }
    /** Diagnostic stats. */
    get diagnostics() {
        return {
            pool: this._pool.peek(),
            shadow: this._hallucinate.stats,
            agents: [...this._agents.keys()],
            history: this._detector.historySize,
        };
    }
}
exports.AgentOrchestrator = AgentOrchestrator;
