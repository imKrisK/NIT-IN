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
import { SharedBudgetPool, AgentSource } from './SharedBudgetPool';
import { ContradictionResult } from './ContradictionDetector';
import { ShadowRunResult, ShadowInferenceFn } from './ControlledHallucinationEngine';
import { EnforcementState } from '../core/types';
export interface OrchestratorConfig {
    monthlyBudget: number;
    initialBalance?: number;
    shadowEnabled?: boolean;
    contradictionEnabled?: boolean;
}
export interface OrchestrationPreflightResult {
    allowed: boolean;
    source: AgentSource;
    enforcementState: EnforcementState;
    poolSnapshot: ReturnType<SharedBudgetPool['peek']>;
    shadowMeasure?: ShadowRunResult;
    reason?: string;
}
export interface OrchestrationResponseResult {
    contradiction: ContradictionResult;
    source: AgentSource;
    shouldSurface: boolean;
    warningMessage?: string;
}
export declare class AgentOrchestrator {
    private _pool;
    private _detector;
    private _hallucinate;
    private _agents;
    constructor(config: OrchestratorConfig);
    /** Register an agent consumer. Each agent gets pool state changes pushed to it. */
    registerAgent(source: AgentSource, onStateChange: (state: EnforcementState, balance: number) => void): void;
    unregisterAgent(source: AgentSource): void;
    /**
     * Pre-execution gate — call before any agent fires an LLM request.
     * Handles budget debit, shadow measurement if warranted.
     */
    preflight(source: AgentSource, originalPrompt: string, compressedPrompt: string, sessionType: string, estimatedCost: number, modelCostPerKTok?: number): Promise<OrchestrationPreflightResult>;
    /**
     * Post-response check — call after any agent delivers a response.
     * Detects contradictions against other agents' recent responses.
     */
    checkResponse(source: AgentSource, responseText: string): OrchestrationResponseResult;
    /** Wire the shadow inference function (called once on extension activate). */
    setShadowFn(fn: ShadowInferenceFn): void;
    /** Reset contradiction history (e.g. on new file/workspace). */
    resetSession(): void;
    /** Pool snapshot — used by MCP acil_status and dashboard. */
    poolSnapshot(): import("./SharedBudgetPool").PoolSnapshot;
    /** Set pool balance (from reconcileBalance command). */
    setBalance(balance: number): void;
    /** Diagnostic stats. */
    get diagnostics(): {
        pool: import("./SharedBudgetPool").PoolSnapshot;
        shadow: {
            calls: number;
            totalCost: number;
        };
        agents: string[];
        history: number;
    };
}
//# sourceMappingURL=AgentOrchestrator.d.ts.map