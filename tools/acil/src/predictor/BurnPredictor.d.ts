/**
 * ACIL — BurnPredictor
 *
 * Pre-Execution Burn Rate Predictor (PEBP).
 * Estimates token consumption and cost BEFORE an AI API call is made.
 *
 * NOVEL CLAIM (Wave 10 Claim 2 + Claim 6):
 * No prior art predicts LLM session token consumption before the API call
 * is transmitted. This is fundamentally different from post-execution reporting.
 *
 * The prediction runs in <50ms and is displayed in the VS Code status bar
 * as a pre-flight cost estimate before the developer confirms a request.
 */
import { SessionType, ModelId, BurnPrediction } from '../core/types';
import { BurnProfile } from './BurnProfile';
export interface PredictInput {
    sessionType: SessionType;
    modelId: ModelId;
    contextWindowSize: number;
    proposedQueryTokens: number;
    agenticDepth: number;
    profile: BurnProfile;
}
export declare class BurnPredictor {
    /**
     * Context window multiplier: larger context → model generates longer responses.
     * Empirical: every 10K tokens of context adds ~8% to expected output length.
     */
    private _contextMultiplier;
    /**
     * Agentic depth multiplier: each agent step compounds context size.
     * Empirical: each step adds ~2-3× the single-call cost in accumulated context.
     * Wave 10 Claim 6: agentic_depth multiplier applied per step.
     */
    private _agenticMultiplier;
    /**
     * Predict token consumption and cost for a proposed interaction.
     * Called BEFORE the API call is transmitted.
     */
    predict(input: PredictInput): BurnPrediction;
}
//# sourceMappingURL=BurnPredictor.d.ts.map