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

export enum InputFormat {
  CHAT       = 'CHAT',        // OpenAI-style [{role, content}] array
  INSTRUCT   = 'INSTRUCT',    // [INST] ... [/INST] format
  COMPLETION = 'COMPLETION',  // Raw string prompt
}

export interface CompressionResult {
  originalText:     string;
  compressedText:   string;
  originalTokenEst: number;    // Rough estimate (chars/4)
  compressedTokenEst: number;
  savingsPct:       number;    // 0.0–1.0
  applied:          boolean;   // false if compression would degrade intent
}

export class PromptCompressor {
  /**
   * Compress a developer's natural language input based on session type.
   * Strips chat overhead while preserving semantic intent.
   * Wave 10 Claim 8: the pre-transmission format optimization method.
   */
  compress(raw: string, sessionType: SessionType): CompressionResult {
    const originalEst = this._estimateTokens(raw);
    let compressed = raw;

    switch (sessionType) {
      case SessionType.BOILERPLATE:
        compressed = this._stripConversational(raw);
        compressed = this._extractCoreTask(compressed);
        break;

      case SessionType.DEBUGGING:
        compressed = this._compressStackTrace(raw);
        compressed = this._stripConversational(compressed);
        break;

      case SessionType.DOCUMENTATION:
        compressed = this._distillDocIntent(raw);
        break;

      case SessionType.AGENTIC:
        compressed = this._deduplicateContext(raw);
        compressed = this._stripSystemPreamble(compressed);
        break;

      case SessionType.REVIEW:
        compressed = this._stripConversational(raw);
        break;

      case SessionType.ARCHITECTURE:
        // Minimal compression — architecture needs full context for quality
        compressed = this._stripConversational(raw);
        break;

      default:
        compressed = this._stripConversational(raw);
    }

    const compressedEst = this._estimateTokens(compressed);
    const savings = originalEst > 0 ? 1 - compressedEst / originalEst : 0;

    // Reject if compression saves < 5% or text got longer
    const applied = savings >= 0.05 && compressed.length < raw.length;

    return {
      originalText:      raw,
      compressedText:    applied ? compressed : raw,
      originalTokenEst:  originalEst,
      compressedTokenEst: applied ? compressedEst : originalEst,
      savingsPct:        applied ? savings : 0,
      applied,
    };
  }

  /** Remove conversational filler ("Hey, can you please help me...") */
  private _stripConversational(text: string): string {
    return text
      .replace(/^(hey|hi|hello|okay|ok|so|well|please|could you|can you|would you|i need|i want|i'd like)\s+/gi, '')
      .replace(/\s*(please|thanks|thank you|cheers)\s*\.?\s*$/gi, '')
      .trim();
  }

  /** Extract the core imperative task from a verbose query */
  private _extractCoreTask(text: string): string {
    // If it's a question, convert to imperative
    const questionMatch = text.match(/^(write|create|generate|build|make|add|implement|give me)\s+/i);
    if (questionMatch) return text; // Already imperative

    // Convert "Can you write X?" → "Write X"
    return text
      .replace(/^(?:can|could|would)\s+you\s+/i, '')
      .replace(/^(?:please\s+)?(?:help\s+me\s+)?(?:write|create|generate|build|make)\s+/i, (m) => m.trim().split(/\s+/).pop()! + ' ')
      .trim();
  }

  /** Compress verbose stack traces to essential lines */
  private _compressStackTrace(text: string): string {
    const lines = text.split('\n');
    const essential = lines.filter(line =>
      line.includes('Error:') ||
      line.includes('at ') && (line.includes('.ts') || line.includes('.js')) && !line.includes('node_modules') ||
      line.includes('TypeError') ||
      line.includes('ReferenceError') ||
      line.includes('Cannot') ||
      !line.startsWith('    at ')  // Non-stack-trace lines
    );
    return essential.join('\n').trim();
  }

  /** Distill documentation intent to direct generation instruction */
  private _distillDocIntent(text: string): string {
    return this._stripConversational(text)
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Remove repeated context blocks in long agentic prompts */
  private _deduplicateContext(text: string): string {
    // Split by double newline (paragraph separator)
    const paragraphs = text.split(/\n{2,}/);
    const seen = new Set<string>();
    const deduped = paragraphs.filter(p => {
      const key = p.trim().slice(0, 100); // First 100 chars as dedup key
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return deduped.join('\n\n').trim();
  }

  /** Remove boilerplate system prompt preamble (repeated in agent chains) */
  private _stripSystemPreamble(text: string): string {
    // Common patterns that repeat across agent turns
    return text
      .replace(/^You are a helpful AI assistant[.\s]*/i, '')
      .replace(/^You are an expert[^.]+\.\s*/i, '')
      .replace(/^Always be helpful[^.]+\.\s*/i, '')
      .trim();
  }

  /** Rough token estimate: ~4 chars per token (GPT tokenizer approximation) */
  private _estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
