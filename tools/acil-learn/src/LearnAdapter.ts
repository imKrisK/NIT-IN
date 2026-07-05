/**
 * @nit-in/acil-learn — LearnAdapter
 *
 * Minimal single-method wrapper for embedding ACILLearn into
 * middleware-style architectures (proxy servers, HTTP interceptors, etc.)
 *
 * Usage in an LLM proxy:
 *
 *   const adapter = new LearnAdapter({ storagePath: '/var/acil' });
 *   await adapter.initialize();
 *
 *   // In request handler:
 *   const gate = await adapter.gate({ tokenEstimate: 2400 });
 *   if (gate.block) { return res.status(429).json({ reason: gate.reason }); }
 *
 *   // Forward to LLM ...
 *
 *   // After response:
 *   adapter.close(gate.predictionId, { actualCost: 0.0072, actualTokens: 2391, cctApplied: false });
 */

import { ACILLearn, LearnConfig, PredictInput } from './ACILLearn';
import type { SessionType } from '@nit-in/acil';

export interface GateResult {
  predictionId:        string;
  block:               boolean;
  reason?:             string;
  estimatedCostUsd:    number;
  adaptedCCTThreshold: number;
  archetype:           string | null;
}

export interface CloseInput {
  predictionId:     string;
  actualCost:       number;
  actualTokens:     number;
  cctApplied:       boolean;
  semanticScore?:   number;
  actualSessionType?: SessionType;
}

export class LearnAdapter {
  private _learn:       ACILLearn;
  private _budgetUsd:   number;
  private _initialized = false;

  constructor(config: LearnConfig & { budgetUsd?: number } = {}) {
    this._learn     = new ACILLearn(config);
    this._budgetUsd = config.budgetUsd ?? config.monthlyBudget ?? 39.00;
  }

  async initialize(): Promise<void> {
    if (this._initialized) return;
    await this._learn.load();
    this._initialized = true;
  }

  async gate(input: PredictInput): Promise<GateResult> {
    if (!this._initialized) await this.initialize();
    const prediction = await this._learn.predict(input);

    // Simple block logic: if estimate exceeds remaining daily budget
    const dailyBudget = this._budgetUsd / 30;
    const block = prediction.estimatedCostUsd > dailyBudget;

    return {
      predictionId:        prediction.predictionId,
      block,
      reason:              block ? `Estimated cost $${prediction.estimatedCostUsd.toFixed(4)} exceeds daily budget $${dailyBudget.toFixed(4)}` : undefined,
      estimatedCostUsd:    prediction.estimatedCostUsd,
      adaptedCCTThreshold: prediction.adaptedCCTThreshold,
      archetype:           prediction.archetype?.archetype ?? null,
    };
  }

  close(input: CloseInput): void {
    this._learn.record(input);
  }

  async flush(): Promise<void> {
    await this._learn.save();
  }
}
