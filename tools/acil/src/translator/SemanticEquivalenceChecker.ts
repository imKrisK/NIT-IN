/**
 * ACIL — SemanticEquivalenceChecker
 *
 * Wave 10 Claim 11:
 * "wherein computing the semantic equivalence score comprises generating
 *  vector embeddings of both the original input and the reformatted prompt
 *  using a pre-trained language model, computing the cosine similarity of
 *  said embeddings, and rejecting the reformatted prompt if the cosine
 *  similarity falls below a configurable minimum threshold value."
 *
 * Implementation — two tiers:
 *
 *   Tier 1 (this file — core package):
 *     Structural equivalence via Jaccard similarity on normalized word sets.
 *     Fast, deterministic, zero dependencies, testable.
 *     Used when no embedding model is available (CLI, unit tests, offline).
 *
 *   Tier 2 (vscode extension — Phase 25c):
 *     Semantic equivalence via vscode.lm.countTokens() + embedding model.
 *     Used when running inside VS Code with Copilot active.
 *     Injected via the `embedFn` option.
 *
 * The checker is the safety gate for CCT:
 *   - PromptCompressor produces a compressed candidate
 *   - SemanticEquivalenceChecker scores original vs compressed
 *   - If score < threshold → compression is REJECTED, original is sent
 *   - If score >= threshold → compression is ACCEPTED, compressed is sent
 *
 * This prevents CCT from accidentally stripping critical context.
 */

export interface EquivalenceResult {
  score:       number;   // 0.0–1.0 (1.0 = identical)
  accepted:    boolean;  // true = compressed version is safe to use
  method:      'jaccard' | 'cosine'; // which tier was used
  threshold:   number;   // the minimum score that was required
}

export type EmbedFn = (text: string) => Promise<number[]>;

export interface SemanticEquivalenceOptions {
  /** Minimum similarity score required to accept compression. Default: 0.72 */
  minThreshold?: number;
  /**
   * Optional embedding function (Tier 2 — injected from VS Code extension).
   * If not provided, falls back to Jaccard similarity (Tier 1).
   */
  embedFn?: EmbedFn;
}

export class SemanticEquivalenceChecker {
  private _threshold: number;
  private _embedFn:   EmbedFn | undefined;

  constructor(opts: SemanticEquivalenceOptions = {}) {
    this._threshold = opts.minThreshold ?? 0.72;
    this._embedFn   = opts.embedFn;
  }

  /**
   * Check whether the compressed text is semantically equivalent to the original.
   * Returns an EquivalenceResult; the caller decides whether to use compressed or original.
   */
  async check(original: string, compressed: string): Promise<EquivalenceResult> {
    if (original === compressed) {
      return { score: 1.0, accepted: true, method: 'jaccard', threshold: this._threshold };
    }

    if (this._embedFn) {
      return this._cosineSimilarity(original, compressed);
    }
    return this._jaccardSimilarity(original, compressed);
  }

  /** Synchronous Jaccard check — used by PromptCompressor (no async needed). */
  checkSync(original: string, compressed: string): EquivalenceResult {
    return this._jaccardSimilarity(original, compressed);
  }

  /** Update the minimum threshold (configurable per Wave 10 Claim 11). */
  setThreshold(value: number): void {
    if (value < 0 || value > 1) throw new RangeError('threshold must be 0.0–1.0');
    this._threshold = value;
  }

  get threshold(): number { return this._threshold; }

  // ── Tier 1: Jaccard similarity (structural proxy) ─────────────────────────

  private _jaccardSimilarity(a: string, b: string): EquivalenceResult {
    const setA = this._tokenize(a);
    const setB = this._tokenize(b);

    const intersection = new Set([...setA].filter(t => setB.has(t)));
    const union        = new Set([...setA, ...setB]);

    const score = union.size > 0 ? intersection.size / union.size : 1.0;

    return {
      score,
      accepted:  score >= this._threshold,
      method:    'jaccard',
      threshold: this._threshold,
    };
  }

  private _tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')  // strip punctuation
        .split(/\s+/)
        .filter(t => t.length > 2) // ignore short stop words
    );
  }

  // ── Tier 2: Cosine similarity on embeddings (injected from VS Code) ───────

  private async _cosineSimilarity(a: string, b: string): Promise<EquivalenceResult> {
    const [vecA, vecB] = await Promise.all([this._embedFn!(a), this._embedFn!(b)]);

    if (vecA.length !== vecB.length || vecA.length === 0) {
      // Fallback to Jaccard if embedding dimension mismatch
      return this._jaccardSimilarity(a, b);
    }

    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot   += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const score = (normA > 0 && normB > 0)
      ? dot / (Math.sqrt(normA) * Math.sqrt(normB))
      : 0;

    return {
      score,
      accepted:  score >= this._threshold,
      method:    'cosine',
      threshold: this._threshold,
    };
  }
}
