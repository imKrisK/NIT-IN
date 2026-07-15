/**
 * @nit-in/acil-learn — LearnAdapter
 *
 * Minimal single-method wrapper for embedding ACILLearn into
 * middleware-style architectures (proxy servers, HTTP interceptors, etc.)
 *
 * Usage in an LLM proxy:
 *
 *   const adapter = new LearnAdapter({ storagePath: '/var/acil' });
 *   await adapter.initialize();
 *
 *   // In request handler:
 *   const gate = await adapter.gate({ tokenEstimate: 2400 });
 *   if (gate.block) { return res.status(429).json({ reason: gate.reason }); }
 *
 *   // Forward to LLM ...
 *
 *   // After response:
 *   adapter.close(gate.predictionId, { actualCost: 0.0072, actualTokens: 2391, cctApplied: false });
 */
import { LearnConfig, PredictInput } from './ACILLearn';
import type { SessionType } from '@nit-in/acil';
export interface GateResult {
    predictionId: string;
    block: boolean;
    reason?: string;
    estimatedCostUsd: number;
    adaptedCCTThreshold: number;
    archetype: string | null;
}
export interface CloseInput {
    predictionId: string;
    actualCost: number;
    actualTokens: number;
    cctApplied: boolean;
    semanticScore?: number;
    actualSessionType?: SessionType;
}
export declare class LearnAdapter {
    private _learn;
    private _budgetUsd;
    private _initialized;
    constructor(config?: LearnConfig & {
        budgetUsd?: number;
    });
    initialize(): Promise<void>;
    gate(input: PredictInput): Promise<GateResult>;
    close(input: CloseInput): void;
    flush(): Promise<void>;
}
//# sourceMappingURL=LearnAdapter.d.ts.map