/**
 * ACIL — AuditTrail
 *
 * Persistent log of all SessionEvents for a developer.
 * Implements Intertrust's "meter trail UDE" pattern — separate audit records
 * for internal metering and external reporting (US5892900A, public domain).
 *
 * Provides the data foundation for:
 * - The Temporal Spend Predictor (TSP) burn rate calculations
 * - The Pre-Execution Burn Rate Predictor (PEBP) historical profiles
 * - The enterprise governance dashboard session attribution
 *
 * Phase 0: in-memory store. Phase 6+ migrates to SQLite (local) → PostgreSQL (cloud).
 */

import { SessionEvent, SessionType, ModelId, EnforcementState } from './types';
import * as fs from 'fs';
import * as path from 'path';

export interface DailyBurnRecord {
  date:         string;             // YYYY-MM-DD
  totalRequests: number;
  grossCost:    number;
  discountAmount: number;
  netCost:      number;
  bySessionType: Partial<Record<SessionType, number>>;  // requests per type
  byModel:       Partial<Record<ModelId, number>>;       // requests per model
  hitOverage:   boolean;            // true if quota exhausted during this day
}

export interface AuditSummary {
  periodStart:  Date;
  periodEnd:    Date;
  totalEvents:  number;
  totalTokens:  number;
  totalGross:   number;
  totalNet:     number;
  totalDiscount: number;
  cctSavingsTokens: number;        // Total tokens saved via CCT translation
  dailyBurns:   DailyBurnRecord[];
  bySessionType: Partial<Record<SessionType, number>>;
  byModel:       Partial<Record<ModelId, number>>;
  enforcementStateHistory: Array<{ timestamp: Date; state: EnforcementState }>;
}

export class AuditTrail {
  private _events: SessionEvent[] = [];
  private _enforcementLog: Array<{ timestamp: Date; state: EnforcementState }> = [];

  /**
   * Append a completed SessionEvent to the audit trail.
   * Called by the metering pipeline after each API call completes.
   */
  append(event: SessionEvent): void {
    this._events.push(event);
  }

  /**
   * Record an enforcement state transition.
   * Provides the timeline for: "when did quota exhaust?" analysis.
   */
  logEnforcementState(state: EnforcementState): void {
    const last = this._enforcementLog[this._enforcementLog.length - 1];
    if (!last || last.state !== state) {
      this._enforcementLog.push({ timestamp: new Date(), state });
    }
  }

  /**
   * Returns daily burn records grouped by date.
   * This is the data structure that powers TSP's rolling burn rate calculator.
   *
   * Empirical reference: the June 2026 CSV data (imKrisK GitHub report)
   * is exactly this format — ACIL generates it natively.
   */
  dailyBurns(from?: Date, to?: Date): DailyBurnRecord[] {
    const grouped = new Map<string, SessionEvent[]>();

    for (const event of this._events) {
      if (from && event.timestamp < from) continue;
      if (to   && event.timestamp > to)   continue;

      const key = event.timestamp.toISOString().slice(0, 10);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(event);
    }

    const records: DailyBurnRecord[] = [];

    for (const [date, events] of Array.from(grouped.entries()).sort()) {
      const byType:  Partial<Record<SessionType, number>> = {};
      const byModel: Partial<Record<ModelId, number>>     = {};
      let gross = 0, discount = 0, net = 0, requests = 0;

      for (const e of events) {
        gross    += e.grossCost;
        discount += e.discountAmount;
        net      += e.netCost;
        requests++;
        byType[e.sessionType]  = (byType[e.sessionType]  ?? 0) + 1;
        byModel[e.modelId]     = (byModel[e.modelId]     ?? 0) + 1;
      }

      records.push({
        date,
        totalRequests: requests,
        grossCost:     gross,
        discountAmount: discount,
        netCost:       net,
        bySessionType: byType,
        byModel:       byModel,
        hitOverage:    net > 0,
      });
    }

    return records;
  }

  /**
   * Full audit summary for a period.
   */
  summarize(from?: Date, to?: Date): AuditSummary {
    const relevant = this._events.filter(e =>
      (!from || e.timestamp >= from) && (!to || e.timestamp <= to)
    );

    const byType:  Partial<Record<SessionType, number>> = {};
    const byModel: Partial<Record<ModelId, number>>     = {};
    let tokens = 0, gross = 0, net = 0, discount = 0, cctSaved = 0;

    for (const e of relevant) {
      tokens   += e.usage.totalTokens;
      gross    += e.grossCost;
      net      += e.netCost;
      discount += e.discountAmount;
      byType[e.sessionType]  = (byType[e.sessionType]  ?? 0) + 1;
      byModel[e.modelId]     = (byModel[e.modelId]     ?? 0) + 1;
      if (e.originalTokens != null && e.translatedTokens != null) {
        cctSaved += e.originalTokens - e.translatedTokens;
      }
    }

    return {
      periodStart:  from ?? (relevant[0]?.timestamp ?? new Date()),
      periodEnd:    to   ?? (relevant[relevant.length - 1]?.timestamp ?? new Date()),
      totalEvents:  relevant.length,
      totalTokens:  tokens,
      totalGross:   gross,
      totalNet:     net,
      totalDiscount: discount,
      cctSavingsTokens: cctSaved,
      dailyBurns:   this.dailyBurns(from, to),
      bySessionType: byType,
      byModel:       byModel,
      enforcementStateHistory: this._enforcementLog,
    };
  }

  get eventCount(): number {
    return this._events.length;
  }

  /**
   * Export events as JSON (for persistence or reporting).
   */
  export(): SessionEvent[] {
    return [...this._events];
  }

  /**
   * Persist audit trail to a JSON file.
   * Called by VS Code extension on deactivate() and periodically.
   * Safe to call multiple times — atomic write via temp file + rename.
   *
   * @param filePath Absolute path to the JSON file (e.g. in VS Code globalStorageUri)
   */
  save(filePath: string): void {
    const payload = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      events:  this._events,
    }, null, 2);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, filePath);
  }

  /**
   * Load events from a previously saved JSON file.
   * Merges loaded events with any already in memory (deduplicates by eventId).
   * Silently no-ops if the file doesn't exist.
   *
   * @param filePath Absolute path to the JSON file
   */
  load(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    try {
      const raw  = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw) as { version: number; events: SessionEvent[] };
      if (!Array.isArray(data.events)) return;
      const existingIds = new Set(this._events.map(e => e.eventId));
      let loaded = 0;
      for (const ev of data.events) {
        if (!existingIds.has(ev.eventId)) {
          // Rehydrate Date objects (JSON.parse returns strings)
          ev.timestamp = new Date(ev.timestamp);
          this._events.push(ev);
          loaded++;
        }
      }
      this._events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    } catch {
      // Corrupted file — ignore, don't crash
    }
  }
}
