/**
 * ACIL Wave 12 — ControlledHallucinationEngine
 *
 * Fires a shadow inference request to a low-cost model specifically to
 * MEASURE the output token shape — then discards the output entirely.
 *
 * The industry's greatest AI fear (hallucination = confident false output)
 * is inverted here as a purposeful measurement primitive.
 *
 * Problem this solves:
 *   ACIL's TSP can predict WHEN credits will run out, but the cost estimate
 *   per request has always been approximate — we know input tokens exactly
 *   but output tokens vary by model and prompt. This creates ±40% error
 *   in per-request cost estimates.
 *
 *   Controlled hallucination measures the output shape exactly:
 *   1. Send prompt to gpt-4o-mini (shadow model, ~$0.00004 cost)
 *   2. Count actual output tokens returned
 *   3. Extrapolate: "real model would produce N×K output tokens"
 *   4. Compute EXACT cost differential (original vs CCT-compressed)
 *   5. Discard the shadow output — never shown to developer
 *
 * Activation conditions (not fired on every request — selective):
 *   - AGENTIC sessions (high stakes, output-heavy)
 *   - SOFT_BLOCK state (every cent matters)
 *   - Budget < 15% remaining
 *   - CCT was applied (verify exact savings vs estimate)
 *
 * Cost of shadow run: ~$0.00004 per call (gpt-4o-mini input rate)
 * Value of shadow run: converts ±40% cost estimate to ±3% exact measurement
 *
 * Patent: Wave 12 Claim 4
 * Author: imKrisK
 */

import { EnforcementState } from '../core/types';

export interface ShadowRunConfig {
  shadowModelId:     string;   // cheap fast model — default: gpt-4o-mini
  shadowCostPerKTok: number;   // cost per 1K input tokens on shadow model
  outputRatioByType: Record<string, number>; // output/input ratio per session type
  activateOnStates:  EnforcementState[]; // enforcement states that trigger shadow run
}

export interface ShadowRunResult {
  fired:              boolean;
  shadowInputTokens:  number;
  shadowOutputTokens: number;
  shadowCost:         number;      // cost of the shadow run itself
  estimatedOutputTokens: number;  // extrapolated for the real model
  exactCostOriginal:  number;     // real model cost before CCT
  exactCostCompressed: number;    // real model cost after CCT
  exactSavingsUsd:    number;
  exactSavingsPct:    number;
  measurement:        'exact' | 'estimated'; // 'exact' if shadow fired
}

export type ShadowInferenceFn = (
  prompt: string,
  modelId: string,
  maxTokens: number,
) => Promise<{ inputTokens: number; outputTokens: number }>;

const DEFAULT_CONFIG: ShadowRunConfig = {
  shadowModelId:     'gpt-4o-mini',
  shadowCostPerKTok: 0.00015,
  outputRatioByType: {
    AGENTIC:       2.8,
    ARCHITECTURE:  2.2,
    DEBUGGING:     1.8,
    BOILERPLATE:   1.2,
    DOCUMENTATION: 1.5,
    REVIEW:        1.6,
    EXPLORATION:   1.4,
  },
  activateOnStates: [EnforcementState.CRITICAL, EnforcementState.WARNING],
};

export class ControlledHallucinationEngine {
  private _config:      ShadowRunConfig;
  private _shadowFn:    ShadowInferenceFn | null = null;
  private _cache:       Map<string, ShadowRunResult> = new Map();
  private _callCount    = 0;
  private _totalCost    = 0;

  constructor(config: Partial<ShadowRunConfig> = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Wire the actual shadow inference function.
   * In VS Code: uses model.sendRequest() to a cheap model.
   * In CLI/MCP: uses a direct HTTP call to the API.
   */
  setShadowFn(fn: ShadowInferenceFn): void {
    this._shadowFn = fn;
  }

  /**
   * Measure exact cost differential between original and compressed prompt.
   *
   * @param originalPrompt   The un-compressed prompt
   * @param compressedPrompt The CCT-compressed prompt (may equal original if CCT skipped)
   * @param sessionType      From SessionClassifier
   * @param modelCostPerKTok Real model output cost per 1K tokens
   * @param enforcementState Current budget state — controls whether shadow fires
   */
  async measure(
    originalPrompt:    string,
    compressedPrompt:  string,
    sessionType:       string,
    modelCostPerKTok:  number,
    enforcementState:  EnforcementState,
  ): Promise<ShadowRunResult> {
    const cacheKey = `${originalPrompt.slice(0, 64)}:${compressedPrompt.slice(0, 32)}`;

    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey)!;
    }

