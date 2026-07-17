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
export type AgentSource = 'copilot' | 'claude-code' | 'cursor' | 'mcp-client' | 'acil-learn' | string;
export interface PoolDebitResult {
    allowed: boolean;
    newBalance: number;
    enforcementState: EnforcementState;
    source: AgentSource;
    cost: number;
    reason?: string;
}
export interface PoolSnapshot {
    totalAllocation: number;
    balance: number;
    spent: number;
    budgetPct: number;
    enforcementState: EnforcementState;
    bySource: Record<string, number>;
    consumerCount: number;
}
export declare class SharedBudgetPool {
    private _allocation;
    private _balance;
    private _consumers;
    private _bySource;
    private _listeners;
    private _lock;
    constructor(monthlyAllocation: number, initialBalance?: number);
    /** Register a consumer agent. Returns an unsubscribe function. */
    register(source: AgentSource, onStateChange: (state: EnforcementState, balance: number) => void): () => void;
    /**
     * Attempt to debit `cost` from the pool on behalf of `source`.
     * Returns allowed=false if enforcement state would block the request.
     * Atomic — concurrent calls are queued.
     */
    debit(source: AgentSource, cost: number): Promise<PoolDebitResult>;
    /** Non-mutating peek — used by MCP acil_status and dashboard. */
    peek(): PoolSnapshot;
    /** Refill pool (e.g. billing cycle reset). */
    refill(newAllocation?: number): void;
    /** Manually correct balance (from reconcileBalance command). */
    setBalance(balance: number): void;
    get balance(): number;
    get allocation(): number;
    private _computeState;
    private _broadcast;
}
//# sourceMappingURL=SharedBudgetPool.d.ts.map