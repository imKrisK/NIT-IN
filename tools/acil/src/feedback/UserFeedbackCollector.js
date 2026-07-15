"use strict";
/**
 * ACIL — UserFeedbackCollector
 *
 * Tracks developer accept/reject decisions on ACIL recommendations so the
 * MetaRecursiveLoop can learn which suggestions are trusted vs. ignored.
 *
 * Three feedback signals collected:
 *   1. Model substitution — did developer accept the cheaper model suggestion?
 *   2. CCT compression — did developer let the compressed prompt through?
 *   3. Budget enforcement — did developer override a soft-block?
 *
 * Feedback is persisted to `acil-feedback.json` alongside audit data.
 * The MetaRecursiveLoop calls `getSignals()` during calibrate() to adjust:
 *   - Model substitution confidence weight
 *   - CCT threshold (if developer keeps rejecting, raise it)
 *   - Soft-block override rate (signals budget misconfiguration)
 *
 * Author: imKrisK — Wave 11 Learning Layer
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
exports.UserFeedbackCollector = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const VERSION = 1;
// ── UserFeedbackCollector ────────────────────────────────────────────────────
class UserFeedbackCollector {
    _events = [];
    // ── Record ──────────────────────────────────────────────────────────────
    record(action, context, sessionType) {
        this._events.push({
            action,
            timestamp: new Date().toISOString(),
            context,
            sessionType,
        });
    }
    /** Convenience: record model sub accepted or rejected in one call. */
    recordModelSub(accepted, fromModel, toModel) {
        this.record(accepted ? 'MODEL_SUB_ACCEPTED' : 'MODEL_SUB_REJECTED', `${fromModel}→${toModel}`);
    }
    /** Convenience: record CCT accepted or rejected. */
    recordCCT(accepted, savingsPct, sessionType) {
        this.record(accepted ? 'CCT_ACCEPTED' : 'CCT_REJECTED', `savings=${Math.round(savingsPct * 100)}%`, sessionType);
    }
    /** Convenience: record agentic gate decision. */
    recordAgentic(confirmed) {
        this.record(confirmed ? 'AGENTIC_CONFIRMED' : 'AGENTIC_CANCELLED');
    }
    /** Convenience: record soft-block outcome. */
    recordSoftBlock(overridden) {
        this.record(overridden ? 'SOFT_BLOCK_OVERRIDDEN' : 'BUDGET_IGNORED');
    }
    // ── Analyze ─────────────────────────────────────────────────────────────
    /** Compute learning signals for MetaRecursiveLoop.calibrate(). */
    getSignals() {
        const modelSubs = this._events.filter(e => e.action === 'MODEL_SUB_ACCEPTED' || e.action === 'MODEL_SUB_REJECTED');
        const cctEvents = this._events.filter(e => e.action === 'CCT_ACCEPTED' || e.action === 'CCT_REJECTED');
        const blockEvents = this._events.filter(e => e.action === 'SOFT_BLOCK_OVERRIDDEN');
        const agenticEvts = this._events.filter(e => e.action === 'AGENTIC_CONFIRMED' || e.action === 'AGENTIC_CANCELLED');
        const rate = (accepted, events) => {
            if (events.length === 0)
                return 0.5; // neutral when no data
            return events.filter(e => e.action === accepted).length / events.length;
        };
        const modelSubAcceptRate = rate('MODEL_SUB_ACCEPTED', modelSubs);
        const cctAcceptRate = rate('CCT_ACCEPTED', cctEvents);
        const agenticConfirmRate = rate('AGENTIC_CONFIRMED', agenticEvts);
        const softBlockOverrideRate = blockEvents.length > 0
            ? blockEvents.length / Math.max(this._events.length, 1)
            : 0;
        // Derive biases from rates (thresholds tuned from empirical testing)
        const cctThresholdBias = cctAcceptRate < 0.35 ? 'tighten' : // developer keeps rejecting → raise bar
            cctAcceptRate > 0.80 ? 'loosen' : // developer always accepts → can be more aggressive
                'stable';
        const modelSubConfidenceBias = modelSubAcceptRate < 0.40 ? 'decrease' :
            modelSubAcceptRate > 0.75 ? 'increase' :
                'stable';
        return {
            modelSubAcceptRate,
            cctAcceptRate,
            softBlockOverrideRate,
            agenticConfirmRate,
            totalEvents: this._events.length,
            cctThresholdBias,
            modelSubConfidenceBias,
        };
    }
    /** Recent events (last N), newest first. */
    recent(n = 20) {
        return [...this._events].reverse().slice(0, n);
    }
    get totalEvents() { return this._events.length; }
    // ── Persistence ─────────────────────────────────────────────────────────
    save(filePath) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        const data = { version: VERSION, events: this._events };
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, filePath);
    }
    load(filePath) {
        if (!fs.existsSync(filePath))
            return;
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(raw);
            if (Array.isArray(data.events)) {
                this._events = data.events;
            }
        }
        catch {
            // Corrupted file — start fresh, don't crash
        }
    }
}
exports.UserFeedbackCollector = UserFeedbackCollector;
