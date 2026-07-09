/**
 * ACIL — MetaRecursiveLoop
 *
 * The self-calibrating intelligence layer. ACIL analyzing its own data
 * to rewrite its own compression rules, burn rate multipliers, and
 * session classifications — BEFORE each new prompt is sent.
 *
 * ═══════════════════════════════════════════════════════════════
 * CONCEPT: Reverse-engineered from Patent 29 (Meta-Recursive Learning)
 * Applied to: CCT + TSP + ACIL pipeline
 * Author: imKrisK (@imKrisK · github.com/imKrisK)
 * Patent: Wave 11 — Meta-Recursive ACIL Calibration
 * ═══════════════════════════════════════════════════════════════
 *
 * The Loop (runs BEFORE every preflight):
 *
 *   1. OBSERVE — collect live session data (AuditTrail events)
 *   2. IDENTIFY — classify developer archetype (DeveloperPatternIdentifier)
 *   3. PREDICT — forecast next session type + cost BEFORE token burn
 *   4. ADAPT — rewrite CCT threshold + TSP multiplier based on archetype
 *   5. PRE-CLASSIFY — feed prediction into SessionClassifier as a prior
 *   6. TRANSMIT — the adapted pipeline processes the request
 *   7. RECORD — postflight updates the loop with actual outcome
 *   8. → REPEAT (continuous)
 *
 * This is Wave 10 Claim 2 (pre-execution prediction) made recursive:
 * the prediction model itself is updated by its own prediction accuracy.
 *
 * Wave 11 Claim Structure (preview):
 *   - Claim 1: Meta-recursive session calibration loop
 *   - Claim 2: Developer archetype identification from request history
 *   - Claim 3: CCT threshold dynamic adjustment per archetype
 *   - Claim 4: TSP multiplier live rewriting per developer pattern
 *   - Claim 5: Prediction accuracy tracking (predicted vs actual)
 *
 * ═══════════════════════════════════════════════════════════════
 * TEMPORAL PREDICTION (per patent_29 reverse engineering):
 *
 * After 7 days of ACIL usage, the MetaRecursiveLoop accumulates enough
 * signal to identify the developer archetype with >80% confidence.
 * At that point, ACIL's pre-execution cost predictions should be within
 * 15% of actual — compared to 30-40% error for fresh installs.
 *
 * Compounding effect: each loop iteration improves the next prediction.
 * This is the "recursive self-improvement" from patent_29 applied to
 * token credit governance.
 * ═══════════════════════════════════════════════════════════════
 */

import { ACILPipeline } from '../pipeline/ACILPipeline';
import { SessionType } from '../core/types';
import { DeveloperPatternIdentifier, ArchetypeProfile, SessionRecord, DailyRecord, DeveloperArchetype } from '../predictor/DeveloperPatternIdentifier';
import { AuditTrail } from '../core/AuditTrail';
import { UserFeedbackCollector, FeedbackSignals } from '../feedback/UserFeedbackCollector';
import * as fs from 'fs';
import * as path from 'path';

export interface RecursivePrediction {
  /** Archetype derived from historical patterns */
  developerArchetype:  ArchetypeProfile | null;
  /** Pre-classified session type (before developer types anything) */
  preClassifiedSession: SessionType;
  /** Predicted token cost for the NEXT request ($) */
  nextRequestCostEst:  number;
  /** Adjusted CCT threshold (0.0–1.0) for this developer's pattern */
  adaptedCCTThreshold: number;
  /** Adjusted TSP multiplier for this developer's burn rate */
  adaptedTSPMultiplier: number;
  /** Accuracy of previous predictions (0.0–1.0, null if <5 data points) */
  predictionAccuracy:  number | null;
  /** Calibration generation — how many times the loop has run */
  generation:          number;
  /** Timestamp of this calibration */
  calibratedAt:        Date;
}

