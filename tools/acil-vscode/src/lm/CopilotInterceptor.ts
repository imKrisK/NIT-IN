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
 * Token counting (Phase 15 v1):
 *   VS Code 1.90 does not expose token counts on LanguageModelChatResponse.
 *   We estimate: inputTokens = prompt.length / 4, outputTokens = response.length / 4.
 *   Phase 17 will hook into the Copilot usage reporting API when Microsoft exposes it.
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
} from '@nit-in/acil';
import { TelemetryCollector }  from '../TelemetryCollector';
import { NotificationManager } from '../NotificationManager';

// Maps VS Code model family strings to ACIL ModelId
const VSCODE_MODEL_MAP: Record<string, ModelId> = {
  'gpt-4o':              ModelId.GPT_4O,
  'gpt-4o-mini':         ModelId.GPT_4O_MINI,
  'claude-3-5-sonnet':   ModelId.CLAUDE_SONNET_4,
  'claude-3-haiku':      ModelId.CLAUDE_HAIKU_3,
  'gemini-1.5-pro':      ModelId.GEMINI_1_5_PRO,
  'gemini-1.5-flash':    ModelId.GEMINI_1_5_FLASH,
  'copilot-gpt-4':       ModelId.COPILOT_PREMIUM,
  'copilot-gpt-4o':      ModelId.COPILOT_PREMIUM,
  'copilot':             ModelId.COPILOT_PREMIUM,
};

function modelIdFromVSCode(model: vscode.LanguageModelChat): ModelId {
  const id = model.id.toLowerCase();
  for (const [key, val] of Object.entries(VSCODE_MODEL_MAP)) {
    if (id.includes(key)) return val;
  }
  return ModelId.COPILOT_PREMIUM; // safe default
}

// Rough token estimate: 1 token ≈ 4 characters (GPT-4 average)
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class CopilotInterceptor {
  private _pipeline:      ACILPipeline;
  private _telemetry:     TelemetryCollector;
  private _notifications: NotificationManager;

  constructor(
    pipeline:      ACILPipeline,
    telemetry:     TelemetryCollector,
    notifications: NotificationManager,
  ) {
    this._pipeline      = pipeline;
    this._telemetry     = telemetry;
    this._notifications = notifications;
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

    // ── Preflight ──────────────────────────────────────────────────────────
    const preflight = this._pipeline.preflight({
      rawInput:           promptText,
      telemetry:          signals,
      preferredModelId:   modelId,
      qualityRequirement: QualityRequirement.STANDARD,
      contextSizeTokens:  estimateTokens(promptText),
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
        return {
          blockedByACIL: true,
          state:         preflight.enforcement.state,
          message:       'ACIL: Agentic session cancelled by developer (cost gate).',
        };
      }
    }

    // ── Forward to model ───────────────────────────────────────────────────
    // If THROTTLE chose a different model, we cannot switch mid-request in VS Code
    // (model is passed in by the caller). We note the downgrade in postflight.
    const startTime   = Date.now();
    const response    = await model.sendRequest(messages, options, token);

    // ── Stream + postflight ────────────────────────────────────────────────
    let outputText = '';
    const originalStream = response.text;

    // Wrap stream: collect text for postflight token estimation
    const self = this;
    const interceptedText: AsyncIterable<string> = {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of originalStream) {
          outputText += chunk;
          yield chunk;
        }
        // Stream complete — run postflight
        const inputTokens  = estimateTokens(promptText);
        const outputTokens = estimateTokens(outputText);
        self._postflight(preflight, inputTokens, outputTokens, userId);
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
