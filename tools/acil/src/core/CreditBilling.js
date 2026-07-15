"use strict";
/**
 * ACIL — CreditBilling
 *
 * Applies per-model token pricing to a metered TokenUsage record,
 * producing gross cost, discount amount, and net billable cost.
 *
 * Implements Intertrust's "billing method with price-per-atomic-element"
 * (US5892900A, expired 2016 — public domain):
 *   units × rate = bill
 *   Applied here as:  tokens × price_per_1k / 1000 = USD cost
 *
 * The discount logic mirrors GitHub's copilot_premium_request billing:
 * - Requests within the included quota → discount = gross (net = 0)
 * - Requests beyond quota → no discount (net = gross)
 * - Partial quota boundary → split billing (see June 7, 2026 case in audit)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreditBilling = void 0;
const PricingConfig_1 = require("../models/PricingConfig");
class CreditBilling {
    _includedQuota; // Total included credits for period (USD or units)
    _quotaConsumed; // Quota used so far this period
    constructor(includedQuota, quotaConsumed = 0) {
        this._includedQuota = includedQuota;
        this._quotaConsumed = quotaConsumed;
    }
    /**
     * Bill a token usage event against the current quota balance.
     *
     * Handles three cases:
     * 1. Fully within quota → discount covers 100% of gross cost, net = 0
     * 2. Fully beyond quota → no discount, net = gross cost
     * 3. Straddles quota boundary → partial discount (Intertrust partial-billing pattern)
     */
    bill(usage, modelId) {
        const pricing = PricingConfig_1.MODEL_PRICING[modelId];
        const gross = this._computeGross(usage, pricing.inputPer1k, pricing.outputPer1k, pricing.cachedPer1k);
        const quotaRemaining = Math.max(0, this._includedQuota - this._quotaConsumed);
        let discount;
        let net;
        if (quotaRemaining >= gross) {
            // Case 1: fully covered by included quota
            discount = gross;
            net = 0;
        }
        else if (quotaRemaining <= 0) {
            // Case 2: no quota left — full overage
            discount = 0;
            net = gross;
        }
        else {
            // Case 3: partial — quota covers some, overage covers rest
            // (This is exactly what happened on June 7, 2026 — quota exhausted mid-day)
            discount = quotaRemaining;
            net = gross - quotaRemaining;
        }
        this._quotaConsumed += discount; // Only quota consumption advances the counter
        return {
            modelId,
            grossCost: this._round(gross),
            discountAmount: this._round(discount),
            netCost: this._round(net),
            remainingQuota: this._round(Math.max(0, this._includedQuota - this._quotaConsumed)),
        };
    }
    /** Current remaining quota. */
    get remainingQuota() {
        return Math.max(0, this._includedQuota - this._quotaConsumed);
    }
    /** Total quota consumed this period. */
    get quotaConsumed() {
        return this._quotaConsumed;
    }
    /** Update consumed quota externally (e.g. from API sync). */
    sync(consumed) {
        this._quotaConsumed = consumed;
    }
    _computeGross(usage, inputRate, outputRate, cachedRate) {
        return ((usage.inputTokens / 1000) * inputRate +
            (usage.outputTokens / 1000) * outputRate +
            (usage.cachedTokens / 1000) * cachedRate);
    }
    _round(value) {
        return Math.round(value * 100000) / 100000;
    }
}
exports.CreditBilling = CreditBilling;
