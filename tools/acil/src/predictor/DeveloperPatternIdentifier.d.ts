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
export type DeveloperArchetype = 'ARCHITECT' | 'DEBUGGER' | 'SPRINT_BUILDER' | 'AGENT_HEAVY' | 'DOCUMENTARIAN' | 'CODE_REVIEWER' | 'BALANCED';
export interface ArchetypeProfile {
    archetype: DeveloperArchetype;
    confidence: number;
    dominantSession: SessionType;
    sessionMix: Partial<Record<SessionType, number>>;
    avgDailyRequests: number;
    peakDayOfWeek: number;
    sprintBurstScore: number;
    predictions: {
        nextLikelySession: SessionType;
        nextSessionCostEst: number;
        tspMultiplierAdj: number;
    };
}
export interface DailyRecord {
    date: string;
    grossCost: number;
    totalRequests: number;
}
export interface SessionRecord {
    sessionType: SessionType;
    grossCost: number;
    timestamp: Date;
}
export declare class DeveloperPatternIdentifier {
    /**
     * Analyze daily burn records + session events to produce an ArchetypeProfile.
     * Called after each session batch to continuously refine the developer's identity.
     *
     * Wave 11: This is the self-referential loop — ACIL analyzing its own audit data
     * to improve its own predictions. Dogfooding at the intelligence layer.
     */
    identify(sessions: SessionRecord[], dailyBurns: DailyRecord[]): ArchetypeProfile | null;
    private _classify;
    private _predictNext;
    /**
     * Compute a TSP multiplier adjustment for this developer's actual behavior.
     * A value of 1.0 = use baseline. >1.0 = more aggressive than baseline.
     */
    private _tspMultiplierAdjustment;
}
//# sourceMappingURL=DeveloperPatternIdentifier.d.ts.map