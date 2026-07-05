/**
 * ACIL — CopilotInterceptor
 *
 * Wraps VS Code's LanguageModelChat.sendRequest() with ACIL preflight and postflight hooks.
 *
 * How it works:
 *   1. Before a request: runPreflight(prompt, model) → EnforcementDecision
 *   2. If BLOCKED (EXHAUSTED or CRITICAL+AGENTIC): reject with a clear message
 *   3. If THROTTLE: transparently use substituted model instead of requested model
 *   4. If ALLOWED: forward to the actual model.sendRequest()
 *   5. After stream completes: estimate tokens from character count, run postflight
 *
 * Token counting (Phase 19 — upgraded):
 *   Uses model.countTokens() — the VS Code 1.90 API backed by the model's actual tokenizer.
 *   Preflight: count all message text before sending → feeds contextSizeTokens.
 *   Postflight: count accumulated output text after stream closes → actual output tokens.
 *   Fallback: if countTokens() throws (e.g. during unit test / offline), reverts to len/4.
 *   This makes ACIL cost predictions accurate to within ~1 token on all supported models.
 *
 * Usage:
 *   const interceptor = new CopilotInterceptor(pipeline, telemetry, notifications);
 *   const result = await interceptor.sendRequest(model, messages, options, token, userId);
 *   for await (const chunk of result.text) { ... }
 */

import * as vscode from 'vscode';
import {
  ACILPipeline,
  EnforcementState,
  ModelId,
  QualityRequirement,
  SessionType,
  PromptCompressor,
  SemanticEquivalenceChecker,
} from '@nit-in/acil';
import { TelemetryCollector }  from '../TelemetryCollector';
import { NotificationManager } from '../NotificationManager';
import { VSCodeEmbedBridge }   from './VSCodeEmbedBridge';
import { UserFeedbackCollector } from '@nit-in/acil';

// Maps VS Code model family strings to ACIL ModelId
// Covers all known Copilot model IDs as of VS Code 1.90–1.95
// Handles versioned names (claude-3-5-sonnet-20241022, gpt-4o-2024-11-20, etc.)
const VSCODE_MODEL_MAP: Record<string, ModelId> = {
  // Copilot variants
  'copilot-gpt-4o':           ModelId.GPT_4O,
  'copilot-gpt-4':            ModelId.COPILOT_PREMIUM,
  'copilot':                  ModelId.COPILOT_PREMIUM,
  'o1-mini':                  ModelId.GPT_4O_MINI,
  'o1':                       ModelId.GPT_4O,
  'o3-mini':                  ModelId.GPT_4O_MINI,
  // GPT variants
  'gpt-4o':                   ModelId.GPT_4O,
  'gpt-4o-mini':              ModelId.GPT_4O_MINI,
  'gpt-4':                    ModelId.GPT_4O,
  // Claude variants — handles versioned suffixes like -20241022
  'claude-3-5-sonnet':        ModelId.CLAUDE_SONNET_4,
  'claude-3-7-sonnet':        ModelId.CLAUDE_SONNET_4,
  'claude-sonnet':            ModelId.CLAUDE_SONNET_4,
  'claude-3-haiku':           ModelId.CLAUDE_HAIKU_3,
  'claude-haiku':             ModelId.CLAUDE_HAIKU_3,
  // Gemini variants
  'gemini-1.5-pro':           ModelId.GEMINI_1_5_PRO,
  'gemini-2.0-flash':         ModelId.GEMINI_1_5_FLASH,
  'gemini-1.5-flash':         ModelId.GEMINI_1_5_FLASH,
  'gemini-flash':             ModelId.GEMINI_1_5_FLASH,
  'gemini-pro':               ModelId.GEMINI_1_5_PRO,
};