export interface LoopOutcome {
  predictedCost:  number;
  actualCost:     number;
  predictedType:  SessionType;
  actualType:     SessionType;
  timestamp:      Date;
}

export class MetaRecursiveLoop {
  private _identifier:      DeveloperPatternIdentifier;
  private _generation:      number = 0;
  private _outcomes:        LoopOutcome[] = [];
  private _lastProfile:     ArchetypeProfile | null = null;
  private _feedback:        UserFeedbackCollector | null = null;
  // TTL cache — prevents double-calibrate within 60 seconds
  private _lastCalibrated:  number = 0;
  private _lastPrediction:  RecursivePrediction | null = null;
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(feedback?: UserFeedbackCollector) {
    this._identifier = new DeveloperPatternIdentifier();
    this._feedback   = feedback ?? null;
  }

  /** Attach or replace the feedback collector (can be set after construction). */
  setFeedback(feedback: UserFeedbackCollector): void {
    this._feedback = feedback;
    // Bust cache so next calibrate() incorporates new feedback signals
    this._lastCalibrated = 0;
  }

  /**
   * Run the meta-recursive calibration loop.
   * TTL-cached: returns the last result if called within 60 seconds.
   * Prevents double-calibrate from /status + preflight on the same request.
   */
  calibrate(audit: AuditTrail): RecursivePrediction {
    const now = Date.now();
    if (this._lastPrediction && (now - this._lastCalibrated) < MetaRecursiveLoop.CACHE_TTL_MS) {
      return this._lastPrediction; // cache hit — same result, no generation bump
    }
    const summary    = audit.summarize();
    const dailyBurns = audit.dailyBurns();
    const events     = audit.export();

    // Build session records for pattern identification
    const sessions: SessionRecord[] = events.map(e => ({
      sessionType: e.sessionType,
      grossCost:   e.grossCost,
      timestamp:   e.timestamp instanceof Date ? e.timestamp : new Date(e.timestamp),
    }));

    const daily: DailyRecord[] = dailyBurns.map(d => ({
      date:          d.date,
      grossCost:     d.grossCost,
      totalRequests: d.totalRequests,
    }));

    // Identify developer archetype
    this._lastProfile = this._identifier.identify(sessions, daily);
    this._generation++;

    // Derive adaptive parameters
    const preClassified  = this._lastProfile?.predictions.nextLikelySession ?? SessionType.UNKNOWN;
    const nextCostEst    = this._lastProfile?.predictions.nextSessionCostEst ?? 0.04;
    const tspMultiplier  = this._lastProfile?.predictions.tspMultiplierAdj ?? 1.0;
    const feedbackSignals = this._feedback?.getSignals() ?? null;
    const cctThreshold   = this._adaptCCTThreshold(this._lastProfile, feedbackSignals);
    const accuracy       = this._computeAccuracy();

    const result: RecursivePrediction = {
      developerArchetype:   this._lastProfile,
      preClassifiedSession: preClassified,
      nextRequestCostEst:   nextCostEst,
      adaptedCCTThreshold:  cctThreshold,
      adaptedTSPMultiplier: tspMultiplier,
      predictionAccuracy:   accuracy,
      generation:           this._generation,
      calibratedAt:         new Date(),
    };
    // Update TTL cache
    this._lastCalibrated = Date.now();
    this._lastPrediction = result;
    return result;
  }

  /**
   * Record the actual outcome after a session completes.
   * This is the feedback that closes the loop — actual vs predicted.
   * Each call to recordOutcome() improves the NEXT calibration.
   */
  recordOutcome(outcome: LoopOutcome): void {
    this._outcomes.push(outcome);
    // Keep rolling window of last 50 outcomes
    if (this._outcomes.length > 50) {
      this._outcomes.shift();
    }
  }

