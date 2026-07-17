/**
 * ACIL Wave 12 — ContradictionDetector
 *
 * Detects semantic contradictions between outputs from parallel AI agents
 * BEFORE they are delivered to the developer.
 *
 * Problem this solves:
 *   When two AI agents (e.g. Copilot + Claude) answer the same or related
 *   questions in the same session, they may produce contradictory advice:
 *     Agent A: "Use PostgreSQL for this use case"
 *     Agent B: "Use MongoDB for this use case"
 *   Without detection, both responses surface to the developer silently.
 *   The developer loses trust or makes a wrong decision.
 *
 * How it works:
 *   1. Each completed agent response is stored in a rolling session window
 *   2. Incoming responses are scored against recent history
 *   3. High contradiction score → flag for human arbitration
 *   4. Developer sees both responses + the conflict clearly labeled
 *
 * Scoring method:
 *   - Jaccard similarity on normalized word sets (fast, synchronous)
 *   - Contradiction score = 1 - similarity of POSITION words
 *   - Position words: technology names, approach verbs, negative markers
 *
 * Patent: Wave 12 Claim 9
 * Author: imKrisK
 */
export type ConflictType = 'architecture' | 'approach' | 'naming' | 'dependency' | 'security' | 'none';
export type ResolutionPolicy = 'block' | 'flag' | 'allow';
export interface ContradictionResult {
    contradictionScore: number;
    conflictType: ConflictType;
    resolution: ResolutionPolicy;
    priorSource?: string;
    priorExcerpt?: string;
    flagMessage?: string;
}
export interface DetectorConfig {
    flagThreshold: number;
    blockThreshold: number;
    windowMs: number;
    maxHistory: number;
}
export declare class ContradictionDetector {
    private _config;
    private _history;
    constructor(config?: Partial<DetectorConfig>);
    /**
     * Check an incoming response for contradictions against recent history.
     * Call this before delivering any agent response to the developer.
     */
    detect(source: string, responseText: string): ContradictionResult;
    /** Clear session history (e.g. on new file open or explicit reset). */
    clearHistory(): void;
    get historySize(): number;
    private _extractKeywords;
    private _contradictionScore;
    private _classifyConflict;
}
//# sourceMappingURL=ContradictionDetector.d.ts.map