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
import { TokenUsage, ModelId } from './types';
export interface BillingResult {
    modelId: ModelId;
    grossCost: number;
    discountAmount: number;
    netCost: number;
    remainingQuota: number;
}
export declare class CreditBilling {
    private _includedQuota;
    private _quotaConsumed;
    constructor(includedQuota: number, quotaConsumed?: number);
    /**
     * Bill a token usage event against the current quota balance.
     *
     * Handles three cases:
     * 1. Fully within quota → discount covers 100% of gross cost, net = 0
     * 2. Fully beyond quota → no discount, net = gross cost
     * 3. Straddles quota boundary → partial discount (Intertrust partial-billing pattern)
     */
    bill(usage: TokenUsage, modelId: ModelId): BillingResult;
    /** Current remaining quota. */
    get remainingQuota(): number;
    /** Total quota consumed this period. */
    get quotaConsumed(): number;
    /** Update consumed quota externally (e.g. from API sync). */
    sync(consumed: number): void;
    private _computeGross;
    private _round;
}
//# sourceMappingURL=CreditBilling.d.ts.map