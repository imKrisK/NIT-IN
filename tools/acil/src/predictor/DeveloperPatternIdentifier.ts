/**
 * ACIL — DeveloperPatternIdentifier
 *
 * Analyzes GitHub Copilot request history to classify the developer's
 * archetype — their dominant work pattern. This feeds back into the
 * SessionClassifier to personalize predictions BEFORE tokens burn.
 *
 * Wave 11 Concept: "Developer-Type Recursive Calibration"
 * Pattern: analyze → classify → feed back → improve predictions → loop
 *
 * Developer Archetypes (derived from session-type burn profiles):
 *
 *   ARCHITECT      — >40% ARCHITECTURE sessions, high new-file count
 *   DEBUGGER       — >35% DEBUGGING sessions, high error context ratio
 *   SPRINT_BUILDER — >50% BOILERPLATE, bursts of AGENTIC at sprint start
 *   AGENT_HEAVY    — >30% AGENTIC, highest per-session token burn
 *   DOCUMENTARIAN  — >40% DOCUMENTATION, low token variance
 *   CODE_REVIEWER  — >40% REVIEW, consistent low-cost sessions
 *   BALANCED       — No single type >30%, varied mix
 *
 * The archetype is used to:
 *   1. Adjust TSP burn rate multipliers to match actual behavior
 *   2. Pre-classify the NEXT session based on temporal patterns
 *   3. Surface developer-type insight in @acil /status output
 *   4. Feed the MetaRecursiveLoop for continuous self-calibration
 *
 * @author imKrisK (github.com/imKrisK)
 * @see https://conversationmine.ai
 * @patent Patent Pending — Wave 10 + Wave 11 (Meta-Recursive Calibration)
 */

import { SessionType } from '../core/types';

export type DeveloperArchetype =
  | 'ARCHITECT'
  | 'DEBUGGER'
  | 'SPRINT_BUILDER'
  | 'AGENT_HEAVY'
  | 'DOCUMENTARIAN'
  | 'CODE_REVIEWER'
  | 'BALANCED';

export interface ArchetypeProfile {
  archetype:        DeveloperArchetype;
  confidence:       number;              // 0.0–1.0
  dominantSession:  SessionType;
  sessionMix:       Partial<Record<SessionType, number>>; // fractions, sum=1
  avgDailyRequests: number;
  peakDayOfWeek:    number;              // 0=Sun, 1=Mon…6=Sat
  sprintBurstScore: number;              // 0.0–1.0 (how much Mon > other days)
  predictions: {
    nextLikelySession:  SessionType;
    nextSessionCostEst: number;          // USD
    tspMultiplierAdj:   number;          // multiplier adjustment vs baseline
  };
}

export interface DailyRecord {
  date:          string;  // YYYY-MM-DD
  grossCost:     number;
  totalRequests: number;
}

export interface SessionRecord {
  sessionType:   SessionType;
  grossCost:     number;
  timestamp:     Date;
}

