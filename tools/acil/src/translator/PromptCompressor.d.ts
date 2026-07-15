/**
 * ACIL — PromptCompressor (Chat-to-Completion Translator)
 *
 * Intercepts developer chat-format input before transmission to an AI API
 * and reformats it into token-efficient prompt completion format.
 *
 * NOVEL CLAIM (Wave 10 Claim 8 + Claim 11):
 * No prior art translates developer IDE input format pre-transmission
 * for cost reduction while preserving semantic equivalence and session continuity.
 *
 * Token savings observed (inventor's June 2026 data, retroactive analysis):
 *   528 requests × avg 40-120 tokens chat overhead = 21,120–63,360 tokens saved
 *   At COPILOT_PREMIUM pricing ($0.04/req): that day with CCT active → ~200-250 req
 *   Quota would NOT have been exhausted. $0 overage.
 *
 * Implementation note:
 *   Phase 5 v1 = rule-based compression (deterministic, testable, fast).
 *   Phase 5 v2 = LLM-assisted compression with semantic equivalence check.
 *   Both versions preserve the intent; v2 adds embedding similarity verification.
 */
import { SessionType } from '../core/types';
import { SemanticEquivalenceOptions } from './SemanticEquivalenceChecker';
export declare enum InputFormat {
    CHAT = "CHAT",// OpenAI-style [{role, content}] array
    INSTRUCT = "INSTRUCT",// [INST] ... [/INST] format
    COMPLETION = "COMPLETION"
}
export interface CompressionResult {
    originalText: string;
    compressedText: string;
    originalTokenEst: number;
    compressedTokenEst: number;
    savingsPct: number;
    applied: boolean;
    equivalenceScore?: number;
}
export declare class PromptCompressor {
    private _checker;
    constructor(opts?: SemanticEquivalenceOptions);
    /**
     * Compress a developer's natural language input based on session type.
     * Strips chat overhead while preserving semantic intent.
     * Wave 10 Claim 8: the pre-transmission format optimization method.
     * Wave 10 Claim 11: Jaccard equivalence gate (rejects if score < threshold).
     */
    compress(raw: string, sessionType: SessionType): CompressionResult;
    /** Remove conversational filler ("Hey, can you please help me...") */
    private _stripConversational;
    /** Extract the core imperative task from a verbose query */
    private _extractCoreTask;
    /** Compress verbose stack traces to essential lines */
    private _compressStackTrace;
    /** Distill documentation intent to direct generation instruction */
    private _distillDocIntent;
    /** Remove repeated context blocks in long agentic prompts */
    private _deduplicateContext;
    /** Remove boilerplate system prompt preamble (repeated in agent chains) */
    private _stripSystemPreamble;
    /** Rough token estimate: ~4 chars per token (GPT tokenizer approximation) */
    private _estimateTokens;
}
//# sourceMappingURL=PromptCompressor.d.ts.map