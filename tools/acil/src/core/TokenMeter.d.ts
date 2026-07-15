/**
 * ACIL — TokenMeter
 *
 * Counts and accumulates token consumption per LLM API call.
 * Applies the Intertrust VDE "metering method" pattern (public domain,
 * US5892900A expired 2016, US8291238B2 expired 2018) to LLM inference tokens.
 *
 * Intertrust's disclosed pattern: EVENT → METER → BILLING → BUDGET
 * ACIL applies:  SESSION_EVENT → TOKEN_METER → CREDIT_BILLING → BUDGET_ENFORCER
 *
 * The novel element (Wave 10 Claim 1): session_type is classified BEFORE
 * metering begins, allowing the meter to apply session-type-specific
 * weighting and burn profiles. No prior art meters by pre-classified session type.
 */
import { TokenUsage, ModelId, SessionType } from './types';
export interface MeterResult {
    usage: TokenUsage;
    sessionType: SessionType;
    modelId: ModelId;
    agenticDepth: number;
    meteredAt: Date;
    weightedCost: number;
}
export declare class TokenMeter {
    private _accumulated;
    private _sessionType;
    private _modelId;
    constructor(sessionType: SessionType, modelId: ModelId);
    /**
     * Record a single API call's token usage.
     * Accumulates into running session totals (Intertrust bitmap accumulator pattern).
     */
    record(input: number, output: number, cached?: number): MeterResult;
    /** Running session totals (all calls combined). */
    get accumulated(): Readonly<TokenUsage>;
    /** Session-type weight for this meter instance. */
    get weight(): number;
    /** Reset accumulator (e.g. new session starts). */
    reset(): void;
    /** Static utility: build a TokenUsage object from raw values. */
    static usage(input: number, output: number, cached?: number): TokenUsage;
}
//# sourceMappingURL=TokenMeter.d.ts.map