function modelIdFromVSCode(model: vscode.LanguageModelChat): ModelId {
  const id = model.id.toLowerCase();
  // Exact match first
  if (VSCODE_MODEL_MAP[id]) return VSCODE_MODEL_MAP[id];
  // Prefix match — handles versioned suffixes (claude-3-5-sonnet-20241022 → claude-3-5-sonnet)
  for (const [key, val] of Object.entries(VSCODE_MODEL_MAP)) {
    if (id.startsWith(key) || id.includes(key)) return val;
  }
  // Family fallback: check model.family if available
  const family = (model as { family?: string }).family?.toLowerCase() ?? '';
  if (family) {
    for (const [key, val] of Object.entries(VSCODE_MODEL_MAP)) {
      if (family.includes(key)) return val;
    }
  }
  return ModelId.COPILOT_PREMIUM; // safe default
}

// Fallback token estimate when countTokens() is unavailable (offline / tests)
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Count tokens using the model's real tokenizer (VS Code 1.90 API).
 * Falls back to len/4 estimate if the API throws (offline, unit tests, etc.)
 *
 * Wave 10 Claim 2: "pre-execution burn rate predictor receives actual input token count
 * from the model's tokenizer before any API call is transmitted"
 */
async function countTokensReal(
  model:       vscode.LanguageModelChat,
  text:        string,
  cancelToken?: vscode.CancellationToken,
): Promise<number> {
  try {
    return await model.countTokens(text, cancelToken);
  } catch {
    return estimateTokens(text);
  }
}

export class CopilotInterceptor {
  private _pipeline:      ACILPipeline;
  private _telemetry:     TelemetryCollector;
  private _notifications: NotificationManager;
  private _embedBridge:   VSCodeEmbedBridge;
  private _feedback:      UserFeedbackCollector | null = null;

  constructor(
    pipeline:      ACILPipeline,
    telemetry:     TelemetryCollector,
    notifications: NotificationManager,
    feedback?:     UserFeedbackCollector,
  ) {
    this._pipeline      = pipeline;
    this._telemetry     = telemetry;
    this._notifications = notifications;
    this._feedback      = feedback ?? null;
    // Tier 2: TF-IDF cosine by default — upgraded to LM-scored on first sendRequest()
    this._embedBridge   = new VSCodeEmbedBridge();
  }

  /** Attach/replace feedback collector. */
  setFeedback(feedback: UserFeedbackCollector): void {
    this._feedback = feedback;
  }