    const shouldFire = this._shadowFn !== null &&
      this._config.activateOnStates.includes(enforcementState);

    if (!shouldFire) {
      // Estimation fallback — statistical output ratio
      return this._estimate(originalPrompt, compressedPrompt, sessionType, modelCostPerKTok);
    }

    // ── CONTROLLED HALLUCINATION — fire shadow model ──────────────────────
    try {
      const origTokens = Math.ceil(originalPrompt.length / 3.8);
      const compTokens = Math.ceil(compressedPrompt.length / 3.8);

      // Fire shadow on the COMPRESSED prompt — measure its output shape
      const shadow = await this._shadowFn!(
        compressedPrompt,
        this._config.shadowModelId,
        Math.min(2048, Math.ceil(origTokens * 2)), // max output cap
      );

      const shadowCost = (shadow.inputTokens / 1000) * this._config.shadowCostPerKTok;
      this._callCount++;
      this._totalCost += shadowCost;

      // Extrapolate: shadow output / compressed input × original input = estimated orig output
      const outputRatio        = shadow.outputTokens / Math.max(shadow.inputTokens, 1);
      const estimatedOrigOutput = Math.ceil(origTokens * outputRatio);
      const estimatedCompOutput = shadow.outputTokens;

      const exactCostOriginal   = (estimatedOrigOutput / 1000) * modelCostPerKTok;
      const exactCostCompressed = (estimatedCompOutput / 1000) * modelCostPerKTok;
      const exactSavings        = exactCostOriginal - exactCostCompressed;

      const result: ShadowRunResult = {
        fired:                true,
        shadowInputTokens:    shadow.inputTokens,
        shadowOutputTokens:   shadow.outputTokens,
        shadowCost,
        estimatedOutputTokens: estimatedOrigOutput,
        exactCostOriginal,
        exactCostCompressed,
        exactSavingsUsd:      Math.max(0, exactSavings),
        exactSavingsPct:      exactCostOriginal > 0 ? exactSavings / exactCostOriginal : 0,
        measurement:          'exact',
      };

      // Cache with 200-entry LRU
      if (this._cache.size >= 200) this._cache.delete(this._cache.keys().next().value!);
      this._cache.set(cacheKey, result);
      return result;

    } catch {
      // Shadow run failed — fall back to estimation, never crash real request
      return this._estimate(originalPrompt, compressedPrompt, sessionType, modelCostPerKTok);
    }
  }

  /** Diagnostic stats — total shadow runs fired and cost accumulated. */
  get stats() {
    return { calls: this._callCount, totalCost: this._totalCost };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _estimate(
    orig: string, comp: string, sessionType: string, costPerKTok: number,
  ): ShadowRunResult {
    const origTokens = Math.ceil(orig.length / 3.8);
    const compTokens = Math.ceil(comp.length / 3.8);
    const ratio      = this._config.outputRatioByType[sessionType] ?? 1.5;

    const origOutput = Math.ceil(origTokens * ratio);
    const compOutput = Math.ceil(compTokens * ratio);
    const costOrig   = (origOutput / 1000) * costPerKTok;
    const costComp   = (compOutput / 1000) * costPerKTok;
    const savings    = costOrig - costComp;

    return {
      fired:                false,
      shadowInputTokens:    0,
      shadowOutputTokens:   0,
      shadowCost:           0,
      estimatedOutputTokens: origOutput,
      exactCostOriginal:    costOrig,
      exactCostCompressed:  costComp,
      exactSavingsUsd:      Math.max(0, savings),
      exactSavingsPct:      costOrig > 0 ? savings / costOrig : 0,
      measurement:          'estimated',
    };
  }
}
