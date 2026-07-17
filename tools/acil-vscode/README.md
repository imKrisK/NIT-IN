# ACIL — AI Credit Intelligence Layer

**Pre-execution LLM cost governance for VS Code. Patent Pending.**

[![Version](https://img.shields.io/badge/version-0.2.0-6C63FF)](https://marketplace.visualstudio.com/items?itemName=imKrisK.acil-vscode)
[![License](https://img.shields.io/badge/license-MIT-06D6A0)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-78%2F78-3fb950)](https://github.com/imKrisK/NIT-IN)
[![Patent](https://img.shields.io/badge/patent-pending-FFB703)](https://patentcenter.uspto.gov)

---

## The Problem

GitHub Copilot. Claude. GPT-4o. The cost meter runs invisibly in the background. The invoice arrives weeks later.

> **Real case — June 2026:** A developer exhausted 1,469 AI credits in 6 days. No warning. No forecast. No gate. $111+ in overage charges — discovered retroactively. **GitHub showed nothing.**

Every existing extension is a rearview mirror. ACIL is the gate.

---

## What ACIL Does

ACIL intercepts every `model.sendRequest()` call **before** tokens are spent and runs a 7-stage pipeline:

| Stage | Component | What Happens |
|---|---|---|
| **① Classify** | `SessionClassifier` | Identifies work type: DEBUGGING, ARCHITECTURE, AGENTIC, etc. |
| **② Predict** | `BurnPredictor` + TSP | Forecasts cost using Temporal Sequence Prediction + calendar weighting |
| **③ Compress** | `PromptCompressor` (CCT) | Strips overhead with Jaccard + LM cosine semantic equivalence gate |
| **④ Route** | `CostRouter` | Suggests cheaper model when session type doesn't need the heavy one |
| **⑤ Enforce** | `BudgetEnforcer` | 6-state graduated machine: NORMAL → ADVISORY → WARNING → SOFT_BLOCK → HARD_BLOCK → EMERGENCY |
| **⑥ Learn** | `MetaRecursiveLoop` | Self-calibrates thresholds from your session patterns — 7 developer archetypes |
| **⑦ Record** | `AuditTrail` | HMAC-signed tamper-proof audit export for compliance (SOC 2, EU AI Act) |

---

## Quick Start

1. Install ACIL from the Marketplace

---

## NEW in v0.2.0 — Outbox Monitor

The **Outbox Monitor** is a lightweight reply review widget built into VS Code. When you run the BCN bilateral-watcher system and post to the Cursor Community Forum, ACIL monitors for replies and auto-drafts responses — then surfaces them in a status bar badge for your review.

**Status bar badge** — appears in amber when drafts are waiting:
```
📬 2 pending
```

**Quick Pick review flow** (`ACIL: Open Outbox Review Queue`):
- See all pending reply drafts with classification icon + excerpt
- Select one → read the full draft → Approve / Edit / Reject / Skip
- **Approve** copies reply text to clipboard + marks approved on GitHub
- Auto re-checks on window focus + every 15 minutes

**New commands:**
- `ACIL: Open Outbox Review Queue`
- `ACIL: Check Outbox Now`

---

2. The first-run wizard appears — enter your monthly budget (default: $39 for Copilot Pro+) and current balance
3. ACIL is immediately active on every request — no GitHub API connection required

**Optional:** Connect GitHub for live billing sync via `Cmd+Shift+P` → `ACIL: Connect GitHub Account`

---

## Commands

| Command | What it does |
|---|---|
| `ACIL: Show Credit Status` | Current balance, state, archetype |
| `ACIL: Open Dashboard` | Full burn chart + TSP timeline + session breakdown |
| `ACIL: Show Spend Forecast` | Exhaustion date, risk level, recommendation |
| `ACIL: Set Monthly Budget` | Update your monthly credit allocation |
| `ACIL: Reconcile Balance with GitHub` | 10-second manual drift correction |
| `ACIL: Connect GitHub Account` | Store PAT for live billing sync |
| `ACIL: Debug GitHub Sync` | Diagnostic — shows what each API endpoint returns |
| `ACIL: Export Session History as CSV` | Full audit trail in GitHub billing format |
| `ACIL: Reset First-Run Setup` | Re-run bootstrap (e.g., after plan change) |

---

## Status Bar

```
⚡ ACIL: $12.40/$39 (31.8%)   🟡 WARNING   ⟳ synced 2m ago
```

Color shifts with enforcement state — green → yellow → orange → red. The status bar changes **before** the money runs out.

---

## The `@acil` Chat Participant

Use `@acil` directly in GitHub Copilot Chat:

```
@acil /status
@acil /forecast
@acil /report
@acil /budget
```

---

## MCP Integration (Cursor / Claude Desktop)

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "acil": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/tools/acil-mcp/dist/server.js"]
    }
  }
}
```

Tools available: `acil_preflight` · `acil_status` · `acil_forecast` · `acil_budget` · `acil_feedback` · `acil_compliance`

---

## Enterprise Features

- **Policy Server** — central `.acil.json` pushed to all developer instances via HMAC-signed HTTP
- **HMAC-Signed Audit Export** — tamper-proof compliance batches (SHA-256 + HMAC-SHA256)
- **Team Budget Policies** — `.acil.json` in workspace root, hot-reloaded on save
- **`@nit-in/acil-learn` SDK** — embed the learning loop in any Node.js tooling

---

## Privacy

ACIL stores data **locally only**:
- `~/.acil/` — audit trail, session outcomes, feedback signals
- VS Code `SecretStorage` (OS Keychain) — GitHub PAT if connected
- Nothing is sent to any external server

The GitHub PAT (if provided) is used only to call `api.github.com` for billing data. It is never logged, never included in the audit trail, never committed.

> **Note:** GitHub personal Copilot Pro+ accounts do not expose billing data via PAT API (GitHub limitation). ACIL operates fully without it — the bootstrap wizard seeds the initial balance.

---

## Patent

- **Wave 10** — Filed June 29, 2026 — USPTO Application 19/668,817
  Session classification, CCT compression, semantic equivalence gate, TSP forecasting, 6-state enforcement
- **Wave 11** — Target September 1, 2026
  Meta-recursive self-calibration, feedback-driven thresholds, enterprise policy federation

---

## Author

Built by **Kristoffer Kelly** ([@imKrisK](https://github.com/imKrisK))

---

*ACIL — AI Credit Intelligence Layer. The gate between your IDE and your invoice.*
