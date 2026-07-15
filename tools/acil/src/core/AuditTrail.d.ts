/**
 * ACIL — AuditTrail
 *
 * Persistent log of all SessionEvents for a developer.
 * Implements Intertrust's "meter trail UDE" pattern — separate audit records
 * for internal metering and external reporting (US5892900A, public domain).
 *
 * Provides the data foundation for:
 * - The Temporal Spend Predictor (TSP) burn rate calculations
 * - The Pre-Execution Burn Rate Predictor (PEBP) historical profiles
 * - The enterprise governance dashboard session attribution
 *
 * Phase 0: in-memory store. Phase 6+ migrates to SQLite (local) → PostgreSQL (cloud).
 */
import { SessionEvent, SessionType, ModelId, EnforcementState } from './types';
export interface DailyBurnRecord {
    date: string;
    totalRequests: number;
    grossCost: number;
    discountAmount: number;
    netCost: number;
    bySessionType: Partial<Record<SessionType, number>>;
    byModel: Partial<Record<ModelId, number>>;
    hitOverage: boolean;
}
export interface AuditSummary {
    periodStart: Date;
    periodEnd: Date;
    totalEvents: number;
    totalTokens: number;
    totalGross: number;
    totalNet: number;
    totalDiscount: number;
    cctSavingsTokens: number;
    dailyBurns: DailyBurnRecord[];
    bySessionType: Partial<Record<SessionType, number>>;
    byModel: Partial<Record<ModelId, number>>;
    enforcementStateHistory: Array<{
        timestamp: Date;
        state: EnforcementState;
    }>;
    totalSubstitutions: number;
    totalSubstitutionSavingsUsd: number;
    substitutionBreakdown: Partial<Record<string, {
        count: number;
        totalSavingsUsd: number;
    }>>;
}
export declare class AuditTrail {
    private _events;
    private _enforcementLog;
    private _burnSeeds?;
    /**
     * Append a completed SessionEvent to the audit trail.
     * Called by the metering pipeline after each API call completes.
     */
    append(event: SessionEvent): void;
    /**
     * Record an enforcement state transition.
     * Provides the timeline for: "when did quota exhaust?" analysis.
     */
    logEnforcementState(state: EnforcementState): void;
    /**
     * Returns daily burn records grouped by date.
     * This is the data structure that powers TSP's rolling burn rate calculator.
     *
     * Empirical reference: the June 2026 CSV data (imKrisK GitHub report)
     * is exactly this format — ACIL generates it natively.
     */
    dailyBurns(from?: Date, to?: Date): DailyBurnRecord[];
    /**
     * Full audit summary for a period.
     */
    summarize(from?: Date, to?: Date): AuditSummary;
    get eventCount(): number;
    /**
     * Export audit events as GitHub-compatible CSV.
     *
     * Column format matches GitHub Copilot Billing CSV exactly:
     *   date, model, session_type, input_tokens, output_tokens, cached_tokens,
     *   total_tokens, gross_cost_usd, discount_usd, net_cost_usd,
     *   enforcement_state, cct_savings_tokens, predicted_cost_usd
     *
     * Use to diff ACIL tracking vs GitHub's own billing download.
     * Optionally pass a filePath to write to disk (atomic write).
     */
    exportCSV(filePath?: string): string;
    /**
     * Seed a synthetic daily burn record from GitHub historical data.
     * Used on day-1 install to give TSP real burn rate data immediately.
     * Seeded records are NOT real sessions — they have no eventId, modelId, etc.
     * They only affect dailyBurns() output for TSP burn rate calculation.
     * Safe to call multiple times — deduplicates by date.
     */
    _seedDailyBurn(date: string, grossCost: number, totalRequests: number): void;
    /**
     * Export events as JSON (for persistence or reporting).
     */
    export(): SessionEvent[];
    /**
     * Persist audit trail to a JSON file.
     * Called by VS Code extension on deactivate() and periodically.
     * Safe to call multiple times — atomic write via temp file + rename.
     *
     * @param filePath Absolute path to the JSON file (e.g. in VS Code globalStorageUri)
     */
    save(filePath: string): void;
    /**
     * Load events from a previously saved JSON file.
     * Merges loaded events with any already in memory (deduplicates by eventId).
     * Silently no-ops if the file doesn't exist.
     *
     * @param filePath Absolute path to the JSON file
     */
    load(filePath: string): void;
    /**
     * Export audit events as a signed compliance batch.
     *
     * @param hmacKey   Shared secret (store in secrets manager — never in code)
     * @param filePath  Optional — write the JSON envelope to disk (atomic)
     */
    exportSignedBatch(hmacKey: string, filePath?: string): SignedAuditBatch;
    /**
     * Verify a previously exported SignedAuditBatch.
     *
     * Returns a detailed result so a compliance tool can surface exactly
     * what passed or failed rather than just a boolean.
     */
    static verifyBatch(batch: SignedAuditBatch, hmacKey: string): AuditVerifyResult;
}
export interface SignedAuditBatch {
    batchId: string;
    timestamp: string;
    algorithm: 'sha256-hmac';
    csvHash: string;
    signature: string;
    eventCount: number;
    periodStart: string;
    periodEnd: string;
    csv: string;
}
export interface AuditVerifyResult {
    valid: boolean;
    csvIntact: boolean;
    signatureValid: boolean;
    batchId: string;
    eventCount: number;
    periodStart: string;
    periodEnd: string;
    verifiedAt: string;
}
//# sourceMappingURL=AuditTrail.d.ts.map