/**
 * ACIL — SessionClassifier
 *
 * Rule-based v1 Session-Type Classifier (STC).
 * Classifies an active developer session into a cost-relevant SessionType
 * BEFORE any AI API call is made.
 *
 * NOVEL CLAIM (Wave 10 Claim 1 + Claim 2):
 * No prior art classifies developer IDE sessions by work type before
 * token consumption begins. This is the anchor claim of the ACIL patent.
 *
 * Phase 1 implementation: rule-based (no ML required for MVP + filing).
 * Phase 1+ (post-filing): replace with fine-tuned classifier model.
 *
 * Signal inputs (from IDE telemetry stream):
 *   - fileChanges:        files opened/modified in current window
 *   - queryText:          developer's natural language input
 *   - toolCallSignatures: detected agent tool invocations
 *   - contextRatio:       fraction of context that is new query vs. existing code
 *   - newFileCount:       files created (not modified) in this session
 *   - errorContext:       presence of stack traces, error messages in context
 */

import { SessionType } from '../core/types';

export interface TelemetrySignals {
  queryText:           string;
  toolCallSignatures:  string[];      // e.g. ['bash', 'str_replace_editor', 'computer']
  newFileCount:        number;        // Files created this session
  modifiedFileCount:   number;        // Files modified this session
  contextRatio:        number;        // 0.0=all new query, 1.0=all existing code
  hasErrorContext:     boolean;       // Stack traces or error messages present
  existingFileSimilarity: number;     // 0.0–1.0 similarity to existing files (boilerplate signal)
}

export interface ClassificationResult {
  sessionType:  SessionType;
  confidence:   number;       // 0.0–1.0
  signals:      string[];     // Human-readable reasons for classification
}

// Keywords that indicate architecture/design sessions
const ARCHITECTURE_KEYWORDS = [
  'design', 'architect', 'system', 'schema', 'diagram', 'overview',
  'structure', 'plan', 'roadmap', 'scaffold', 'foundation', 'module',
  'service', 'api design', 'database design', 'how should', 'what is the best way',
];

// Keywords that indicate documentation sessions
const DOCUMENTATION_KEYWORDS = [
  'readme', 'comment', 'docstring', 'jsdoc', 'document', 'explain',
  'describe', 'write docs', 'add docs', 'documentation',
];

// Agentic tool call signatures (Claude Code, GitHub Copilot Agent, etc.)
const AGENTIC_TOOL_SIGNATURES = [
  'bash', 'computer', 'str_replace_editor', 'create_file',
  'multi_replace', 'run_in_terminal', 'agent', 'copilot_agent',
  'semantic_search', 'file_search', 'grep_search',
];

export class SessionClassifier {
  /**
   * Classify a session from telemetry signals.
   * Returns the most likely SessionType and a confidence score.
   *
   * Decision priority (highest to lowest):
   *   1. AGENTIC  — tool call signatures detected
   *   2. ARCHITECTURE — new files + design keywords
   *   3. DEBUGGING — error context present
   *   4. DOCUMENTATION — documentation keywords
   *   5. BOILERPLATE — high file similarity to existing
   *   6. REVIEW — high existing-code context ratio, no errors
   */
  classify(signals: TelemetrySignals): ClassificationResult {
    const q = signals.queryText.toLowerCase();

    // ── Priority 1: AGENTIC ────────────────────────────────────────────────
    const agenticMatches = signals.toolCallSignatures.filter(s =>
      AGENTIC_TOOL_SIGNATURES.includes(s.toLowerCase())
    );
    if (agenticMatches.length > 0 || this._containsAny(q, ['agent', 'run all', 'do everything', 'autonomously'])) {
      return {
        sessionType: SessionType.AGENTIC,
        confidence:  0.92,
        signals:     [`Agent tool calls detected: ${agenticMatches.join(', ') || 'query pattern'}`],
      };
    }

    // ── Priority 2: ARCHITECTURE ───────────────────────────────────────────
    const archKeywords = ARCHITECTURE_KEYWORDS.filter(k => q.includes(k));
    if (signals.newFileCount >= 3 || (archKeywords.length >= 2)) {
      const conf = signals.newFileCount >= 3 ? 0.85 : 0.75;
      return {
        sessionType: SessionType.ARCHITECTURE,
        confidence:  conf,
        signals:     [
          signals.newFileCount >= 3 ? `${signals.newFileCount} new files created` : '',
          archKeywords.length >= 2  ? `Keywords: ${archKeywords.slice(0, 3).join(', ')}` : '',
        ].filter(Boolean),
      };
    }

    // ── Priority 3: DEBUGGING ──────────────────────────────────────────────
    if (signals.hasErrorContext || this._containsAny(q, ['error', 'bug', 'fix', 'fail', 'crash', 'exception', 'why does', 'why is'])) {
      return {
        sessionType: SessionType.DEBUGGING,
        confidence:  signals.hasErrorContext ? 0.88 : 0.72,
        signals:     [signals.hasErrorContext ? 'Error context detected in window' : 'Debug keywords in query'],
      };
    }

    // ── Priority 4: DOCUMENTATION ─────────────────────────────────────────
    const docKeywords = DOCUMENTATION_KEYWORDS.filter(k => q.includes(k));
    if (docKeywords.length >= 1) {
      return {
        sessionType: SessionType.DOCUMENTATION,
        confidence:  0.80,
        signals:     [`Documentation keywords: ${docKeywords.slice(0, 3).join(', ')}`],
      };
    }

    // ── Priority 5: BOILERPLATE ───────────────────────────────────────────
    if (signals.existingFileSimilarity >= 0.70) {
      return {
        sessionType: SessionType.BOILERPLATE,
        confidence:  0.78,
        signals:     [`File similarity ${(signals.existingFileSimilarity * 100).toFixed(0)}% — repetitive pattern detected`],
      };
    }

    // ── Priority 6: REVIEW ────────────────────────────────────────────────
    if (signals.contextRatio >= 0.80 && this._containsAny(q, ['review', 'check', 'look at', 'what do you think', 'is this correct', 'feedback'])) {
      return {
        sessionType: SessionType.REVIEW,
        confidence:  0.74,
        signals:     ['High existing-code context ratio + review keywords'],
      };
    }

    // ── Default: DEBUGGING (catches most single-question interactions) ────
    return {
      sessionType: SessionType.DEBUGGING,
      confidence:  0.55,
      signals:     ['Default classification — no strong signal detected'],
    };
  }

  private _containsAny(text: string, keywords: string[]): boolean {
    return keywords.some(k => text.includes(k));
  }
}
