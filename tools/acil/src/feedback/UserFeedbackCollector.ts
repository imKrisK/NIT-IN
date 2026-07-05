/**
 * ACIL — UserFeedbackCollector
 *
 * Tracks developer accept/reject decisions on ACIL recommendations so the
 * MetaRecursiveLoop can learn which suggestions are trusted vs. ignored.
 *
 * Three feedback signals collected:
 *   1. Model substitution — did developer accept the cheaper model suggestion?
 *   2. CCT compression — did developer let the compressed prompt through?
 *   3. Budget enforcement — did developer override a soft-block?
 *
 * Feedback is persisted to `acil-feedback.json` alongside audit data.
 * The MetaRecursiveLoop calls `getSignals()` during calibrate() to adjust:
 *   - Model substitution confidence weight
 *   - CCT threshold (if developer keeps rejecting, raise it)
 *   - Soft-block override rate (signals budget misconfiguration)
 *
 * Author: imKrisK — Wave 11 Learning Layer
 */

import * as fs   from 'fs';
import * as path from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export type FeedbackAction =
  | 'MODEL_SUB_ACCEPTED'
  | 'MODEL_SUB_REJECTED'
  | 'CCT_ACCEPTED'
  | 'CCT_REJECTED'
  | 'SOFT_BLOCK_OVERRIDDEN'
  | 'AGENTIC_CONFIRMED'
  | 'AGENTIC_CANCELLED'
  | 'BUDGET_INCREASED'
  | 'BUDGET_IGNORED';

export interface FeedbackEvent {
  action:     FeedbackAction;
  timestamp:  string;         // ISO-8601
  context?:   string;         // e.g. original model, compression ratio, etc.
  sessionType?: string;
}

export interface FeedbackSignals {
  /** 0.0–1.0 — higher = developer trusts model substitutions */
  modelSubAcceptRate:      number;
  /** 0.0–1.0 — higher = developer accepts CCT compressions */
  cctAcceptRate:           number;
  /** 0.0–1.0 — higher = developer overrides blocks frequently */
  softBlockOverrideRate:   number;
  /** 0.0–1.0 — higher = agentic sessions confirmed rather than cancelled */
  agenticConfirmRate:      number;
  /** Total feedback events recorded */
  totalEvents:             number;
  /** Recommendation: whether to loosen or tighten CCT threshold */
  cctThresholdBias:        'loosen' | 'tighten' | 'stable';
  /** Whether model sub confidence should increase/decrease */
  modelSubConfidenceBias:  'increase' | 'decrease' | 'stable';
}

const VERSION = 1;

// ── UserFeedbackCollector ────────────────────────────────────────────────────

export class UserFeedbackCollector {
  private _events: FeedbackEvent[] = [];

  // ── Record ──────────────────────────────────────────────────────────────

  record(action: FeedbackAction, context?: string, sessionType?: string): void {
    this._events.push({
      action,
      timestamp:   new Date().toISOString(),
      context,
      sessionType,
    });
  }

  /** Convenience: record model sub accepted or rejected in one call. */
  recordModelSub(accepted: boolean, fromModel: string, toModel: string): void {
    this.record(
      accepted ? 'MODEL_SUB_ACCEPTED' : 'MODEL_SUB_REJECTED',
      `${fromModel}→${toModel}`,
    );
  }

  /** Convenience: record CCT accepted or rejected. */
  recordCCT(accepted: boolean, savingsPct: number, sessionType?: string): void {
    this.record(
      accepted ? 'CCT_ACCEPTED' : 'CCT_REJECTED',
      `savings=${Math.round(savingsPct * 100)}%`,
      sessionType,
    );
  }

  /** Convenience: record agentic gate decision. */
  recordAgentic(confirmed: boolean): void {
    this.record(confirmed ? 'AGENTIC_CONFIRMED' : 'AGENTIC_CANCELLED');
  }

  /** Convenience: record soft-block outcome. */
  recordSoftBlock(overridden: boolean): void {
    this.record(overridden ? 'SOFT_BLOCK_OVERRIDDEN' : 'BUDGET_IGNORED');
  }

  // ── Analyze ─────────────────────────────────────────────────────────────

  /** Compute learning signals for MetaRecursiveLoop.calibrate(). */
  getSignals(): FeedbackSignals {
    const modelSubs    = this._events.filter(e => e.action === 'MODEL_SUB_ACCEPTED' || e.action === 'MODEL_SUB_REJECTED');
    const cctEvents    = this._events.filter(e => e.action === 'CCT_ACCEPTED'       || e.action === 'CCT_REJECTED');
    const blockEvents  = this._events.filter(e => e.action === 'SOFT_BLOCK_OVERRIDDEN');
    const agenticEvts  = this._events.filter(e => e.action === 'AGENTIC_CONFIRMED'  || e.action === 'AGENTIC_CANCELLED');

    const rate = (accepted: string, events: FeedbackEvent[]): number => {
      if (events.length === 0) return 0.5; // neutral when no data
      return events.filter(e => e.action === accepted).length / events.length;
    };

    const modelSubAcceptRate    = rate('MODEL_SUB_ACCEPTED', modelSubs);
    const cctAcceptRate         = rate('CCT_ACCEPTED', cctEvents);
    const agenticConfirmRate    = rate('AGENTIC_CONFIRMED', agenticEvts);
    const softBlockOverrideRate = blockEvents.length > 0
      ? blockEvents.length / Math.max(this._events.length, 1)
      : 0;

    // Derive biases from rates (thresholds tuned from empirical testing)
    const cctThresholdBias: FeedbackSignals['cctThresholdBias'] =
      cctAcceptRate < 0.35 ? 'tighten' :   // developer keeps rejecting → raise bar
      cctAcceptRate > 0.80 ? 'loosen'  :   // developer always accepts → can be more aggressive
      'stable';

    const modelSubConfidenceBias: FeedbackSignals['modelSubConfidenceBias'] =
      modelSubAcceptRate < 0.40 ? 'decrease' :
      modelSubAcceptRate > 0.75 ? 'increase' :
      'stable';

    return {
      modelSubAcceptRate,
      cctAcceptRate,
      softBlockOverrideRate,
      agenticConfirmRate,
      totalEvents:            this._events.length,
      cctThresholdBias,
      modelSubConfidenceBias,
    };
  }

  /** Recent events (last N), newest first. */
  recent(n = 20): FeedbackEvent[] {
    return [...this._events].reverse().slice(0, n);
  }

  get totalEvents(): number { return this._events.length; }

  // ── Persistence ─────────────────────────────────────────────────────────

  save(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = { version: VERSION, events: this._events };
    const tmp  = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  load(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    try {
      const raw  = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw) as { version: number; events: FeedbackEvent[] };
      if (Array.isArray(data.events)) {
        this._events = data.events;
      }
    } catch {
      // Corrupted file — start fresh, don't crash
    }
  }
}
