# Changelog

All notable changes to ACIL — AI Credit Intelligence Layer are documented here.

## [0.1.0] — 2026-07-09

### Added — Core System (Wave 10)
- **7-stage pre-execution pipeline**: Classify → Predict → Compress → Route → Enforce → Learn → Record
- **SessionClassifier**: 7 session types (DEBUGGING, ARCHITECTURE, BOILERPLATE, AGENTIC, DOCUMENTATION, REVIEW, UNKNOWN) with 14 priority rules and 87–94% classification confidence
- **BurnPredictor + TSP**: Temporal Sequence Prediction with calendar-aware weighting (sprint starts, weekends, month-end). Retroactively validated: predicted June 7, 2026 exhaustion — actual exhaustion: June 7.
- **PromptCompressor (CCT)**: Chat-to-Completion Translation with per-session thresholds. DEBUGGING: 0.30, DOCUMENTATION: 0.80
- **SemanticEquivalenceChecker**: Tier 1 Jaccard similarity + Tier 2 LM-scored cosine via VSCodeEmbedBridge — 200-entry LRU cache
- **CostRouter**: 10 model substitution pairs — gpt-4o → gpt-4o-mini, claude-sonnet → claude-haiku, copilot-premium → copilot-base
- **BudgetEnforcer**: 6-state graduated enforcement machine: NORMAL → ADVISORY → WARNING → SOFT_BLOCK → HARD_BLOCK → EMERGENCY
- **CopilotInterceptor**: Wraps `model.sendRequest()` — intercepts every Copilot request pre-transmission

### Added — Learning Layer (Wave 11)
- **MetaRecursiveLoop**: Self-calibrating threshold engine with 60s TTL cache, drift detection, 7-archetype personalization
- **DeveloperPatternIdentifier**: 7 archetypes from session history (LATE_NIGHT_DEBUGGER, ARCHITECT, SPRINT_BUILDER, BALANCED, AGENT_HEAVY, CODE_REVIEWER, DOCUMENTARIAN)
- **UserFeedbackCollector**: Records CCT accept/reject, model sub accept/reject, agentic confirm/cancel. Closes the feedback loop — thresholds adapt after 5+ events

### Added — Enterprise Features
- **Policy Server** (`@nit-in/acil-policy-server`): HMAC-signed team policy delivery — GET/POST per team, `timingSafeEqual` verification
- **PolicyClient**: Polls remote server, verifies HMAC signature, hot-merges policy via `applyRemote()`
- **HMAC-Signed Audit Export**: `exportSignedBatch()` — SHA-256 CSV hash + HMAC-SHA256 with batchId + timestamp (replay-safe). `verifyBatch()` — static, `timingSafeEqual`
- **`@nit-in/acil-learn` SDK**: Framework-agnostic learning loop — `predict()` + `record()` — zero VS Code dependency
- **ACIL MCP Server** (`@nit-in/acil-mcp`): 7 MCP tools over stdio JSON-RPC 2.0 — works with Cursor, Claude Desktop, any MCP client

### Added — VS Code Extension
- **`@acil` chat participant**: `/status`, `/forecast`, `/report`, `/budget` commands
- **Status bar**: 3 items, color shifts with enforcement state, `$spent/$total` live display
- **Dashboard**: SVG burn chart, TSP balance timeline, substitution table, session breakdown
- **ACILBootstrap**: First-run wizard — 2 questions, 30 seconds, no API required
- **BalanceReconciler**: Weekly 10-second manual drift correction
- **GitHubCreditSync**: PAT-authenticated GitHub billing sync with graceful personal account fallback
- **SecretManager**: VS Code `SecretStorage` PAT vault — never on disk, never in settings
- **WorkspaceConfigLoader**: `.acil.json` team config with hot-reload + `[Symbol.dispose]`
- **CursorAdapter**: Cursor IDE governance (no `vscode.lm` dependency)

### Technical
- 55/55 tests passing
- TypeScript 5.4.5 / Node.js / CommonJS
- All tsconfigs TS 7.0-ready (`module: Node16`, explicit `types`, `noUncheckedSideEffectImports: false`)
- `satisfies` operator on all lookup tables (BASELINE_BURN_PROFILES, ARCHETYPE_CCT)
- `[Symbol.dispose]` on WorkspaceConfigLoader for `using` keyword support
- Patent Pending — USPTO 19/668,817 (Wave 10, filed Jun 29, 2026)
