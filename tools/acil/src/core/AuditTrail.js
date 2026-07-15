"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditTrail = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class AuditTrail {
    _events = [];
    _enforcementLog = [];
    _burnSeeds;
    /**
     * Append a completed SessionEvent to the audit trail.
     * Called by the metering pipeline after each API call completes.
     */
    append(event) {
        this._events.push(event);
    }
    /**
     * Record an enforcement state transition.
     * Provides the timeline for: "when did quota exhaust?" analysis.
     */
    logEnforcementState(state) {
        const last = this._enforcementLog[this._enforcementLog.length - 1];
        if (!last || last.state !== state) {
            this._enforcementLog.push({ timestamp: new Date(), state });
        }
    }
    /**
     * Returns daily burn records grouped by date.
     * This is the data structure that powers TSP's rolling burn rate calculator.
     *
     * Empirical reference: the June 2026 CSV data (imKrisK GitHub report)
     * is exactly this format — ACIL generates it natively.
     */
    dailyBurns(from, to) {
        const grouped = new Map();
        for (const event of this._events) {
            if (from && event.timestamp < from)
                continue;
            if (to && event.timestamp > to)
                continue;
            const key = event.timestamp.toISOString().slice(0, 10);
            if (!grouped.has(key))
                grouped.set(key, []);
            grouped.get(key).push(event);
        }
        const records = [];
        for (const [date, events] of Array.from(grouped.entries()).sort()) {
            const byType = {};
            const byModel = {};
            let gross = 0, discount = 0, net = 0, requests = 0;
            for (const e of events) {
                gross += e.grossCost;
                discount += e.discountAmount;
                net += e.netCost;
                requests++;
                byType[e.sessionType] = (byType[e.sessionType] ?? 0) + 1;
                byModel[e.modelId] = (byModel[e.modelId] ?? 0) + 1;
            }
            records.push({
                date,
                totalRequests: requests,
                grossCost: gross,
                discountAmount: discount,
                netCost: net,
                bySessionType: byType,
                byModel: byModel,
                hitOverage: net > 0,
            });
        }
        // P3: Merge GitHub historical seed data for dates with no real ACIL events
        if (this._burnSeeds) {
            for (const [date, seed] of this._burnSeeds.entries()) {
                if (!records.find(r => r.date === date)) {
                    records.push({
                        date,
                        totalRequests: seed.totalRequests,
                        grossCost: seed.grossCost,
                        discountAmount: seed.grossCost, // fully within quota (seed assumption)
                        netCost: 0,
                        bySessionType: {},
                        byModel: {},
                        hitOverage: false,
                    });
                }
            }
            records.sort((a, b) => a.date.localeCompare(b.date));
        }
        return records;
    }
    /**
     * Full audit summary for a period.
     */
    summarize(from, to) {
        const relevant = this._events.filter(e => (!from || e.timestamp >= from) && (!to || e.timestamp <= to));
        const byType = {};
        const byModel = {};
        // Model substitution analytics — Wave 10 Claim 7
        const substitutions = [];
        let tokens = 0, gross = 0, net = 0, discount = 0, cctSaved = 0;
        for (const e of relevant) {
            tokens += e.usage.totalTokens;
            gross += e.grossCost;
            net += e.netCost;
            discount += e.discountAmount;
            byType[e.sessionType] = (byType[e.sessionType] ?? 0) + 1;
            byModel[e.modelId] = (byModel[e.modelId] ?? 0) + 1;
            if (e.originalTokens != null && e.translatedTokens != null) {
                cctSaved += e.originalTokens - e.translatedTokens;
            }
            if (e.wasDowngraded && e.originalModelId) {
                substitutions.push({
                    from: e.originalModelId,
                    to: e.modelId,
                    savingsUsd: e.substitutionSavingsUsd ?? 0,
                });
            }
        }
        // Aggregate substitution stats
        const totalSubstitutions = substitutions.length;
        const totalSubstitutionSavingsUsd = substitutions.reduce((s, x) => s + x.savingsUsd, 0);
        // Group by from→to pair
        const substitutionBreakdown = {};
        for (const s of substitutions) {
            const key = `${s.from}→${s.to}`;
            if (!substitutionBreakdown[key])
                substitutionBreakdown[key] = { count: 0, totalSavingsUsd: 0 };
            substitutionBreakdown[key].count++;
            substitutionBreakdown[key].totalSavingsUsd += s.savingsUsd;
        }
        return {
            periodStart: from ?? (relevant[0]?.timestamp ?? new Date()),
            periodEnd: to ?? (relevant[relevant.length - 1]?.timestamp ?? new Date()),
            totalEvents: relevant.length,
            totalTokens: tokens,
            totalGross: gross,
            totalNet: net,
            totalDiscount: discount,
            cctSavingsTokens: cctSaved,
            dailyBurns: this.dailyBurns(from, to),
            bySessionType: byType,
            byModel: byModel,
            enforcementStateHistory: this._enforcementLog,
            // Substitution analytics
            totalSubstitutions,
            totalSubstitutionSavingsUsd,
            substitutionBreakdown,
        };
    }
    get eventCount() {
        return this._events.length;
    }
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
    exportCSV(filePath) {
        const header = [
            'date',
            'model',
            'session_type',
            'input_tokens',
            'output_tokens',
            'cached_tokens',
            'total_tokens',
            'gross_cost_usd',
            'discount_usd',
            'net_cost_usd',
            'balance_after_usd',
            'cct_savings_tokens',
            'predicted_cost_usd',
        ].join(',');
        const rows = this._events.map(e => {
            const date = e.timestamp instanceof Date
                ? e.timestamp.toISOString().slice(0, 10)
                : String(e.timestamp).slice(0, 10);
            const cctSaved = e.originalTokens && e.translatedTokens
                ? e.originalTokens - e.translatedTokens
                : 0;
            return [
                date,
                e.modelId,
                e.sessionType,
                e.usage.inputTokens,
                e.usage.outputTokens,
                e.usage.cachedTokens,
                e.usage.totalTokens,
                e.grossCost.toFixed(6),
                e.discountAmount.toFixed(6),
                e.netCost.toFixed(6),
                e.balanceAfter.toFixed(6),
                cctSaved,
                e.predictedCost != null ? e.predictedCost.toFixed(6) : '',
            ].join(',');
        });
        const csv = [header, ...rows].join('\n');
        if (filePath) {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            const tmp = filePath + '.tmp';
            fs.writeFileSync(tmp, csv, 'utf8');
            fs.renameSync(tmp, filePath);
        }
        return csv;
    }
    /**
     * Seed a synthetic daily burn record from GitHub historical data.
     * Used on day-1 install to give TSP real burn rate data immediately.
     * Seeded records are NOT real sessions — they have no eventId, modelId, etc.
     * They only affect dailyBurns() output for TSP burn rate calculation.
     * Safe to call multiple times — deduplicates by date.
     */
    _seedDailyBurn(date, grossCost, totalRequests) {
        // Store seeds in a separate map, merged into dailyBurns() output
        if (!this._burnSeeds)
            this._burnSeeds = new Map();
        // Don't overwrite if we already have real data for this date
        const existing = this._events.some(e => {
            const d = e.timestamp instanceof Date
                ? e.timestamp.toISOString().slice(0, 10)
                : String(e.timestamp).slice(0, 10);
            return d === date;
        });
        if (!existing) {
            this._burnSeeds.set(date, { grossCost, totalRequests });
        }
    }
    /**
     * Export events as JSON (for persistence or reporting).
     */
    export() {
        return [...this._events];
    }
    /**
     * Persist audit trail to a JSON file.
     * Called by VS Code extension on deactivate() and periodically.
     * Safe to call multiple times — atomic write via temp file + rename.
     *
     * @param filePath Absolute path to the JSON file (e.g. in VS Code globalStorageUri)
     */
    save(filePath) {
        const payload = JSON.stringify({
            version: 1,
            savedAt: new Date().toISOString(),
            events: this._events,
        }, null, 2);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, filePath);
    }
    /**
     * Load events from a previously saved JSON file.
     * Merges loaded events with any already in memory (deduplicates by eventId).
     * Silently no-ops if the file doesn't exist.
     *
     * @param filePath Absolute path to the JSON file
     */
    load(filePath) {
        if (!fs.existsSync(filePath))
            return;
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(raw);
            if (!Array.isArray(data.events))
                return;
            const existingIds = new Set(this._events.map(e => e.eventId));
            let loaded = 0;
            for (const ev of data.events) {
                if (!existingIds.has(ev.eventId)) {
                    // Rehydrate Date objects (JSON.parse returns strings)
                    ev.timestamp = new Date(ev.timestamp);
                    this._events.push(ev);
                    loaded++;
                }
            }
            this._events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        }
        catch {
            // Corrupted file — ignore, don't crash
        }
    }
    // ─────────────────────────────────────────────────────────────────────────
    // HMAC-Signed Audit Batch Export  (Wave 11 — Compliance Feature)
    //
    // Produces a tamper-proof audit package for regulated industry submissions:
    //   SOC 2 / HIPAA AI policies / EU AI Act Art. 13 audit obligations.
    //
    // The signed batch contains:
    //   - Full CSV export (matching GitHub Copilot billing column format)
    //   - SHA-256 hash of the CSV payload
    //   - HMAC-SHA256 signature of (csvHash + batchId + timestamp)
    //   - Batch metadata (eventCount, periodStart, periodEnd)
    //
    // A compliance officer can independently verify the signature using
    // verifyBatch() with the same HMAC key — proving the CSV was not modified
    // after the developer's IDE generated it.
    //
    // Author: imKrisK — Wave 11 Enterprise Feature
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Export audit events as a signed compliance batch.
     *
     * @param hmacKey   Shared secret (store in secrets manager — never in code)
     * @param filePath  Optional — write the JSON envelope to disk (atomic)
     */
    exportSignedBatch(hmacKey, filePath) {
        const crypto = require('crypto');
        const csv = this.exportCSV();
        const batchId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        // Step 1 — SHA-256 over CSV content (content integrity)
        const csvHash = crypto.createHash('sha256').update(csv, 'utf8').digest('hex');
        // Step 2 — HMAC-SHA256 over (csvHash + batchId + timestamp)
        //          Binds the hash to a unique batch identity + issue time.
        //          Prevents replay of an older valid batch as a newer one.
        const sigPayload = csvHash + batchId + timestamp;
        const signature = crypto
            .createHmac('sha256', hmacKey)
            .update(sigPayload, 'utf8')
            .digest('hex');
        const batch = {
            batchId,
            timestamp,
            algorithm: 'sha256-hmac',
            csvHash,
            signature,
            eventCount: this._events.length,
            periodStart: this._events.length > 0
                ? this._events[0].timestamp.toISOString()
                : timestamp,
            periodEnd: this._events.length > 0
                ? this._events[this._events.length - 1].timestamp.toISOString()
                : timestamp,
            csv,
        };
        if (filePath) {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            const tmp = filePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(batch, null, 2), 'utf8');
            fs.renameSync(tmp, filePath);
        }
        return batch;
    }
    /**
     * Verify a previously exported SignedAuditBatch.
     *
     * Returns a detailed result so a compliance tool can surface exactly
     * what passed or failed rather than just a boolean.
     */
    static verifyBatch(batch, hmacKey) {
        const crypto = require('crypto');
        // Step 1 — Recompute CSV hash
        const recomputedCsvHash = crypto
            .createHash('sha256')
            .update(batch.csv, 'utf8')
            .digest('hex');
        const csvIntact = recomputedCsvHash === batch.csvHash;
        // Step 2 — Recompute HMAC
        const sigPayload = batch.csvHash + batch.batchId + batch.timestamp;
        const expectedSig = crypto
            .createHmac('sha256', hmacKey)
            .update(sigPayload, 'utf8')
            .digest('hex');
        const expBuf = Buffer.from(expectedSig, 'hex');
        const actBuf = Buffer.from(batch.signature, 'hex');
        const signatureValid = expBuf.length === actBuf.length
            && crypto.timingSafeEqual(expBuf, actBuf);
        return {
            valid: csvIntact && signatureValid,
            csvIntact,
            signatureValid,
            batchId: batch.batchId,
            eventCount: batch.eventCount,
            periodStart: batch.periodStart,
            periodEnd: batch.periodEnd,
            verifiedAt: new Date().toISOString(),
        };
    }
}
exports.AuditTrail = AuditTrail;
