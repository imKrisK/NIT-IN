"use strict";
/**
 * ACIL Core Types
 * AI Credit Intelligence Layer — imKrisK / Wave 10 Patent Portfolio
 *
 * These type definitions are the atomic building blocks of the ACIL system.
 * They represent the "UDE" (User Data Element) analog from the Intertrust
 * VDE metering architecture (public domain, expired 2016-2018), applied
 * to LLM inference token consumption.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnforcementState = exports.ModelId = exports.SessionType = void 0;
// ─── Session Classification ───────────────────────────────────────────────────
/**
 * The six cost-relevant session types identified by the Session-Type Classifier.
 * Each maps to a distinct token burn profile (see BurnProfile.ts).
 *
 * NOVEL CLAIM: This enum is the anchor of Wave 10 Claim 1.
 * No prior art classifies developer AI sessions by work type.
 */
var SessionType;
(function (SessionType) {
    SessionType["ARCHITECTURE"] = "ARCHITECTURE";
    SessionType["DEBUGGING"] = "DEBUGGING";
    SessionType["BOILERPLATE"] = "BOILERPLATE";
    SessionType["AGENTIC"] = "AGENTIC";
    SessionType["DOCUMENTATION"] = "DOCUMENTATION";
    SessionType["REVIEW"] = "REVIEW";
    SessionType["UNKNOWN"] = "UNKNOWN";
})(SessionType || (exports.SessionType = SessionType = {}));
// ─── LLM Model Registry ───────────────────────────────────────────────────────
var ModelId;
(function (ModelId) {
    // Anthropic
    ModelId["CLAUDE_SONNET_4"] = "claude-sonnet-4-5";
    ModelId["CLAUDE_HAIKU_3"] = "claude-haiku-3-5";
    // OpenAI
    ModelId["GPT_4O"] = "gpt-4o";
    ModelId["GPT_4O_MINI"] = "gpt-4o-mini";
    // Google
    ModelId["GEMINI_1_5_PRO"] = "gemini-1.5-pro";
    ModelId["GEMINI_1_5_FLASH"] = "gemini-1.5-flash";
    // GitHub Copilot
    ModelId["COPILOT_PREMIUM"] = "copilot-premium";
    ModelId["COPILOT_STANDARD"] = "copilot-standard";
    // Local / fallback
    ModelId["LOCAL"] = "local";
    ModelId["UNKNOWN"] = "unknown";
})(ModelId || (exports.ModelId = ModelId = {}));
// ─── Enforcement State ────────────────────────────────────────────────────────
/**
 * The six graduated enforcement states of the Real-Time Credit Enforcer (RTCE).
 * NOVEL — Wave 10 Claim 4: no prior art applies graduated LLM enforcement
 * with model-downgrade as an intermediate throttle step.
 */
var EnforcementState;
(function (EnforcementState) {
    EnforcementState["NORMAL"] = "NORMAL";
    EnforcementState["ADVISORY"] = "ADVISORY";
    EnforcementState["WARNING"] = "WARNING";
    EnforcementState["THROTTLE"] = "THROTTLE";
    EnforcementState["CRITICAL"] = "CRITICAL";
    EnforcementState["EXHAUSTED"] = "EXHAUSTED";
})(EnforcementState || (exports.EnforcementState = EnforcementState = {}));
