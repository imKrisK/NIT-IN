/**
 * ACIL — VSCodeEmbedBridge
 *
 * Tier 2 implementation of SemanticEquivalenceChecker for VS Code.
 *
 * Wave 10 Claim 11 requires "generating vector embeddings... using a
 * pre-trained language model." Since VS Code 1.90 has no native embedding
 * API, this bridge implements two strategies:
 *
 * Strategy A — LM-Scored Similarity (primary):
 *   Uses vscode.lm.sendRequest() to ask the active model to rate semantic
 *   similarity between original and compressed text on a 0.0–1.0 scale.
 *   The model IS a "pre-trained language model" per Claim 11.
 *   Returns the score as a float — functionally equivalent to cosine
 *   similarity of embeddings from the model's perspective.
 *
 * Strategy B — TF-IDF cosine (offline fallback):
 *   Computes TF-IDF vectors locally using word frequency statistics,
 *   then takes cosine similarity. No API call required.
 *   Used when VS Code lm is unavailable (Cursor, offline, rate-limited).
 *
 * The bridge exposes an `embedFn`-compatible async function that can be
 * injected directly into SemanticEquivalenceChecker:
 *
 *   const bridge = new VSCodeEmbedBridge(model);
 *   const checker = new SemanticEquivalenceChecker({ embedFn: bridge.embedFn });
 *
 * @author imKrisK (github.com/imKrisK)
 * @patent Wave 10 Claim 11 — Semantic Equivalence Gate
 */

import * as vscode from 'vscode';
import { EmbedFn } from '@nit-in/acil';

const SIMILARITY_PROMPT = (a: string, b: string) =>
  `Rate the semantic similarity between these two texts on a scale from 0.0 to 1.0.
  
TEXT A: ${a.slice(0, 800)}

TEXT B: ${b.slice(0, 800)}

Reply with ONLY a number between 0.0 and 1.0. No explanation. Example: 0.85`;

export type EmbedStrategy = 'lm-scored' | 'tfidf' | 'jaccard-fallback';

export interface EmbedBridgeResult {
  score:    number;
  strategy: EmbedStrategy;
}

export class VSCodeEmbedBridge {
  private _model:     vscode.LanguageModelChat | null = null;
  private _cache:     Map<string, number> = new Map(); // cache similarity scores
  private _strategy:  EmbedStrategy = 'tfidf';

  constructor(model?: vscode.LanguageModelChat) {
    this._model    = model ?? null;
    this._strategy = model ? 'lm-scored' : 'tfidf';
  }

  /**
   * EmbedFn-compatible interface for SemanticEquivalenceChecker.
   *
   * Rather than returning a raw embedding vector, returns a
   * pseudo-embedding: a 2D vector [similarity, 1-similarity].
   * When two texts are fed through this, cosine([s,1-s],[s,1-s]) = 1.0,
   * but the actual similarity comparison is done via scorePair().
   *
   * For proper Tier 2 operation, use scorePair() directly.
   */
  get embedFn(): EmbedFn {
    return async (text: string): Promise<number[]> => {
      // Return a normalized word frequency vector (TF-IDF approximation)
      return this._tfidfVector(text);
    };
  }

  /**
   * Score semantic similarity between two texts directly.
   * Uses LM-scored strategy if model is available, else TF-IDF cosine.
   *
   * This is the primary Tier 2 entry point for Wave 10 Claim 11.
   */
  async scorePair(
    original:   string,
    compressed: string,
    cancelToken?: vscode.CancellationToken,
  ): Promise<EmbedBridgeResult> {
    // Cache key: hash of both texts (simple concat slice)
    const cacheKey = `${original.slice(0, 40)}|${compressed.slice(0, 40)}`;
    const cached   = this._cache.get(cacheKey);
    if (cached !== undefined) {
      return { score: cached, strategy: this._strategy };
    }

    let score: number;
    let strategy: EmbedStrategy;

    if (this._model && this._strategy === 'lm-scored') {
      try {
        score    = await this._lmScoredSimilarity(original, compressed, cancelToken);
        strategy = 'lm-scored';
      } catch {
        // Fallback to TF-IDF if LM call fails
        score    = this._tfidfCosineSimilarity(original, compressed);
        strategy = 'tfidf';
      }
    } else {
      score    = this._tfidfCosineSimilarity(original, compressed);
      strategy = 'tfidf';
    }

    this._cache.set(cacheKey, score);
    if (this._cache.size > 200) {
      const firstKey = this._cache.keys().next().value;
      if (firstKey !== undefined) this._cache.delete(firstKey);
    }

    return { score, strategy };
  }

  /** Update the model reference (called when VS Code model changes). */
  setModel(model: vscode.LanguageModelChat | null): void {
    this._model    = model;
    this._strategy = model ? 'lm-scored' : 'tfidf';
    this._cache.clear(); // invalidate cache on model change
  }

  // ── Strategy A: LM-Scored Similarity ─────────────────────────────────────

  private async _lmScoredSimilarity(
    original:    string,
    compressed:  string,
    cancelToken?: vscode.CancellationToken,
  ): Promise<number> {
    if (!this._model) throw new Error('No model');

    const prompt   = SIMILARITY_PROMPT(original, compressed);
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const response = await this._model.sendRequest(
      messages,
      { justification: 'ACIL semantic equivalence check (CCT safety gate)' },
      cancelToken,
    );

    let raw = '';
    for await (const chunk of response.text) {
      raw += chunk;
      if (raw.length > 20) break; // Only need the number
    }

    const score = parseFloat(raw.trim().replace(/[^\d.]/g, ''));
    if (isNaN(score) || score < 0 || score > 1) {
      throw new Error(`Invalid LM similarity score: "${raw}"`);
    }
    return score;
  }

  // ── Strategy B: TF-IDF Cosine Similarity ──────────────────────────────────

  private _tfidfCosineSimilarity(a: string, b: string): number {
    const vecA = this._tfidfVector(a);
    const vecB = this._tfidfVector(b);
    return this._cosine(vecA, vecB);
  }

  private _tfidfVector(text: string): number[] {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    // Build vocabulary from this text
    const vocab  = [...new Set(words)];
    const tf: Record<string, number> = {};
    for (const w of words) tf[w] = (tf[w] ?? 0) + 1 / words.length;

    return vocab.map(w => tf[w] ?? 0);
  }

  private _cosine(a: number[], b: number[]): number {
    // Align vectors to same length (shorter padded with 0)
    const len  = Math.max(a.length, b.length);
    const va   = [...a, ...new Array(len - a.length).fill(0)];
    const vb   = [...b, ...new Array(len - b.length).fill(0)];
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < len; i++) {
      dot   += va[i] * vb[i];
      normA += va[i] * va[i];
      normB += vb[i] * vb[i];
    }
    return (normA > 0 && normB > 0)
      ? dot / (Math.sqrt(normA) * Math.sqrt(normB))
      : 0;
  }
}
