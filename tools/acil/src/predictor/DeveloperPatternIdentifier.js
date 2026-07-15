"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeveloperPatternIdentifier = void 0;
const types_1 = require("../core/types");
class DeveloperPatternIdentifier {
    /**
     * Analyze daily burn records + session events to produce an ArchetypeProfile.
     * Called after each session batch to continuously refine the developer's identity.
     *
     * Wave 11: This is the self-referential loop — ACIL analyzing its own audit data
     * to improve its own predictions. Dogfooding at the intelligence layer.
     */
    identify(sessions, dailyBurns) {
        if (sessions.length < 5)
            return null; // Not enough data for reliable classification
        // ── Session type mix ──────────────────────────────────────────────────────
        const typeCounts = {};
        for (const s of sessions) {
            typeCounts[s.sessionType] = (typeCounts[s.sessionType] ?? 0) + 1;
        }
        const total = sessions.length;
        const mix = {};
        let dominantType = types_1.SessionType.UNKNOWN;
        let dominantFrac = 0;
        for (const [type, count] of Object.entries(typeCounts)) {
            const frac = count / total;
            mix[type] = frac;
            if (frac > dominantFrac) {
                dominantFrac = frac;
                dominantType = type;
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
        const tspAdj = this._tspMultiplierAdjustment(archetype, mix);
        // ── Cost estimate for next session ────────────────────────────────────────
        const COST_BY_TYPE = {
            [types_1.SessionType.AGENTIC]: 0.92,
            [types_1.SessionType.ARCHITECTURE]: 0.18,
            [types_1.SessionType.DEBUGGING]: 0.07,
            [types_1.SessionType.BOILERPLATE]: 0.024,
            [types_1.SessionType.DOCUMENTATION]: 0.014,
            [types_1.SessionType.REVIEW]: 0.06,
            [types_1.SessionType.UNKNOWN]: 0.04,
        };
        const nextCost = COST_BY_TYPE[nextSession] ?? 0.04;
        return {
            archetype,
            confidence: dominantFrac,
            dominantSession: dominantType,
            sessionMix: mix,
            avgDailyRequests: avgDaily,
            peakDayOfWeek: peakDOW,
            sprintBurstScore: Math.max(0, sprintBurst),
            predictions: {
                nextLikelySession: nextSession,
                nextSessionCostEst: nextCost,
                tspMultiplierAdj: tspAdj,
            },
        };
    }
    // ── Private ──────────────────────────────────────────────────────────────────
    _classify(mix, sprintBurst, dominant) {
        const ag = mix[types_1.SessionType.AGENTIC] ?? 0;
        const arch = mix[types_1.SessionType.ARCHITECTURE] ?? 0;
        const dbg = mix[types_1.SessionType.DEBUGGING] ?? 0;
        const bp = mix[types_1.SessionType.BOILERPLATE] ?? 0;
        const doc = mix[types_1.SessionType.DOCUMENTATION] ?? 0;
        const rev = mix[types_1.SessionType.REVIEW] ?? 0;
        if (ag > 0.30)
            return 'AGENT_HEAVY';
        if (arch > 0.40)
            return 'ARCHITECT';
        if (dbg > 0.35)
            return 'DEBUGGER';
        if (bp > 0.40 && sprintBurst > 0.3)
            return 'SPRINT_BUILDER';
        if (doc > 0.40)
            return 'DOCUMENTARIAN';
        if (rev > 0.40)
            return 'CODE_REVIEWER';
        return 'BALANCED';
    }
    _predictNext(sessions, dominant, peakDOW) {
        // Look at last 3 sessions to predict temporal sequence
        if (sessions.length < 3)
            return dominant;
        const last3 = sessions.slice(-3).map(s => s.sessionType);
        // If last session was ARCHITECTURE, next is often BOILERPLATE
        if (last3[2] === types_1.SessionType.ARCHITECTURE)
            return types_1.SessionType.BOILERPLATE;
        // If last two were DEBUGGING, next is often DEBUGGING again (debugging loops)
        if (last3[1] === types_1.SessionType.DEBUGGING && last3[2] === types_1.SessionType.DEBUGGING) {
            return types_1.SessionType.DEBUGGING;
        }
        // If today is Monday (sprint start), predict ARCHITECTURE
        if (new Date().getDay() === 1)
            return types_1.SessionType.ARCHITECTURE;
        // Default: next is dominant type
        return dominant;
    }
    /**
     * Compute a TSP multiplier adjustment for this developer's actual behavior.
     * A value of 1.0 = use baseline. >1.0 = more aggressive than baseline.
     */
    _tspMultiplierAdjustment(archetype, mix) {
        const ARCHETYPE_BASE = {
            AGENT_HEAVY: 2.2, // Burns hard — TSP should project faster
            ARCHITECT: 1.6,
            SPRINT_BUILDER: 1.4,
            DEBUGGER: 1.0,
            BALANCED: 1.0,
            CODE_REVIEWER: 0.8,
            DOCUMENTARIAN: 0.7,
        };
        return ARCHETYPE_BASE[archetype];
    }
}
exports.DeveloperPatternIdentifier = DeveloperPatternIdentifier;
