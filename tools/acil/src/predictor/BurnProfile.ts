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
export const BASELINE_BURN_PROFILES: Record<SessionType, SessionBurnBaseline> = {
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
};

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
}
