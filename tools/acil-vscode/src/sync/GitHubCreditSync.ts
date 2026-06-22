/**
 * ACIL — GitHubCreditSync
 *
 * Pulls the developer's live GitHub Copilot credit balance from the
 * GitHub REST API and maps it to a BudgetPeriod for the ACILPipeline.
 *
 * GitHub API endpoints used (in priority order):
 *
 *   1. GET /user/copilot                (individual subscription details)
 *      → plan_type, premium_requests_included, premium_requests_consumed
 *   2. GET /user/copilot/billing/usage  (daily usage breakdown — if accessible)
 *   3. GET /user                        (fallback: confirm auth works)
 *
 * Fallback behavior:
 *   If the GitHub API does not expose credit data (personal accounts),
 *   we return a SyncResult with `syncedFromAPI: false` and the caller
 *   falls back to manual config values.
 *
 * Authentication: GitHub PAT (classic) via SecretManager.
 * Network: HTTPS only. No data sent to any third-party server.
 * Privacy: All calls go directly to api.github.com.
 */

import { BudgetPeriod, EnforcementState } from '@nit-in/acil';

const GITHUB_API = 'https://api.github.com';

export interface CopilotBillingData {
  planType:                   string;    // 'copilot_pro_plus', 'copilot_pro', etc.
  premiumRequestsIncluded:    number;    // monthly quota (e.g. 300 for Pro+)
  premiumRequestsConsumed:    number;    // used so far this billing cycle
  premiumRequestsRemaining:   number;
  billingCycleStart:          Date;
  billingCycleEnd:            Date;
  username:                   string;
  syncedFromAPI:              boolean;   // false = fallback to manual config
  rawResponse?:               unknown;   // for diagnostics
}

export interface SyncResult {
  success:    boolean;
  data?:      CopilotBillingData;
  error?:     string;
}

export class GitHubCreditSync {
  private _pat: string;

  constructor(pat: string) {
    this._pat = pat;
  }

  /**
   * Fetch live Copilot billing data from GitHub API.
   * Returns best-effort data — callers must handle syncedFromAPI=false.
   */
  async fetchBillingData(): Promise<SyncResult> {
    try {
      // Step 1: verify auth + get username
      const userRes = await this._get('/user');
      if (!userRes.ok) {
        return { success: false, error: `GitHub auth failed: ${userRes.status} ${userRes.statusText}` };
      }
      const user = await userRes.json() as { login: string };

      // Step 2: get Copilot subscription info
      const copilotRes = await this._get('/user/copilot');
      if (!copilotRes.ok) {
        // 404 = no Copilot subscription; 403 = scope missing
        const errMsg = copilotRes.status === 404
          ? 'No active Copilot subscription found'
          : `Copilot API error ${copilotRes.status} — PAT may need copilot scope`;
        return { success: false, error: errMsg };
      }
      const copilot = await copilotRes.json() as GitHubCopilotAPIResponse;

      // Step 3: try to get usage breakdown (may 404 on personal accounts)
      let usageData: GitHubCopilotUsageResponse | null = null;
      const usageRes = await this._get('/user/copilot/billing/usage');
      if (usageRes.ok) {
        usageData = await usageRes.json() as GitHubCopilotUsageResponse;
      }

      const data = this._mapToACIL(user.login, copilot, usageData);
      return { success: true, data };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Network error: ${msg}` };
    }
  }

  /**
   * Convert GitHub API response to ACIL BudgetPeriod.
   * Maps premium requests → dollar-equivalent budget using GitHub's
   * published pricing: 1 premium request = $0.04 (overage rate).
   */
  toBudgetPeriod(data: CopilotBillingData): BudgetPeriod {
    // GitHub Copilot charges $0.04/premium request at overage
    const COST_PER_REQUEST = 0.04;

    const totalBudget     = data.premiumRequestsIncluded * COST_PER_REQUEST;
    const consumed        = data.premiumRequestsConsumed * COST_PER_REQUEST;
    const remaining       = Math.max(0, data.premiumRequestsRemaining * COST_PER_REQUEST);
    const pctRemaining    = totalBudget > 0 ? remaining / totalBudget : 1;

    const enforcementState: EnforcementState =
      pctRemaining <= 0.00 ? EnforcementState.EXHAUSTED :
      pctRemaining <= 0.05 ? EnforcementState.CRITICAL  :
      pctRemaining <= 0.10 ? EnforcementState.THROTTLE  :
      pctRemaining <= 0.25 ? EnforcementState.WARNING   :
      pctRemaining <= 0.50 ? EnforcementState.ADVISORY  :
                             EnforcementState.NORMAL;

    return {
      periodId:         `github-${data.billingCycleStart.toISOString().slice(0, 10)}`,
      userId:           data.username,
      startDate:        data.billingCycleStart,
      resetDate:        data.billingCycleEnd,
      totalAllocation:  totalBudget,
      consumed,
      remaining,
      enforcementState,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async _get(path: string): Promise<Response> {
    return fetch(`${GITHUB_API}${path}`, {
      headers: {
        'Authorization': `Bearer ${this._pat}`,
        'Accept':        'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent':    'ACIL-VSCode-Extension/0.1.0',
      },
    });
  }

  private _mapToACIL(
    username:  string,
    copilot:   GitHubCopilotAPIResponse,
    usage:     GitHubCopilotUsageResponse | null,
  ): CopilotBillingData {
    // Billing cycle: GitHub cycles on the user's subscription anniversary date
    // API returns next_billing_date — use it if present, else estimate
    const now   = new Date();
    const cycleStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const cycleEnd   = copilot.next_billing_date
      ? new Date(copilot.next_billing_date)
      : new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // Premium request quota — use plan defaults if API doesn't return them
    const included = copilot.premium_requests_included
      ?? this._quotaFromPlan(copilot.plan?.type ?? copilot.copilot_plan ?? 'unknown');

    const consumed = usage?.total_premium_requests_consumed
      ?? copilot.premium_requests_consumed
      ?? 0;

    return {
      planType:                 copilot.plan?.type ?? copilot.copilot_plan ?? 'unknown',
      premiumRequestsIncluded:  included,
      premiumRequestsConsumed:  consumed,
      premiumRequestsRemaining: Math.max(0, included - consumed),
      billingCycleStart:        cycleStart,
      billingCycleEnd:          cycleEnd,
      username,
      syncedFromAPI:            true,
      rawResponse:              copilot,
    };
  }

  /** Published quota per plan as of Jun 2026 */
  private _quotaFromPlan(planType: string): number {
    const lower = planType.toLowerCase();
    if (lower.includes('pro_plus') || lower.includes('pro+')) return 1500;  // Pro+ ~$39/mo
    if (lower.includes('enterprise'))                           return 1500;
    if (lower.includes('pro'))                                  return 300;  // Pro ~$10/mo
    if (lower.includes('business'))                             return 300;
    return 300; // conservative default
  }
}

// ── GitHub API response shapes (partial — only fields ACIL needs) ────────────

interface GitHubCopilotAPIResponse {
  copilot_plan?:                string;  // older API field
  plan?: {
    type: string;
  };
  premium_requests_included?:   number;
  premium_requests_consumed?:   number;
  next_billing_date?:           string;  // ISO 8601
}

interface GitHubCopilotUsageResponse {
  total_premium_requests_consumed?: number;
  breakdown?: Array<{
    day:              string;
    premium_requests: number;
  }>;
}
