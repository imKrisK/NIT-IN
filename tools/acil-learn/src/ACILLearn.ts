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

import * as fs   from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  AuditTrail,
  ACILPipeline,
  MetaRecursiveLoop,
  DeveloperPatternIdentifier,
} from '@nit-in/acil';
import type {
  RecursivePrediction,
  LoopOutcome,
  ArchetypeProfile,
  SessionType,
  ModelId,
} from '@nit-in/acil';

// ── Public API types ────────────────────────────────────────────────────────

export interface LearnConfig {
  /** Directory to persist outcomes and archetype state. Default: '.acil-learn' */
  storagePath?:         string;
  /** Monthly token credit budget in USD. Default: 39.00 */
  monthlyBudget?:       number;
  /** Model to use for cost calculations. Default: 'copilot-premium' */
  defaultModel?:        ModelId;
  /** Developer identifier (for multi-developer deployments). Default: os.hostname() */
  developerId?:         string;
}

export interface PredictInput {
  /** Estimated input tokens for the upcoming request */
  tokenEstimate:    number;
  /** Known session type (if determinable pre-request). Omit for auto-classify. */
  sessionType?:     SessionType;
  /** Current time (defaults to now) — used for calendar weighting */
  now?:             Date;
}

export interface PredictOutput {
  /** Unique ID for this prediction — pass back to record() to close the loop */
  predictionId:         string;
  /** Recommended CCT compression threshold for this request */
  adaptedCCTThreshold:  number;
  /** Burn rate multiplier adjusted for developer archetype */
  adaptedTSPMultiplier: number;
  /** Predicted cost in USD */
  estimatedCostUsd:     number;
  /** Developer archetype derived from history */
  archetype:            ArchetypeProfile | null;
  /** Pre-classified session type */
  predictedSessionType: SessionType;
  /** Loop calibration generation count */
  generation:           number;
  /** Raw recursive prediction (full details) */
  raw:                  RecursivePrediction;
}

export interface RecordInput {
  /** Must match the predictionId returned by predict() */
  predictionId:    string;
  /** Actual cost of the completed request in USD */
  actualCost:      number;
  /** Actual token count used */
  actualTokens:    number;
  /** Whether CCT compression was applied */
  cctApplied:      boolean;
  /** Semantic similarity score if CCT was evaluated (0.0–1.0) */
  semanticScore?:  number;
  /** Actual session type (if different from prediction) */
  actualSessionType?: SessionType;
}

// ── ACILLearn ───────────────────────────────────────────────────────────────

export class ACILLearn {
  private _config:   Required<LearnConfig>;
  private _pipeline: ACILPipeline;
  private _loop:     MetaRecursiveLoop;
  private _audit:    AuditTrail;
  private _pending:  Map<string, { predictedCost: number; predictedType: SessionType }> = new Map();

  constructor(config: LearnConfig = {}) {
    const os = require('os') as typeof import('os');
    this._config = {
      storagePath:   config.storagePath   ?? '.acil-learn',
      monthlyBudget: config.monthlyBudget ?? 39.00,
      defaultModel:  config.defaultModel  ?? 'copilot-premium',
      developerId:   config.developerId   ?? os.hostname(),
    };

    this._audit    = new AuditTrail();
    this._pipeline = new ACILPipeline({
      monthlyAllocation: this._config.monthlyBudget,
      audit:             this._audit,
    });
    this._loop = new MetaRecursiveLoop(this._pipeline);
  }

  /**
   * Load persisted state from storagePath.
   * Call once at startup before any predict() calls.
   */
  async load(): Promise<void> {
    const auditFile   = this._storagePath('acil-audit.json');
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
  async save(): Promise<void> {
    this._ensureStorageDir();
    this._audit.save(this._storagePath('acil-audit.json'));
    await this._loop.save(this._storagePath('acil-outcomes.json'));
  }

  /**
   * Generate a pre-execution prediction.
   * Returns adapted thresholds and archetype before any tokens are spent.
   */
  async predict(input: PredictInput): Promise<PredictOutput> {
    const prediction = this._loop.calibrate(this._audit);
    const predictionId = crypto.randomUUID();

    const sessionType = input.sessionType ?? prediction.preClassifiedSession;
    const costEst     = prediction.nextRequestCostEst > 0
      ? prediction.nextRequestCostEst
      : input.tokenEstimate * 0.00003; // fallback: rough GPT-4 rate

    this._pending.set(predictionId, {
      predictedCost: costEst,
      predictedType: sessionType,
    });

    return {
      predictionId,
      adaptedCCTThreshold:  prediction.adaptedCCTThreshold,
      adaptedTSPMultiplier: prediction.adaptedTSPMultiplier,
      estimatedCostUsd:     costEst,
      archetype:            prediction.developerArchetype,
      predictedSessionType: sessionType,
      generation:           prediction.generation,
      raw:                  prediction,
    };
  }

  /**
   * Record the actual outcome of a completed LLM request.
   * Closes the feedback loop — improves next predict() accuracy.
   */
  record(input: RecordInput): void {
    const pending = this._pending.get(input.predictionId);
    if (!pending) return;
    this._pending.delete(input.predictionId);

    const outcome: LoopOutcome = {
      predictedCost:  pending.predictedCost,
      actualCost:     input.actualCost,
      predictedType:  pending.predictedType,
      actualType:     input.actualSessionType ?? pending.predictedType,
      cctApplied:     input.cctApplied,
      semanticScore:  input.semanticScore,
    };
    this._loop.recordOutcome(outcome);
  }

  /**
   * Identify the current developer archetype from audit history.
   * Useful for displaying in dashboards without running a full predict().
   */
  identifyArchetype(): ArchetypeProfile | null {
    const id = new DeveloperPatternIdentifier();
    // Build session records from audit daily burns
    const burns = this._audit.dailyBurns();
    if (burns.length === 0) return null;
    const sessions = this._audit.export().map(e => ({
      sessionType:  e.sessionType,
      totalTokens:  e.usage.totalTokens,
      timestamp:    e.timestamp instanceof Date ? e.timestamp : new Date(e.timestamp),
    }));
    const dailyRecords = burns.map(b => ({ date: b.date, grossCost: b.grossCost }));
    return id.identify(sessions, dailyRecords);
  }

  /** Fluent config accessor. */
  get config(): Readonly<Required<LearnConfig>> { return this._config; }

  private _storagePath(filename: string): string {
    return path.join(this._config.storagePath, filename);
  }

  private _ensureStorageDir(): void {
    if (!fs.existsSync(this._config.storagePath)) {
      fs.mkdirSync(this._config.storagePath, { recursive: true });
    }
  }
}
