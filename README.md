# NIT-IN — Node Identity Token & AI Credit Intelligence Layer

> **Patent Pending** — USPTO Application 64/110,180 | Filed July 13, 2026 | Confirmation #2594

---

## ACIL — AI Credit Intelligence Layer

**Now live on VS Marketplace →** [imKrisK.acil-vscode](https://marketplace.visualstudio.com/items?itemName=imKrisK.acil-vscode)

June 7 I lost $111 in one AI session.

528 Copilot requests. One agentic run. Gone by 11 AM. No warning from GitHub. Just a bill.

So I built the warning system.

ACIL intercepts every LLM request **before tokens are spent**. Classifies your session type. Predicts cost. Compresses the prompt. Routes to a cheaper model if the task doesn't need the heavy one. Enforces a 6-state budget machine. Learns your patterns — gets more accurate every session.

Tested backwards against June 7 data. Predicted that exact exhaustion event on June 6 input. Risk score: 0.942. GitHub showed nothing.

---

## Install

```bash
# VS Code Extensions — search "ACIL"
code --install-extension imKrisK.acil-vscode
```

**MCP for Cursor / Claude Desktop** — `.vscode/mcp.json`:
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

---

## What's Inside

| Package | Purpose |
|---|---|
| `tools/acil/` | Core SDK — 18 TypeScript modules, 55/55 tests |
| `tools/acil-vscode/` | VS Code extension — 164 KB VSIX, `@acil` chat participant |
| `tools/acil-mcp/` | MCP server — 7 tools for Cursor + Claude Desktop |
| `tools/acil-learn/` | Standalone learning SDK — zero VS Code dependency |
| `tools/acil-policy-server/` | Enterprise policy server — HMAC-signed team config |
| `tools/acil-presentation/` | Interactive live infographic — `node server.js` on :7420 |

## The 7 Components

```
① Classify  — SessionClassifier: 7 session types from IDE telemetry
② Predict   — BurnPredictor + TSP: exhaustion date before tokens fire
③ Compress  — PromptCompressor CCT + SemanticEquivalenceChecker Tier 1+2
④ Route     — CostRouter: 10 model substitution pairs
⑤ Enforce   — BudgetEnforcer: 6-state graduated machine
⑥ Learn     — MetaRecursiveLoop + 7 developer archetypes (self-calibrating)
⑦ Record    — AuditTrail: HMAC-signed tamper-proof export (SOC 2 / EU AI Act)
```

---

## Patent

- **Wave 10** — USPTO Application 64/110,180 — Filed July 13, 2026
  16 claims: pre-execution session classification, CCT compression,
  semantic equivalence gate, TSP forecasting, 6-state enforcement
- **Wave 11** — Target September 1, 2026

---

## Author

**Kristoffer Kelly** ([@imKrisK](https://github.com/imKrisK)) · Las Vegas, NV
[conversationmine.ai](https://conversationmine.ai) · [LinkedIn](https://www.linkedin.com/in/kristofferkelly/)

*Patent Pending — USPTO 64/110,180 · Confirmation #2594 · Filed July 13, 2026*