export class DeveloperPatternIdentifier {
  /**
   * Analyze daily burn records + session events to produce an ArchetypeProfile.
   * Called after each session batch to continuously refine the developer's identity.
   *
   * Wave 11: This is the self-referential loop — ACIL analyzing its own audit data
   * to improve its own predictions. Dogfooding at the intelligence layer.
   */
  identify(
    sessions:   SessionRecord[],
    dailyBurns: DailyRecord[],
  ): ArchetypeProfile | null {
    if (sessions.length < 5) return null; // Not enough data for reliable classification

    // ── Session type mix ──────────────────────────────────────────────────────
    const typeCounts: Partial<Record<SessionType, number>> = {};
    for (const s of sessions) {
      typeCounts[s.sessionType] = (typeCounts[s.sessionType] ?? 0) + 1;
    }
    const total = sessions.length;
    const mix:   Partial<Record<SessionType, number>> = {};
    let dominantType = SessionType.UNKNOWN;
    let dominantFrac = 0;
    for (const [type, count] of Object.entries(typeCounts)) {
      const frac = (count as number) / total;
      mix[type as SessionType] = frac;
      if (frac > dominantFrac) {
        dominantFrac = frac;
        dominantType = type as SessionType;
      }
    }

    // ── Day-of-week pattern ───────────────────────────────────────────────────
    const dowCounts = new Array(7).fill(0);
    for (const s of sessions) {
      dowCounts[s.timestamp.getDay()]++;
    }
    const peakDOW = dowCounts.indexOf(Math.max(...dowCounts));
    // Sprint burst: Mon count vs average of Tue-Fri
    const monCount = dowCounts[1];
    const avgWeekday = (dowCounts[2] + dowCounts[3] + dowCounts[4] + dowCounts[5]) / 4;
    const sprintBurst = avgWeekday > 0 ? Math.min(1, (monCount - avgWeekday) / avgWeekday) : 0;

    // ── Average daily requests ────────────────────────────────────────────────
    const avgDaily = dailyBurns.length > 0
      ? dailyBurns.reduce((s, d) => s + d.totalRequests, 0) / dailyBurns.length
      : 0;

    // ── Archetype classification ──────────────────────────────────────────────
    const archetype = this._classify(mix, sprintBurst, dominantType);

    // ── Next session prediction ───────────────────────────────────────────────
    const nextSession = this._predictNext(sessions, dominantType, peakDOW);
    const tspAdj      = this._tspMultiplierAdjustment(archetype, mix);

    // ── Cost estimate for next session ────────────────────────────────────────
    const COST_BY_TYPE: Partial<Record<SessionType, number>> = {
      [SessionType.AGENTIC]:       0.92,
      [SessionType.ARCHITECTURE]:  0.18,
      [SessionType.DEBUGGING]:     0.07,
      [SessionType.BOILERPLATE]:   0.024,
      [SessionType.DOCUMENTATION]: 0.014,
      [SessionType.REVIEW]:        0.06,
      [SessionType.UNKNOWN]:       0.04,
    };
    const nextCost = COST_BY_TYPE[nextSession] ?? 0.04;

    return {
      archetype,
      confidence:        dominantFrac,
      dominantSession:   dominantType,
      sessionMix:        mix,
      avgDailyRequests:  avgDaily,
      peakDayOfWeek:     peakDOW,
      sprintBurstScore:  Math.max(0, sprintBurst),
      predictions: {
        nextLikelySession:  nextSession,
        nextSessionCostEst: nextCost,
        tspMultiplierAdj:   tspAdj,
      },
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _classify(
    mix:        Partial<Record<SessionType, number>>,
    sprintBurst: number,
    dominant:   SessionType,
  ): DeveloperArchetype {
    const ag   = mix[SessionType.AGENTIC]       ?? 0;
    const arch = mix[SessionType.ARCHITECTURE]  ?? 0;
    const dbg  = mix[SessionType.DEBUGGING]     ?? 0;
    const bp   = mix[SessionType.BOILERPLATE]   ?? 0;
    const doc  = mix[SessionType.DOCUMENTATION] ?? 0;
    const rev  = mix[SessionType.REVIEW]        ?? 0;

    if (ag > 0.30)                   return 'AGENT_HEAVY';
    if (arch > 0.40)                 return 'ARCHITECT';
    if (dbg > 0.35)                  return 'DEBUGGER';
    if (bp > 0.40 && sprintBurst > 0.3) return 'SPRINT_BUILDER';
    if (doc > 0.40)                  return 'DOCUMENTARIAN';
    if (rev > 0.40)                  return 'CODE_REVIEWER';
    return 'BALANCED';
  }

  private _predictNext(
    sessions:  SessionRecord[],
    dominant:  SessionType,
    peakDOW:   number,
  ): SessionType {
    // Look at last 3 sessions to predict temporal sequence
    if (sessions.length < 3) return dominant;
    const last3 = sessions.slice(-3).map(s => s.sessionType);

    // If last session was ARCHITECTURE, next is often BOILERPLATE
    if (last3[2] === SessionType.ARCHITECTURE) return SessionType.BOILERPLATE;
    // If last two were DEBUGGING, next is often DEBUGGING again (debugging loops)
    if (last3[1] === SessionType.DEBUGGING && last3[2] === SessionType.DEBUGGING) {
      return SessionType.DEBUGGING;
    }
    // If today is Monday (sprint start), predict ARCHITECTURE
    if (new Date().getDay() === 1) return SessionType.ARCHITECTURE;
    // Default: next is dominant type
    return dominant;
  }

  /**
   * Compute a TSP multiplier adjustment for this developer's actual behavior.
   * A value of 1.0 = use baseline. >1.0 = more aggressive than baseline.
   */
  private _tspMultiplierAdjustment(
    archetype: DeveloperArchetype,
    mix: Partial<Record<SessionType, number>>,
  ): number {
    const ARCHETYPE_BASE: Record<DeveloperArchetype, number> = {
      AGENT_HEAVY:    2.2,  // Burns hard — TSP should project faster
      ARCHITECT:      1.6,
      SPRINT_BUILDER: 1.4,
      DEBUGGER:       1.0,
      BALANCED:       1.0,
      CODE_REVIEWER:  0.8,
      DOCUMENTARIAN:  0.7,
    };
    return ARCHETYPE_BASE[archetype];
  }
}
