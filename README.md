# NIT-IN: Node Identity Token & ACIL Governance Layer

An architecture delivering a hardware-attested sovereign identity protocol for embedded networks combined with a client-side Active Context & Instruction Layer (ACIL) for local LLM token governance, AST prompt validation, and multi-tenant data stream isolation.

## 🚀 Architectural Overview

The `NIT-IN` system establishes an immutable, hardware-verified identity baseline for distributed devices, processing low-level cryptographic state mutations and high-performance data pipelines. Operating natively alongside this core is the **ACIL Layer**, an operational gatekeeper that intercept requests at the client level to govern AI workload boundaries, compact context windows, and enforce strict execution guardrails before data interfaces with external cloud resources.

### Key Engineering Features
*   **Hardware-Attested Sovereignty:** Cryptographic protocol execution providing trusted execution boundaries and state synchronization for multi-tenant deployments.
*   **Client-Side Token Governance (ACIL):** Localized runtime ceilings that actively monitor session budgets, preventing request amplification or runaway costs.
*   **AST Prompt Validation:** Client-side Abstract Syntax Tree parsing to sanitize inputs, manage prompt injection pathways, and audit instruction structures.
*   **Context Compaction & Data Parsing:** Dynamic data array filtering and token optimization routines, utilizing optimized mapping patterns for real-time visualization systems (integrated via Recharts).

## 🛡️ Production Case Study: Mitigating Runaway Agent Loops

This architecture features a live runtime guardrail engineered to eliminate infinite-request loops. During an open-market deployment failure where an uncontained cloud model iteration executed continuous recursive calls—depleting standard token budgets within minutes—this layer intervened locally. By enforcing client-side AST pruning and hard boundary token ceilings, the gatekeeper successfully severed the runaway request loop at the client source, maintaining zero cloud budget leakage.

## 🛠️ Stack & Interface Conventions
*   **Core Systems:** TypeScript, Node.js environment layers
*   **Data Pipelines & Visualization:** Structured JSON schemas, array processing, Recharts data visualizers
*   **Security & Isolation:** Multi-tenant cryptographic token primitives, local data governance boundaries

## 💻 Getting Started

### Local Setup
Ensure you have Node.js installed in your environment, then initialize the workspace dependencies:
```bash
npm install
```

### Running Test Environments
To execute the automated verification test suites and validate local state mutations, run:
```bash
npm run test
```
