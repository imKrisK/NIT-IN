"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SharedBudgetPool = void 0;
const types_1 = require("../core/types");
const STATE_THRESHOLDS = [
    [1.00, types_1.EnforcementState.EXHAUSTED],
    [0.98, types_1.EnforcementState.EXHAUSTED],
    [0.90, types_1.EnforcementState.CRITICAL],
    [0.75, types_1.EnforcementState.WARNING],
    [0.60, types_1.EnforcementState.ADVISORY],
    [0.00, types_1.EnforcementState.NORMAL],
];
class SharedBudgetPool {
    _allocation;
    _balance;
    _consumers = new Set();
    _bySource = new Map();
    _listeners = new Map();
    _lock = false; // simple mutex for atomic debit
    constructor(monthlyAllocation, initialBalance) {
        this._allocation = monthlyAllocation;
        this._balance = initialBalance ?? monthlyAllocation;
    }
    /** Register a consumer agent. Returns an unsubscribe function. */
    register(source, onStateChange) {
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
    async debit(source, cost) {
        // Spin-wait for lock (max 100ms — prevents race in parallel agents)
        const deadline = Date.now() + 100;
        while (this._lock && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2));
        }
        this._lock = true;
        try {
            const state = this._computeState();
            if (state === types_1.EnforcementState.EXHAUSTED || state === types_1.EnforcementState.CRITICAL) {
                return {
                    allowed: false, newBalance: this._balance,
                    enforcementState: state, source, cost,
                    reason: `Budget ${state} — pool balance $${this._balance.toFixed(4)}`,
                };
            }
            this._balance = Math.max(0, this._balance - cost);
            this._bySource.set(source, (this._bySource.get(source) ?? 0) + cost);
            const newState = this._computeState();
            if (newState !== state)
                this._broadcast(newState);
            return { allowed: true, newBalance: this._balance, enforcementState: newState, source, cost };
        }
        finally {
            this._lock = false;
        }
    }
    /** Non-mutating peek — used by MCP acil_status and dashboard. */
    peek() {
        const spent = this._allocation - this._balance;
        return {
            totalAllocation: this._allocation,
            balance: this._balance,
            spent,
            budgetPct: Math.round((spent / this._allocation) * 1000) / 10,
            enforcementState: this._computeState(),
            bySource: Object.fromEntries(this._bySource),
            consumerCount: this._consumers.size,
        };
    }
    /** Refill pool (e.g. billing cycle reset). */
    refill(newAllocation) {
        if (newAllocation)
            this._allocation = newAllocation;
        this._balance = this._allocation;
        this._bySource.clear();
        this._broadcast(this._computeState());
    }
    /** Manually correct balance (from reconcileBalance command). */
    setBalance(balance) {
        this._balance = Math.max(0, Math.min(balance, this._allocation));
        this._broadcast(this._computeState());
    }
    get balance() { return this._balance; }
    get allocation() { return this._allocation; }
    _computeState() {
        const pct = 1 - (this._balance / this._allocation);
        for (const [threshold, state] of STATE_THRESHOLDS) {
            if (pct >= threshold)
                return state;
        }
        return types_1.EnforcementState.NORMAL;
    }
    _broadcast(state) {
        for (const [, cb] of this._listeners) {
            try {
                cb(state, this._balance);
            }
            catch { /* non-blocking */ }
        }
    }
}
exports.SharedBudgetPool = SharedBudgetPool;
