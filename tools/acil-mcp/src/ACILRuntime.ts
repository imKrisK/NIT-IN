/**
 * ACIL MCP — ACILRuntime
 *
 * Thin wrapper around @nit-in/acil core that handles file I/O and
 * provides the method surface the MCP tool handlers call.
 */

import * as fs   from 'fs';
import * as path from 'path';
import {
  ACILPipeline,
  AuditTrail,
  MetaRecursiveLoop,
  UserFeedbackCollector,
  DeveloperPatternIdentifier,
  ExhaustionForecaster,
  CostRouter,
} from '@nit-in/acil';
import type {
  SessionType,
  ModelId,
  EnforcementState,
} from '@nit-in/acil';

export interface RuntimeConfig {
  storagePath:    string;
  monthlyBudget?: number;
}

export interface PreflightResult {
  allowed:          boolean;
  estimatedCost:    number;
  enforcementState: EnforcementState;
  cctRecommended:   boolean;
  cctThreshold:     number;
  suggestedModel:   ModelId | null;
  reason?:          string;
}

export interface StatusResult {
  balance:       number;
  spent:         number;
  budgetPct:     number;
  archetype:     string;
  todayCost:     number;
  todayRequests: number;
  state:         EnforcementState;
}

export interface ForecastResult {
  exhaustionDate:   string | null;
  daysRemaining:    number | null;
  riskLevel:        'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  recommendation:   string;
}

export class ACILRuntime {
  private _config:   RuntimeConfig;
  private _audit:    AuditTrail;
  private _pipeline: ACILPipeline;
  private _loop:     MetaRecursiveLoop;
  private _feedback: UserFeedbackCollector;

  constructor(config: RuntimeConfig) {
    this._config   = config;
    this._audit    = new AuditTrail();
    this._feedback = new UserFeedbackCollector();
    this._pipeline = new ACILPipeline({
      monthlyAllocation: config.monthlyBudget ?? 39.00,
      audit:             this._audit,
    });
    this._loop = new MetaRecursiveLoop(this._feedback);
  }

  async load(): Promise<void> {
    const ensureDir = (p: string) => {
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    };
    ensureDir(this._config.storagePath);

    const load = (name: string, fn: (p: string) => void) => {
      const p = this._fp(name);
      if (fs.existsSync(p)) fn(p);
    };
    load('acil-audit.json',    p => this._audit.load(p));
    load('acil-feedback.json', p => this._feedback.load(p));
    load('acil-outcomes.json', p => this._loop.load(p));
    load('acil-profile.json',  p => this._pipeline.loadProfile(p));
  }

  async save(): Promise<void> {
    this._audit.save(this._fp('acil-audit.json'));
    this._feedback.save(this._fp('acil-feedback.json'));
    this._loop.save(this._fp('acil-outcomes.json'));
    this._pipeline.saveProfile(this._fp('acil-profile.json'));
  }

  // ── Tool implementations ────────────────────────────────────────────────

  async preflight(prompt: string, model: ModelId, sessionType?: SessionType): Promise<PreflightResult> {
    const prediction = this._loop.calibrate(this._audit);
    const enforcement = this._pipeline.peekEnforcementState();
    const router     = new CostRouter(this._pipeline.pricingConfig);
    const sub        = router.suggestSubstitution(model, enforcement);
    const estCost    = prediction.nextRequestCostEst > 0
      ? prediction.nextRequestCostEst
      : (prompt.length / 4) * 0.00003;

    const allowed = enforcement !== 'HARD_BLOCK' && enforcement !== 'EMERGENCY';

    return {
      allowed,
      estimatedCost:    estCost,
      enforcementState: enforcement,
      cctRecommended:   prompt.length > 800,
      cctThreshold:     prediction.adaptedCCTThreshold,
      suggestedModel:   sub?.targetModel ?? null,
      reason:           !allowed ? `Budget state: ${enforcement}` : undefined,
    };
  }

  getStatus(): StatusResult {
    const burns    = this._audit.dailyBurns();
    const today    = new Date().toISOString().slice(0, 10);
    const todayRec = burns.find(b => b.date === today);
    const archetype = this._loop.calibrate(this._audit).developerArchetype?.archetype ?? 'BALANCED';

    return {
      balance:       this._pipeline.balance,
      spent:         this._pipeline.totalAllocation - this._pipeline.balance,
      budgetPct:     Math.round(((this._pipeline.totalAllocation - this._pipeline.balance) / this._pipeline.totalAllocation) * 100),
      archetype,
      todayCost:     todayRec?.grossCost     ?? 0,
      todayRequests: todayRec?.totalRequests ?? 0,
      state:         this._pipeline.peekEnforcementState(),
    };
  }

  getForecast(days = 30): ForecastResult {
    const forecaster = new ExhaustionForecaster(this._pipeline, this._audit);
    const forecast   = forecaster.forecast(days);
    const riskLevel  = forecast.riskScore > 0.85 ? 'CRITICAL'
      : forecast.riskScore > 0.65 ? 'HIGH'
      : forecast.riskScore > 0.40 ? 'MEDIUM'
      : 'LOW';

    return {
      exhaustionDate: forecast.exhaustionDate?.toISOString().slice(0, 10) ?? null,
      daysRemaining:  forecast.daysRemaining  ?? null,
      riskLevel,
      recommendation: forecast.recommendation ?? `Risk: ${riskLevel}. ${this._pipeline.balance.toFixed(2)} remaining.`,
    };
  }

  getOrSetBudget(action: 'get' | 'set', value?: number): { monthlyBudget: number; spent: number; remaining: number } {
    if (action === 'set' && value !== undefined) {
      this._pipeline.setMonthlyAllocation(value);
    }
    const budget = this._pipeline.totalAllocation;
    const spent  = budget - this._pipeline.balance;
    return { monthlyBudget: budget, spent, remaining: this._pipeline.balance };
  }

  recordFeedback(action: string, context?: string): void {
    type A = Parameters<UserFeedbackCollector['record']>[0];
    const valid = [
      'MODEL_SUB_ACCEPTED','MODEL_SUB_REJECTED','CCT_ACCEPTED','CCT_REJECTED',
      'SOFT_BLOCK_OVERRIDDEN','AGENTIC_CONFIRMED','AGENTIC_CANCELLED',
      'BUDGET_INCREASED','BUDGET_IGNORED',
    ];
    if (!valid.includes(action)) return;
    this._feedback.record(action as A, context);
  }

  getFeedbackSummary() {
    return this._feedback.getSignals();
  }

  exportCompliance(hmacKey: string): object {
    return this._audit.exportSignedBatch(hmacKey);
  }

  private _fp(name: string): string {
    return path.join(this._config.storagePath, name);
  }
}