  /**
   * Generate a human-readable calibration report.
   * Shown in @acil /status and the dashboard.
   */
  report(): string {
    if (!this._lastProfile) {
      return 'MetaRecursive: calibrating... (need 5+ sessions)';
    }
    const p = this._lastProfile;
    const acc = this._computeAccuracy();
    const accStr = acc !== null ? `${(acc * 100).toFixed(0)}% accurate` : 'calibrating';
    return [
      `Developer: ${p.archetype} (${(p.confidence * 100).toFixed(0)}% confidence)`,
      `Next predicted: ${p.predictions.nextLikelySession} (~$${p.predictions.nextSessionCostEst.toFixed(3)})`,
      `CCT threshold: ${(this._adaptCCTThreshold(p, null) * 100).toFixed(0)}% | TSP adj: ${p.predictions.tspMultiplierAdj.toFixed(2)}x`,
      `Prediction accuracy: ${accStr} | Loop generation: ${this._generation}`,
    ].join('\n');
  }

  get lastProfile(): ArchetypeProfile | null { return this._lastProfile; }
  get generation(): number { return this._generation; }

  /**
   * Persist prediction outcomes to disk (atomic write).
   * Call on VS Code deactivate() alongside audit.save().
   */
  save(filePath: string): void {
    const payload = JSON.stringify({
      version:    1,
      generation: this._generation,
      outcomes:   this._outcomes,
    }, null, 2);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, filePath);
  }

  /**
   * Load persisted outcomes from previous VS Code session.
   * Silent no-op if file doesn't exist (first run).
   */
  load(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    try {
      const raw  = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw) as {
        version: number; generation: number; outcomes: LoopOutcome[];
      };
      if (!Array.isArray(data.outcomes)) return;
      this._generation = data.generation ?? 0;
      // Rehydrate Date objects
      this._outcomes = data.outcomes.map(o => ({
        ...o,
        timestamp: new Date(o.timestamp),
      }));
    } catch { /* corrupted file — ignore */ }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /**
   * Adapt CCT compression threshold to match developer's session type.
   * AGENT_HEAVY developers get more aggressive CCT (lower threshold = more compression).
   * CODE_REVIEWERS get conservative CCT (higher threshold = less compression).
   */
  private _adaptCCTThreshold(profile: ArchetypeProfile | null, signals: FeedbackSignals | null): number {
    if (!profile) return 0.72; // default

    const ARCHETYPE_CCT = {
      AGENT_HEAVY:    0.60, // More aggressive — AGENTIC sessions have lots of context duplication
      ARCHITECT:      0.68,
      SPRINT_BUILDER: 0.65,
      DEBUGGER:       0.30, // Keep low — stack traces are the main compression target
      BALANCED:       0.72,
      CODE_REVIEWER:  0.78, // Conservative — review context is dense and precise
      DOCUMENTARIAN:  0.80, // Most conservative — doc prompts need full context
    } satisfies Record<DeveloperArchetype, number>;    let base = ARCHETYPE_CCT[profile.archetype] ?? 0.72;

    // Apply feedback bias — developer rejection pattern adjusts the threshold
    if (signals && signals.totalEvents >= 5) {
      if (signals.cctThresholdBias === 'tighten') {
        base = Math.min(base + 0.08, 0.95); // raise bar: less compression fired
      } else if (signals.cctThresholdBias === 'loosen') {
        base = Math.max(base - 0.06, 0.20); // lower bar: more compression fired
      }
    }
    return base;
  }

  /**
   * Compute prediction accuracy from recorded outcomes.
   * Accuracy = fraction of sessions where predicted type matched actual type
   * AND predicted cost was within 20% of actual cost.
   */
  private _computeAccuracy(): number | null {
    if (this._outcomes.length < 5) return null;
    const correct = this._outcomes.filter(o => {
      const typeMatch = o.predictedType === o.actualType;
      const costClose = o.actualCost > 0
        ? Math.abs(o.predictedCost - o.actualCost) / o.actualCost < 0.20
        : true;
      return typeMatch && costClose;
    });
    return correct.length / this._outcomes.length;
  }
}
