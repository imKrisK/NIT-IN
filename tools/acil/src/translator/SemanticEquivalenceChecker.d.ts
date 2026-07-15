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
    score: number;
    accepted: boolean;
    method: 'jaccard' | 'cosine';
    threshold: number;
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
export declare class SemanticEquivalenceChecker {
    private _threshold;
    private _embedFn;
    constructor(opts?: SemanticEquivalenceOptions);
    /**
     * Check whether the compressed text is semantically equivalent to the original.
     * Returns an EquivalenceResult; the caller decides whether to use compressed or original.
     */
    check(original: string, compressed: string): Promise<EquivalenceResult>;
    /** Synchronous Jaccard check — used by PromptCompressor (no async needed). */
    checkSync(original: string, compressed: string): EquivalenceResult;
    /** Update the minimum threshold (configurable per Wave 10 Claim 11). */
    setThreshold(value: number): void;
    get threshold(): number;
    private _jaccardSimilarity;
    private _tokenize;
    private _cosineSimilarity;
}
//# sourceMappingURL=SemanticEquivalenceChecker.d.ts.map