/**
 * ACIL Core Types
 * AI Credit Intelligence Layer — imKrisK / Wave 10 Patent Portfolio
 *
 * These type definitions are the atomic building blocks of the ACIL system.
 * They represent the "UDE" (User Data Element) analog from the Intertrust
 * VDE metering architecture (public domain, expired 2016-2018), applied
 * to LLM inference token consumption.
 */

// ─── Session Classification ───────────────────────────────────────────────────

/**
 * The six cost-relevant session types identified by the Session-Type Classifier.
 * Each maps to a distinct token burn profile (see BurnProfile.ts).
 *
 * NOVEL CLAIM: This enum is the anchor of Wave 10 Claim 1.
 * No prior art classifies developer AI sessions by work type.
 */
export enum SessionType {
  ARCHITECTURE  = 'ARCHITECTURE',   // System design, high-level planning — HIGH burn (5K-50K tokens)
  DEBUGGING     = 'DEBUGGING',      // Error analysis, fix generation    — MEDIUM burn (500-5K tokens)
  BOILERPLATE   = 'BOILERPLATE',    // Repetitive code generation        — LOW burn (100-2K tokens)
  AGENTIC       = 'AGENTIC',        // Multi-step autonomous execution   — VERY HIGH burn (10K-500K+)
  DOCUMENTATION = 'DOCUMENTATION',  // Comment/README/spec generation    — LOW burn (100-1K tokens)
  REVIEW        = 'REVIEW',         // Code review, diff analysis        — MEDIUM burn (1K-10K tokens)
  UNKNOWN       = 'UNKNOWN',        // Not yet classified
}

// ─── LLM Model Registry ───────────────────────────────────────────────────────

export enum ModelId {
  // Anthropic
  CLAUDE_SONNET_4     = 'claude-sonnet-4-5',
  CLAUDE_HAIKU_3      = 'claude-haiku-3-5',
  // OpenAI
  GPT_4O              = 'gpt-4o',
  GPT_4O_MINI         = 'gpt-4o-mini',
  // Google
  GEMINI_1_5_PRO      = 'gemini-1.5-pro',
  GEMINI_1_5_FLASH    = 'gemini-1.5-flash',
  // GitHub Copilot
  COPILOT_PREMIUM     = 'copilot-premium',
  COPILOT_STANDARD    = 'copilot-standard',
  // Local / fallback
  LOCAL               = 'local',
  UNKNOWN             = 'unknown',
}

// ─── Token Consumption ────────────────────────────────────────────────────────

/**
 * Atomic token counts returned by an LLM API call.
 * Maps to Intertrust's "atomic element" concept (public domain).
 */
export interface TokenUsage {
  inputTokens:   number;
  outputTokens:  number;
  cachedTokens:  number;
  totalTokens:   number;
}

// ─── Session Event (UDE Analog) ───────────────────────────────────────────────

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
  // Identity
  eventId:        string;           // UUID
  sessionId:      string;           // Groups events within one developer session
  userId:         string;           // Developer identifier
  timestamp:      Date;

  // Classification (NOVEL — Wave 10 Claim 1)
  sessionType:    SessionType;
  confidence:     number;           // 0.0–1.0 classifier confidence

  // Model
  modelId:        ModelId;
  agenticDepth:   number;           // 0 = single call; N = N-step agent chain

  // Token consumption (metered — Intertrust pattern, public domain)
  usage:          TokenUsage;

  // Cost
  grossCost:      number;           // USD cost before any discount
  discountAmount: number;           // Included-quota discount applied
  netCost:        number;           // Actual billable cost (0 if within quota)

  // Credit balance snapshot (Intertrust descending-counter UDE, public domain)
  balanceBefore:  number;           // Credits remaining BEFORE this event
  balanceAfter:   number;           // Credits remaining AFTER this event

  // Pre-execution prediction (NOVEL — Wave 10 Claim 2)
  predictedCost:  number | null;    // Estimated cost generated BEFORE API call
  predictedTokens: number | null;   // Estimated tokens generated BEFORE API call

  // CCT translation savings (NOVEL — Wave 10 Claim 8)
  originalTokens: number | null;    // Token count if sent in original chat format
  translatedTokens: number | null;  // Token count after CCT optimization
  cctSavingsPct:  number | null;    // % reduction (0.0–1.0)
}

// ─── Enforcement State ────────────────────────────────────────────────────────

/**
 * The six graduated enforcement states of the Real-Time Credit Enforcer (RTCE).
 * NOVEL — Wave 10 Claim 4: no prior art applies graduated LLM enforcement
 * with model-downgrade as an intermediate throttle step.
 */
export enum EnforcementState {
  NORMAL    = 'NORMAL',     // >50% balance — full access
  ADVISORY  = 'ADVISORY',   // 25–50%       — show burn rate + ETA
  WARNING   = 'WARNING',    // 10–25%       — suggest session downgrade
  THROTTLE  = 'THROTTLE',   // 5–10%        — auto model-downgrade
  CRITICAL  = 'CRITICAL',   // 1–5%         — block new agentic starts
  EXHAUSTED = 'EXHAUSTED',  // 0%           — hard stop
}

// ─── Budget Period ────────────────────────────────────────────────────────────

export interface BudgetPeriod {
  periodId:       string;
  userId:         string;
  startDate:      Date;
  resetDate:      Date;             // Next billing cycle reset
  totalAllocation: number;          // Credits allocated for this period (USD or units)
  consumed:       number;           // Credits consumed so far
  remaining:      number;           // = totalAllocation - consumed
  enforcementState: EnforcementState;
}

// ─── Burn Prediction ─────────────────────────────────────────────────────────

export interface BurnPrediction {
  expectedTokens:  number;
  minTokens:       number;
  maxTokens:       number;
  expectedCost:    number;
  confidence:      number;          // 0.0–1.0
  timeToExhaustion: number | null;  // Minutes until budget exhausted; null if safe
}

// ─── Temporal Forecast ───────────────────────────────────────────────────────

export interface TemporalForecast {
  exhaustionDate:    Date | null;   // null = balance survives to reset date
  daysRemaining:     number;
  overageRiskScore:  number;        // 0.0–1.0 probability of overage
  overageCostEstimate: number;      // Projected USD overage if no action taken
  confidenceLow:     Date | null;   // 80% CI lower bound
  confidenceHigh:    Date | null;   // 80% CI upper bound
  recommendedActions: string[];
}