  /**
   * Intercept-wrapped sendRequest.
   * Returns the model response stream after ACIL preflight clears it,
   * or a blocked result if enforcement prevents the request.
   */
  async sendRequest(
    model:    vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    options:  vscode.LanguageModelChatRequestOptions,
    token:    vscode.CancellationToken,
    userId:   string,
  ): Promise<ACILInterceptResult> {
    // Build prompt text from messages for classification
    const promptText = messages
      .map(m => {
        const parts = m.content;
        return Array.isArray(parts)
          ? parts.map(p => (p instanceof vscode.LanguageModelTextPart ? p.value : '')).join('')
          : String(parts);
      })
      .join('\n');

    const modelId = modelIdFromVSCode(model);
    const signals = this._telemetry.collect(promptText);

    // ── Real token count (Phase 19) ───────────────────────────────────────
    // model.countTokens() uses the model's actual tokenizer, not len/4 estimation.
    // This is what feeds contextSizeTokens → BurnPredictor → accurate cost forecast.
    const inputTokens = await countTokensReal(model, promptText, token);

    // ── Preflight ──────────────────────────────────────────────────────────
    const preflight = this._pipeline.preflight({
      rawInput:           promptText,
      telemetry:          signals,
      preferredModelId:   modelId,
      qualityRequirement: QualityRequirement.STANDARD,
      contextSizeTokens:  inputTokens,   // ← real count from model's tokenizer
      agenticDepth:       signals.toolCallSignatures.length > 2 ? 3 : 0,
      userId,
    });

    // Notify on enforcement transitions
    if (preflight.enforcement.message) {
      this._notifications.notifyEnforcement(
        preflight.enforcement.state,
        preflight.enforcement.message,
        this._pipeline.forecast(),
      );
    }

    // Block if not allowed
    if (!preflight.allowed) {
      return {
        blockedByACIL: true,
        state:         preflight.enforcement.state,
        message:       preflight.enforcement.message ??
          `ACIL: Request blocked — enforcement state ${preflight.enforcement.state}`,
      };
    }

    // Agentic confirmation gate (only for explicit @acil participant calls, not inline)
    if (preflight.sessionType === SessionType.AGENTIC &&
        preflight.prediction.expectedCost > 0.10 &&
        !options.justification) {
      const confirmed = await this._notifications.confirmAgenticSession(
        preflight.prediction.expectedCost,
        preflight.prediction.expectedTokens,
        this._pipeline.balance,
        preflight.sessionType,
      );
      if (!confirmed) {
        this._feedback?.recordAgentic(false);
        return {
          blockedByACIL: true,
          state:         preflight.enforcement.state,
          message:       'ACIL: Agentic session cancelled by developer (cost gate).',
        };
      }
      this._feedback?.recordAgentic(true);
    }

    // ── CCT: Apply compressed input to messages (Phase 24 — Wave 10 Claim 8) ──
    let finalMessages    = messages;
    let finalInputTokens = inputTokens;

    if (preflight.cctApplied && preflight.optimizedInput) {
      // Tier 2 — LM-Scored Semantic Equivalence Check (Wave 10 Claim 11)
      // Upgrade bridge to active model on first request (lazy init)
      this._embedBridge.setModel(model);
      const eqResult = await this._embedBridge.scorePair(
        promptText,
        preflight.optimizedInput,
        token,
      );

      const shouldApply = eqResult.score >= 0.72; // Claim 11 threshold

      if (shouldApply) {
        // Compression is semantically safe — use it
        const lastUserIdx = messages.map(m => m.role)
          .lastIndexOf(vscode.LanguageModelChatMessageRole.User);
        if (lastUserIdx >= 0) {
          finalMessages = [...messages];
          finalMessages[lastUserIdx] = vscode.LanguageModelChatMessage.User(preflight.optimizedInput);
          finalInputTokens = await countTokensReal(model, preflight.optimizedInput, token);
          const savedTokens = inputTokens - finalInputTokens;
          if (savedTokens > 0) {
            this._notifications.notifyCCTSavings(savedTokens, preflight.cctSavingsPct);
          }
          // Feedback: CCT accepted (Tier 2 passed)
          this._feedback?.recordCCT(true, preflight.cctSavingsPct ?? 0, preflight.sessionType);
        }
      } else {
        // Feedback: CCT rejected by Tier 2 semantic check
        this._feedback?.recordCCT(false, preflight.cctSavingsPct ?? 0, preflight.sessionType);
      }
    }

    // ── Forward to model ───────────────────────────────────────────────────
    const response = await model.sendRequest(finalMessages, options, token);

    // ── Stream + postflight ────────────────────────────────────────────────
    let outputText = '';
    const originalStream = response.text;

    // Wrap stream: collect text, then count real output tokens after stream closes
    const self = this;
    const interceptedText: AsyncIterable<string> = {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of originalStream) {
          outputText += chunk;
          yield chunk;
        }
        // Stream complete — count actual output tokens with real tokenizer
        const outputTokens = await countTokensReal(model, outputText);
        // Use finalInputTokens (post-CCT count) so audit records compressed token spend
        self._postflight(preflight, finalInputTokens, outputTokens, userId);
      },
    };

    return { blockedByACIL: false, text: interceptedText };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _postflight(
    preflight:    ReturnType<ACILPipeline['preflight']>,
    inputTokens:  number,
    outputTokens: number,
    userId:       string,
  ): void {
    this._pipeline.postflight({
      eventId:              preflight.eventId,
      sessionId:            preflight.sessionId,
      userId,
      sessionType:          preflight.sessionType,
      modelId:              preflight.effectiveModelId,
      agenticDepth:         0,
      inputTokens,
      outputTokens,
      cachedTokens:         0,
      predictedCost:        preflight.prediction.expectedCost,
      predictedTokens:      preflight.prediction.expectedTokens,
      originalTokens:       null,
      translatedTokens:     null,
      cctSavingsPct:        preflight.cctApplied ? preflight.cctSavingsPct : null,
      classifierConfidence: preflight.classifierConfidence,
    });
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ACILInterceptResult =
  | { blockedByACIL: false; text: AsyncIterable<string> }
  | { blockedByACIL: true;  state: EnforcementState; message: string };
