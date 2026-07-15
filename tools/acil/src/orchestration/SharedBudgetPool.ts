/**
 * ACIL Wave 12 — SharedBudgetPool
 *
 * A single credit balance shared across ALL parallel AI instances running
 * on a developer's machine simultaneously:
 *   - GitHub Copilot (VS Code)
 *   - Claude Code (VS Code)
 *   - Cursor Agent
 *   - Any MCP client
 *
 * Problem this solves:
 *   Without a shared pool, each agent burns independently. A developer
 *   running Copilot + Cursor simultaneously depletes 2× the credits with
 *   zero coordination. The pool enforces a single balance across all sources.
 *
 * Architecture:
 *   - Each agent "consumer" registers with the pool
 *   - Every preflight debit is atomic — no two consumers can double-spend
 *   - Pool emits enforcement state to ALL consumers when balance changes
 *   - Usage is tracked per-source for analytics
 *
 * Patent: Wave 12 Claim 1
 * Author: imKrisK
 */

import { EnforcementState } from '../core/types';

export type AgentSource =
  | 'copilot'
  | 'claude-code'
  | 'cursor'
  | 'mcp-client'
  | 'acil-learn'
  | string; // extensible

export interface PoolDebitResult {
  allowed:          boolean;
  newBalance:       number;
  enforcementState: EnforcementState;
  source:           AgentSource;
  cost:             number;
  reason?:          string;
}

export interface PoolSnapshot {
  totalAllocation:  number;
  balance:          number;
  spent:            number;
  budgetPct:        number;
  enforcementState: EnforcementState;
  bySource:         Record<string, number>; // cost per source
  consumerCount:    number;
}

const STATE_THRESHOLDS: [number, EnforcementState][] = [
  [1.00, EnforcementState.EXHAUSTED],
  [0.98, EnforcementState.EXHAUSTED],
  [0.90, EnforcementState.CRITICAL],
  [0.75, EnforcementState.WARNING],
  [0.60, EnforcementState.ADVISORY],
  [0.00, EnforcementState.NORMAL],
];

export class SharedBudgetPool {
  private _allocation:   number;
  private _balance:      number;
  private _consumers:    Set<string> = new Set();
  private _bySource:     Map<string, number> = new Map();
  private _listeners:    Map<string, (state: EnforcementState, balance: number) => void> = new Map();
  private _lock          = false; // simple mutex for atomic debit

  constructor(monthlyAllocation: number, initialBalance?: number) {
    this._allocation = monthlyAllocation;
    this._balance    = initialBalance ?? monthlyAllocation;
  }

  /** Register a consumer agent. Returns an unsubscribe function. */
  register(
    source: AgentSource,
    onStateChange: (state: EnforcementState, balance: number) => void,
  ): () => void {
    this._consumers.add(source);
    this._listeners.set(source, onStateChange);
    // Immediately notify of current state
    onStateChange(this._computeState(), this._balance);
    return () => {
      this._consumers.delete(source);
      this._listeners.delete(source);
    };
  }

  /**
   * Attempt to debit `cost` from the pool on behalf of `source`.
   * Returns allowed=false if enforcement state would block the request.
   * Atomic — concurrent calls are queued.
   */
  async debit(source: AgentSource, cost: number): Promise<PoolDebitResult> {
    // Spin-wait for lock (max 100ms — prevents race in parallel agents)
    const deadline = Date.now() + 100;
    while (this._lock && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2));
    }
    this._lock = true;

    try {
      const state = this._computeState();

      if (state === EnforcementState.EXHAUSTED || state === EnforcementState.CRITICAL) {
        return {
          allowed: false, newBalance: this._balance,
          enforcementState: state, source, cost,
          reason: `Budget ${state} — pool balance $${this._balance.toFixed(4)}`,
        };
      }

      this._balance = Math.max(0, this._balance - cost);
      this._bySource.set(source, (this._bySource.get(source) ?? 0) + cost);

      const newState = this._computeState();
      if (newState !== state) this._broadcast(newState);

      return { allowed: true, newBalance: this._balance, enforcementState: newState, source, cost };
    } finally {
      this._lock = false;
    }
  }

  /** Non-mutating peek — used by MCP acil_status and dashboard. */
  peek(): PoolSnapshot {
    const spent = this._allocation - this._balance;
    return {
      totalAllocation:  this._allocation,
      balance:          this._balance,
      spent,
      budgetPct:        Math.round((spent / this._allocation) * 1000) / 10,
      enforcementState: this._computeState(),
      bySource:         Object.fromEntries(this._bySource),
      consumerCount:    this._consumers.size,
    };
  }

  /** Refill pool (e.g. billing cycle reset). */
  refill(newAllocation?: number): void {
    if (newAllocation) this._allocation = newAllocation;
    this._balance = this._allocation;
    this._bySource.clear();
    this._broadcast(this._computeState());
  }

  /** Manually correct balance (from reconcileBalance command). */
  setBalance(balance: number): void {
    this._balance = Math.max(0, Math.min(balance, this._allocation));
    this._broadcast(this._computeState());
  }

  get balance():     number { return this._balance; }
  get allocation():  number { return this._allocation; }

  private _computeState(): EnforcementState {
    const pct = 1 - (this._balance / this._allocation);
    for (const [threshold, state] of STATE_THRESHOLDS) {
      if (pct >= threshold) return state;
    }
    return EnforcementState.NORMAL;
  }

  private _broadcast(state: EnforcementState): void {
    for (const [, cb] of this._listeners) {
      try { cb(state, this._balance); } catch { /* non-blocking */ }
    }
  }
}
