# Changelog

All notable changes to ACIL — AI Credit Intelligence Layer are documented here.

## [0.3.0] — 2026-07-22

### Added — Discord Webhook Bilateral Automation
- **`ACIL: Connect Discord Webhook`** command — stores Discord Incoming Webhook URL in VS Code SecretStorage (password mode input, never logged)
- **`$(megaphone) Approve + Post to Discord`** action in Outbox Review Queue — marks draft APPROVED on GitHub, posts rich embed to Discord channel, marks POSTED on GitHub — zero manual paste
- **`DiscordWebhookClient`** — posts to Discord via Incoming Webhook API with rich embeds (title, classification, forum link, ACIL cyan color, footer, timestamp)
- **ACIL color palette** for Discord embeds: normal/advisory/warning/critical/info/approved/rejected
- **Rate limit backoff** — 429 retry-after respected automatically
- **ACIL Control Discord server** — private `#outbox-replies` channel receives all approved reply embeds
- **OutboxClient repo fix** — reads from `imKrisK/NIT-IN` (already authorized) instead of separate META-VOICE-SYSTEM repo

### How the full bilateral loop works
```
Cursor forum reply → discourse-poller detects (30 min)
→ BCN delta injected to inbox/CURSOR/
→ bilateral-watcher.js classifies reply + drafts response
→ REPLY_DRAFT written to bilateral_communications/outbox/
→ 📬 NEW ✦ status bar badge fires in VS Code
→ Click badge → Quick Pick → select draft
→ Approve + Post to Discord
→ Rich embed posts to #outbox-replies instantly
→ GitHub file marked POSTED automatically
→ Zero paste, zero browser, zero AutoMod friction
```

### Verified
- Full bilateral loop tested end-to-end July 22, 2026
- Toast confirmed: "Posted reply to @testuser42 on Discord + marked POSTED on GitHub"
- All 5 action paths working: Approve / Approve+Discord / Edit / Reject / Skip


### Fixed
- Marketplace listing update: README and CHANGELOG now reflect v0.2.0 Outbox Monitor feature set
- Version sync: `@nit-in/acil` and `@nit-in/acil-learn` aligned to 0.2.1

## [0.2.0] — 2026-07-17

### Added — Outbox Monitor Widget
- **`ACIL: Open Outbox Review Queue`** command — Quick Pick list of all PENDING_REVIEW reply drafts waiting for your approval
- **`ACIL: Check Outbox Now`** command — force-refresh the outbox from GitHub immediately
- **Status bar badge** `📬 N pending` — appears in amber when new drafts arrive, pulses `NEW ✦` for 30 seconds on first detection
- **3-step Quick Pick review flow:** List → Detail → Action (Approve / Edit / Reject / Skip)
- **Approve** marks draft APPROVED on GitHub + copies reply text to clipboard — paste directly in the forum
- **Edit first** — InputBox pre-filled with draft text, save to approve
- **Reject** — confirmation prompt, marks REJECTED, removes from queue permanently
- **Auto re-poll** on VS Code window focus + 15-minute background interval
- **OutboxClient** — GitHub Contents API r/w for outbox REPLY_DRAFT_*.json files (uses existing SecretStorage PAT)

### Added — BCN Discourse Poller (NIT-IN repo)
- `scripts/discourse-poller.js` — polls Cursor Community Forum engagement every 30 min
- Writes `snapshot_*.json`, `delta_*.json`, `engagement_summary.md` to `bilateral_communications/inbox/CURSOR/`
- BCN inbox injection: injects `ENGAGEMENT_UPDATE` delta when new replies arrive → picked up by bilateral-watcher

### Added — BCN Reply Drafter (NIT-IN repo)
- `bilateral-watcher.js` — 6-type classifier: `INSTALL_QUESTION`, `PRICING_QUESTION`, `FEATURE_REQUEST`, `PRAISE`, `COMPETITOR_MENTION`, `TECHNICAL_QUESTION`
- Drafts voice-matched reply for each new forum reply → writes `REPLY_DRAFT_*.json` to `outbox/` with `PENDING_REVIEW` status

### Changed
- npm packages `@nit-in/acil` and `@nit-in/acil-learn` bumped to `0.2.0` to match extension
- 78/78 tests passing (was 55 in v0.1.0 — +23 Wave 12 orchestration tests)

### Technical — Wave 12 Orchestration (code complete, patent pending Dec 2026)
- **SharedBudgetPool**: Atomic spin-lock credit pool shared across parallel AI agents
- **ContradictionDetector**: Jaccard + negation asymmetry scoring, 5-min rolling window, 7 conflict types
- **ControlledHallucinationEngine**: Shadow inference for exact cost measurement, 200-entry LRU cache



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
