/**
 * ACIL — BurnProfile
 *
 * Per-developer historical token consumption profiles by session type.
 * Seeded with empirical baselines; calibrates to individual behavior over time.
 *
 * Used by BurnPredictor to personalize burn estimates.
 * The June 2026 imKrisK data provides the initial empirical baseline for AGENTIC:
 *   528 requests in 1 day = ~528 premium requests / ~6 hrs = 88 req/hr active session
 */

import { SessionType } from '../core/types';
import * as fs from 'fs';
import * as path from 'path';

export interface SessionBurnBaseline {
  minTokens:    number;
  maxTokens:    number;
  avgTokens:    number;
  p95Tokens:    number;    // 95th percentile (spike protection)
}

/**
 * Global empirical baselines (tokens per session).
 * Source: research data + inventor's June 2026 usage analysis.
 */
export const BASELINE_BURN_PROFILES = {
  [SessionType.AGENTIC]: {
    minTokens: 10_000, maxTokens: 500_000, avgTokens: 85_000, p95Tokens: 250_000,
  },
  [SessionType.ARCHITECTURE]: {
    minTokens: 5_000, maxTokens: 50_000, avgTokens: 18_000, p95Tokens: 40_000,
  },
  [SessionType.REVIEW]: {
    minTokens: 1_000, maxTokens: 10_000, avgTokens: 4_000, p95Tokens: 8_000,
  },
  [SessionType.DEBUGGING]: {
    minTokens: 500, maxTokens: 5_000, avgTokens: 1_800, p95Tokens: 4_000,
  },
  [SessionType.BOILERPLATE]: {
    minTokens: 100, maxTokens: 2_000, avgTokens: 600, p95Tokens: 1_500,
  },
  [SessionType.DOCUMENTATION]: {
    minTokens: 100, maxTokens: 1_000, avgTokens: 350, p95Tokens: 800,
  },
  [SessionType.UNKNOWN]: {
    minTokens: 500, maxTokens: 10_000, avgTokens: 2_000, p95Tokens: 7_000,
  },
} satisfies Record<SessionType, SessionBurnBaseline>;

export class BurnProfile {
  private _observed: Partial<Record<SessionType, number[]>> = {};

  /**
   * Record an observed token count for a session type.
   * Grows the personal calibration dataset over time.
   */
  record(sessionType: SessionType, tokens: number): void {
    if (!this._observed[sessionType]) this._observed[sessionType] = [];
    this._observed[sessionType]!.push(tokens);
  }

  /**
   * Returns a personalized baseline for a session type.
   * Falls back to global baseline until enough personal data exists (min 5 samples).
   */
  getBaseline(sessionType: SessionType): SessionBurnBaseline {
    const samples = this._observed[sessionType] ?? [];
    if (samples.length < 5) return BASELINE_BURN_PROFILES[sessionType];

    const sorted = [...samples].sort((a, b) => a - b);
    const avg    = samples.reduce((s, v) => s + v, 0) / samples.length;
    const p95idx = Math.floor(sorted.length * 0.95);
    return {
      minTokens: sorted[0],
      maxTokens: sorted[sorted.length - 1],
      avgTokens: Math.round(avg),
      p95Tokens: sorted[p95idx] ?? sorted[sorted.length - 1],
    };
  }

  get observedCount(): Partial<Record<SessionType, number>> {
    const out: Partial<Record<SessionType, number>> = {};
    for (const [k, v] of Object.entries(this._observed)) {
      out[k as SessionType] = (v as number[]).length;
    }
    return out;
  }

  /**
   * Persist personal calibration data to disk.
   * Atomic write (tmp → rename). Creates directory if needed.
   * Wave 10 Claim 2: developer-specific burn profile survives restarts.
   */
  save(filePath: string): void {
    const payload = JSON.stringify({
      version:  1,
      savedAt:  new Date().toISOString(),
      observed: this._observed,
    }, null, 2);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, filePath);
  }

  /**
   * Load personal calibration data from disk.
   * Merges with any existing in-memory samples (no duplicates, just appends).
   * Silent no-op if file doesn't exist (first run).
   */
  load(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    try {
      const raw  = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw) as {
        version: number;
        observed: Record<string, number[]>;
      };
      if (!data.observed || typeof data.observed !== 'object') return;
      for (const [key, samples] of Object.entries(data.observed)) {
        if (!Array.isArray(samples)) continue;
        const type = key as SessionType;
        if (!this._observed[type]) this._observed[type] = [];
        // Append (no dedup needed — all samples are valid historical data)
        this._observed[type]!.push(...samples);
      }
    } catch {
      // Corrupted file — ignore, don't crash
    }
  }
}
