/**
 * ACIL Core Types
 * AI Credit Intelligence Layer — imKrisK / Wave 10 Patent Portfolio
 *
 * These type definitions are the atomic building blocks of the ACIL system.
 * They represent the "UDE" (User Data Element) analog from the Intertrust
 * VDE metering architecture (public domain, expired 2016-2018), applied
 * to LLM inference token consumption.
 */
/**
 * The six cost-relevant session types identified by the Session-Type Classifier.
 * Each maps to a distinct token burn profile (see BurnProfile.ts).
 *
 * NOVEL CLAIM: This enum is the anchor of Wave 10 Claim 1.
 * No prior art classifies developer AI sessions by work type.
 */
export declare enum SessionType {
    ARCHITECTURE = "ARCHITECTURE",// System design, high-level planning — HIGH burn (5K-50K tokens)
    DEBUGGING = "DEBUGGING",// Error analysis, fix generation    — MEDIUM burn (500-5K tokens)
    BOILERPLATE = "BOILERPLATE",// Repetitive code generation        — LOW burn (100-2K tokens)
    AGENTIC = "AGENTIC",// Multi-step autonomous execution   — VERY HIGH burn (10K-500K+)
    DOCUMENTATION = "DOCUMENTATION",// Comment/README/spec generation    — LOW burn (100-1K tokens)
    REVIEW = "REVIEW",// Code review, diff analysis        — MEDIUM burn (1K-10K tokens)
    UNKNOWN = "UNKNOWN"
}
export declare enum ModelId {
    CLAUDE_SONNET_4 = "claude-sonnet-4-5",
    CLAUDE_HAIKU_3 = "claude-haiku-3-5",
    GPT_4O = "gpt-4o",
    GPT_4O_MINI = "gpt-4o-mini",
    GEMINI_1_5_PRO = "gemini-1.5-pro",
    GEMINI_1_5_FLASH = "gemini-1.5-flash",
    COPILOT_PREMIUM = "copilot-premium",
    COPILOT_STANDARD = "copilot-standard",
    LOCAL = "local",
    UNKNOWN = "unknown"
}
/**
 * Atomic token counts returned by an LLM API call.
 * Maps to Intertrust's "atomic element" concept (public domain).
 */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalTokens: number;
}
/**
 * A SessionEvent is the core data record produced by every LLM API interaction.
 * It is the ACIL equivalent of Intertrust's UDE (User Data Element) — a
 * timestamped, attributed record of a metered consumption event.
 *
 * Intertrust UDE pattern (public domain, expired 2018) provides:
 * - timestamp, userId, sessionId, atomicElements (now: token counts)
 * - ascending/descending counters (now: balance before/after)
 *
 * ACIL adds the novel fields: sessionType, agenticDepth, predictedCost
 */
export interface SessionEvent {
    eventId: string;
    sessionId: string;
    userId: string;
    timestamp: Date;
    sessionType: SessionType;
    confidence: number;
    modelId: ModelId;
    agenticDepth: number;
    usage: TokenUsage;
    grossCost: number;
    discountAmount: number;
    netCost: number;
    balanceBefore: number;
    balanceAfter: number;
    predictedCost: number | null;
    predictedTokens: number | null;
    originalTokens: number | null;
    translatedTokens: number | null;
    cctSavingsPct: number | null;
    wasDowngraded?: boolean;
    originalModelId?: ModelId | null;
    substitutionSavingsUsd?: number | null;
}
/**
 * The six graduated enforcement states of the Real-Time Credit Enforcer (RTCE).
 * NOVEL — Wave 10 Claim 4: no prior art applies graduated LLM enforcement
 * with model-downgrade as an intermediate throttle step.
 */
export declare enum EnforcementState {
    NORMAL = "NORMAL",// >50% balance — full access
    ADVISORY = "ADVISORY",// 25–50%       — show burn rate + ETA
    WARNING = "WARNING",// 10–25%       — suggest session downgrade
    THROTTLE = "THROTTLE",// 5–10%        — auto model-downgrade
    CRITICAL = "CRITICAL",// 1–5%         — block new agentic starts
    EXHAUSTED = "EXHAUSTED"
}
export interface BudgetPeriod {
    periodId: string;
    userId: string;
    startDate: Date;
    resetDate: Date;
    totalAllocation: number;
    consumed: number;
    remaining: number;
    enforcementState: EnforcementState;
}
export interface BurnPrediction {
    expectedTokens: number;
    minTokens: number;
    maxTokens: number;
    expectedCost: number;
    confidence: number;
    timeToExhaustion: number | null;
}
export interface TemporalForecast {
    exhaustionDate: Date | null;
    daysRemaining: number;
    overageRiskScore: number;
    overageCostEstimate: number;
    confidenceLow: Date | null;
    confidenceHigh: Date | null;
    recommendedActions: string[];
}
//# sourceMappingURL=types.d.ts.map