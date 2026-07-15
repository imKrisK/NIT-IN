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

import { SharedBudgetPool, AgentSource, PoolDebitResult } from './SharedBudgetPool';
import { ContradictionDetector, ContradictionResult } from './ContradictionDetector';
import { ControlledHallucinationEngine, ShadowRunResult, ShadowInferenceFn } from './ControlledHallucinationEngine';
import { EnforcementState } from '../core/types';

export interface OrchestratorConfig {
  monthlyBudget:    number;
  initialBalance?:  number;
  shadowEnabled?:   boolean;
  contradictionEnabled?: boolean;
}

export interface OrchestrationPreflightResult {
  allowed:          boolean;
  source:           AgentSource;
  enforcementState: EnforcementState;
  poolSnapshot:     ReturnType<SharedBudgetPool['peek']>;
  shadowMeasure?:   ShadowRunResult;
  reason?:          string;
}

export interface OrchestrationResponseResult {
  contradiction:  ContradictionResult;
  source:         AgentSource;
  shouldSurface:  boolean;  // false = block from showing developer
  warningMessage?: string;
}

export class AgentOrchestrator {
  private _pool:        SharedBudgetPool;
  private _detector:    ContradictionDetector;
  private _hallucinate: ControlledHallucinationEngine;
  private _agents:      Map<string, () => void> = new Map(); // source → unregister fn

  constructor(config: OrchestratorConfig) {
    this._pool        = new SharedBudgetPool(config.monthlyBudget, config.initialBalance);
    this._detector    = new ContradictionDetector();
    this._hallucinate = new ControlledHallucinationEngine({
      activateOnStates: config.shadowEnabled === false
        ? []
        : [EnforcementState.CRITICAL, EnforcementState.WARNING],
    });
  }

  /** Register an agent consumer. Each agent gets pool state changes pushed to it. */
  registerAgent(
    source: AgentSource,
    onStateChange: (state: EnforcementState, balance: number) => void,
  ): void {
    if (this._agents.has(source)) this.unregisterAgent(source);
    const unregister = this._pool.register(source, onStateChange);
    this._agents.set(source, unregister);
  }

  unregisterAgent(source: AgentSource): void {
    this._agents.get(source)?.();
    this._agents.delete(source);
  }

  /**
   * Pre-execution gate — call before any agent fires an LLM request.
   * Handles budget debit, shadow measurement if warranted.
   */
  async preflight(
    source:           AgentSource,
    originalPrompt:   string,
    compressedPrompt: string,
    sessionType:      string,
    estimatedCost:    number,
    modelCostPerKTok: number = 0.005,
  ): Promise<OrchestrationPreflightResult> {
    const poolState = this._pool.peek();

    // Shadow measurement for exact cost differential
    let shadowMeasure: ShadowRunResult | undefined;
    if ([EnforcementState.CRITICAL, EnforcementState.WARNING].includes(poolState.enforcementState)) {
      shadowMeasure = await this._hallucinate.measure(
        originalPrompt, compressedPrompt,
        sessionType, modelCostPerKTok,
        poolState.enforcementState,
      );
      // Use exact measured cost if available
      if (shadowMeasure.measurement === 'exact') {
        estimatedCost = shadowMeasure.exactCostCompressed;
      }
    }

    // Debit from shared pool
    const debit = await this._pool.debit(source, estimatedCost);

    return {
      allowed:          debit.allowed,
      source,
      enforcementState: debit.enforcementState,
      poolSnapshot:     this._pool.peek(),
      shadowMeasure,
      reason:           debit.reason,
    };
  }

  /**
   * Post-response check — call after any agent delivers a response.
   * Detects contradictions against other agents' recent responses.
   */
  checkResponse(source: AgentSource, responseText: string): OrchestrationResponseResult {
    const contradiction = this._detector.detect(source, responseText);

    const shouldSurface = contradiction.resolution !== 'block';
    const warningMessage = contradiction.flagMessage;

    return { contradiction, source, shouldSurface, warningMessage };
  }

  /** Wire the shadow inference function (called once on extension activate). */
  setShadowFn(fn: ShadowInferenceFn): void {
    this._hallucinate.setShadowFn(fn);
  }

  /** Reset contradiction history (e.g. on new file/workspace). */
  resetSession(): void {
    this._detector.clearHistory();
  }

  /** Pool snapshot — used by MCP acil_status and dashboard. */
  poolSnapshot() { return this._pool.peek(); }

  /** Set pool balance (from reconcileBalance command). */
  setBalance(balance: number): void { this._pool.setBalance(balance); }

  /** Diagnostic stats. */
  get diagnostics() {
    return {
      pool:        this._pool.peek(),
      shadow:      this._hallucinate.stats,
      agents:      [...this._agents.keys()],
      history:     this._detector.historySize,
    };
  }
}
