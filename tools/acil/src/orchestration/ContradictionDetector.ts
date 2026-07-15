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

export type ConflictType =
  | 'architecture'   // contradicting tech stack choices
  | 'approach'       // contradicting implementation strategies
  | 'naming'         // contradicting variable/function naming
  | 'dependency'     // contradicting package recommendations
  | 'security'       // contradicting security practices — highest priority
  | 'none';

export type ResolutionPolicy = 'block' | 'flag' | 'allow';

export interface ContradictionResult {
  contradictionScore: number;   // 0.0 = identical, 1.0 = direct contradiction
  conflictType:       ConflictType;
  resolution:         ResolutionPolicy;
  priorSource?:       string;   // which agent made the prior claim
  priorExcerpt?:      string;   // the conflicting prior statement
  flagMessage?:       string;   // human-readable conflict description
}

export interface DetectorConfig {
  flagThreshold:  number;   // contradiction score above which to flag (default 0.65)
  blockThreshold: number;   // score above which to block (default 0.90)
  windowMs:       number;   // session memory window in ms (default 5 min)
  maxHistory:     number;   // max stored responses (default 20)
}

interface StoredResponse {
  source:    string;
  text:      string;
  timestamp: number;
  keywords:  Set<string>;
}

// Words that indicate a position/stance
const POSITION_MARKERS = new Set([
  'use','should','recommend','prefer','avoid','instead','better','worse',
  'never','always','must','don\'t','do','best','worst','only','not',
  'postgresql','mysql','mongodb','redis','sqlite','dynamodb',
  'react','vue','angular','svelte','nextjs','nuxt',
  'typescript','javascript','python','go','rust','java',
  'docker','kubernetes','serverless','microservice','monolith',
  'rest','graphql','grpc','websocket',
  'jwt','oauth','session','cookie','apikey',
]);

export class ContradictionDetector {
  private _config:  Required<DetectorConfig>;
  private _history: StoredResponse[] = [];

  constructor(config: Partial<DetectorConfig> = {}) {
    this._config = {
      flagThreshold:  config.flagThreshold  ?? 0.65,
      blockThreshold: config.blockThreshold ?? 0.90,
      windowMs:       config.windowMs       ?? 5 * 60 * 1000,
      maxHistory:     config.maxHistory     ?? 20,
    };
  }

  /**
   * Check an incoming response for contradictions against recent history.
   * Call this before delivering any agent response to the developer.
   */
  detect(source: string, responseText: string): ContradictionResult {
    const now      = Date.now();
    const keywords = this._extractKeywords(responseText);

    // Expire old history
    this._history = this._history.filter(h => now - h.timestamp < this._config.windowMs);

    let bestContra = 0;
    let bestPrior: StoredResponse | null = null;

    for (const prior of this._history) {
      if (prior.source === source) continue; // don't compare to self
      const score = this._contradictionScore(keywords, responseText, prior);
      if (score > bestContra) {
        bestContra = score;
        bestPrior  = prior;
      }
    }

    // Store this response
    this._history.push({ source, text: responseText, timestamp: now, keywords });
    if (this._history.length > this._config.maxHistory) this._history.shift();

    const conflictType = bestContra > 0.50 ? this._classifyConflict(responseText, bestPrior?.text ?? '') : 'none';

    const resolution: ResolutionPolicy =
      bestContra >= this._config.blockThreshold ? 'block' :
      bestContra >= this._config.flagThreshold  ? 'flag'  :
      'allow';

    const flagMessage = resolution !== 'allow' && bestPrior
      ? `⚠️ ${source} may contradict ${bestPrior.source} on ${conflictType}. Review both responses.`
      : undefined;

    return {
      contradictionScore: Math.round(bestContra * 100) / 100,
      conflictType,
      resolution,
      priorSource:  bestPrior?.source,
      priorExcerpt: bestPrior ? bestPrior.text.slice(0, 120) + '...' : undefined,
      flagMessage,
    };
  }

  /** Clear session history (e.g. on new file open or explicit reset). */
  clearHistory(): void {
    this._history = [];
  }

  get historySize(): number { return this._history.length; }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _extractKeywords(text: string): Set<string> {
    const words = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
    return new Set(words.filter(w => POSITION_MARKERS.has(w) || w.length > 5));
  }

  private _contradictionScore(kw: Set<string>, text: string, prior: StoredResponse): number {
    // Jaccard on position keywords — low overlap = potential contradiction
    const intersection = [...kw].filter(k => prior.keywords.has(k)).length;
    const union        = new Set([...kw, ...prior.keywords]).size;
    if (union === 0) return 0;
    const similarity   = intersection / union;

    // Penalize negation asymmetry — one says "use X", other says "don't use X"
    const negA = (text.match(/\b(don't|avoid|never|not|instead)\b/gi) ?? []).length;
    const negB = (prior.text.match(/\b(don't|avoid|never|not|instead)\b/gi) ?? []).length;
    const negPenalty = Math.abs(negA - negB) > 1 ? 0.20 : 0;

    return Math.min(1.0, (1 - similarity * 0.7) * 0.6 + negPenalty);
  }

  private _classifyConflict(textA: string, textB: string): ConflictType {
    const combined = (textA + ' ' + textB).toLowerCase();
    if (/sql|postgres|mongo|mysql|redis|dynamo|sqlite/.test(combined)) return 'architecture';
    if (/jwt|oauth|session|cookie|auth|security|encrypt/.test(combined)) return 'security';
    if (/import|require|package|library|dependency|npm|pip/.test(combined)) return 'dependency';
    if (/function|method|variable|class|interface|type/.test(combined)) return 'naming';
    return 'approach';
  }
}
