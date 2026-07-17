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
    shadowModelId: string;
    shadowCostPerKTok: number;
    outputRatioByType: Record<string, number>;
    activateOnStates: EnforcementState[];
}
export interface ShadowRunResult {
    fired: boolean;
    shadowInputTokens: number;
    shadowOutputTokens: number;
    shadowCost: number;
    estimatedOutputTokens: number;
    exactCostOriginal: number;
    exactCostCompressed: number;
    exactSavingsUsd: number;
    exactSavingsPct: number;
    measurement: 'exact' | 'estimated';
}
export type ShadowInferenceFn = (prompt: string, modelId: string, maxTokens: number) => Promise<{
    inputTokens: number;
    outputTokens: number;
}>;
export declare class ControlledHallucinationEngine {
    private _config;
    private _shadowFn;
    private _cache;
    private _callCount;
    private _totalCost;
    constructor(config?: Partial<ShadowRunConfig>);
    /**
     * Wire the actual shadow inference function.
     * In VS Code: uses model.sendRequest() to a cheap model.
     * In CLI/MCP: uses a direct HTTP call to the API.
     */
    setShadowFn(fn: ShadowInferenceFn): void;
    /**
     * Measure exact cost differential between original and compressed prompt.
     *
     * @param originalPrompt   The un-compressed prompt
     * @param compressedPrompt The CCT-compressed prompt (may equal original if CCT skipped)
     * @param sessionType      From SessionClassifier
     * @param modelCostPerKTok Real model output cost per 1K tokens
     * @param enforcementState Current budget state — controls whether shadow fires
     */
    measure(originalPrompt: string, compressedPrompt: string, sessionType: string, modelCostPerKTok: number, enforcementState: EnforcementState): Promise<ShadowRunResult>;
    /** Diagnostic stats — total shadow runs fired and cost accumulated. */
    get stats(): {
        calls: number;
        totalCost: number;
    };
    private _estimate;
}
//# sourceMappingURL=ControlledHallucinationEngine.d.ts.map