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
  success:              boolean;
  data?:                CopilotBillingData;
  error?:               string;
  scopeMissing?:        boolean;  // PAT needs 'copilot' scope
  personalAccountLimit?: boolean; // GitHub doesn't expose personal Pro+ via API
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
      // Step 1: verify auth — /user always works with any valid PAT
      const userRes = await this._get('/user');
      if (!userRes.ok) {
        if (userRes.status === 401) {
          return { success: false, error: 'PAT is invalid or expired. Generate a new token at github.com/settings/tokens.' };
        }
        return { success: false, error: `GitHub auth failed: ${userRes.status}` };
      }
      const user        = await userRes.json() as { login: string };
      const grantedScopes = (userRes.headers.get('x-oauth-scopes') ?? '').toLowerCase();

      // Step 2: /user/copilot — NOTE: this endpoint is only accessible for
      // GitHub Copilot for Business/Enterprise (org-scoped PATs).
      // Personal Pro+ accounts reliably return 404 regardless of PAT scopes.
      // This is a GitHub API design decision, not a user error.
      const copilotRes = await this._get('/user/copilot');

      if (!copilotRes.ok) {
        // Personal Pro+ account: /user/copilot always 404s — this is expected.
        // Fall back to manual budget mode with a clear, non-alarming message.
        const isPersonalAccountLimit = copilotRes.status === 404;
        const isScopeProblem         = copilotRes.status === 403;
        const hasCopilotScope        = grantedScopes.includes('copilot') || grantedScopes.includes('manage_billing');

        if (isPersonalAccountLimit) {
          return {
            success: false,
            error:   `GitHub Copilot personal API is not available for your account type (HTTP 404). ` +
                     `This is a GitHub limitation — personal Pro+ accounts cannot be read via PAT. ` +
                     `ACIL is running with manual budget config ($39.00). ` +
                     `To update your budget, use "ACIL: Set Budget Manually".`,
            scopeMissing: false,
            personalAccountLimit: true,
          };
        }
        if (isScopeProblem || !hasCopilotScope) {
          return {
            success:     false,
            scopeMissing: true,
            error:       'PAT is missing "copilot" scope. Edit your token at github.com/settings/tokens and check ✅ copilot.',
          };
        }
        return { success: false, error: `GitHub Copilot API error ${copilotRes.status}` };
      }

      const copilot = await copilotRes.json() as GitHubCopilotAPIResponse;

      // Step 3: daily usage breakdown (may also 404 on some account types)
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
   * Fetch daily usage breakdown from GitHub API for TSP seeding.
   * Returns array of daily burn records (last 30 days) if the API supports it.
   *
   * P3: Seeds the AuditTrail with historical data on day-1 install so TSP
   * has real burn rate data immediately rather than waiting 7 days.
   *
   * The GitHub API endpoint /user/copilot/billing/usage returns per-day
   * premium_requests counts if the PAT has `copilot` scope.
   * Falls back to a single synthesized record if the endpoint returns 404.
   */
  async fetchDailyHistory(): Promise<Array<{ date: string; requests: number; grossCost: number }>> {
    try {
      const res = await this._get('/user/copilot/billing/usage');
      if (!res.ok) {
        // Synthesize a single record from the consumed total if detailed data unavailable
        const copilotRes = await this._get('/user/copilot');
        if (!copilotRes.ok) return [];
        const copilot = await copilotRes.json() as GitHubCopilotAPIResponse;
        const consumed = copilot.premium_requests_consumed ?? 0;
        if (consumed === 0) return [];
        // Distribute evenly over the current billing period as a fallback seed
        const today     = new Date();
        const dayOfMonth = today.getDate();
        const dailyAvg  = consumed / Math.max(dayOfMonth, 1);
        return [{ date: today.toISOString().slice(0, 10), requests: Math.round(dailyAvg), grossCost: dailyAvg * 0.04 }];
      }

      const usage = await res.json() as GitHubCopilotUsageResponse;
      if (!usage.breakdown || !Array.isArray(usage.breakdown)) return [];

      return usage.breakdown.map(d => ({
        date:      d.day,
        requests:  d.premium_requests,
        grossCost: d.premium_requests * 0.04,
      })).filter(d => d.requests > 0);

    } catch {
      return []; // Network error — silent fallback
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

  /**
   * Diagnostic: tests each API endpoint independently and returns
   * a human-readable report. Used by acil.debugGitHubSync command.
   */
  async diagnose(pat: string): Promise<string[]> {
    const lines: string[] = ['─── ACIL GitHub PAT Diagnostic ───'];
    const headers = {
      Authorization:  `token ${pat}`,
      Accept:         'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent':   'ACIL-VSCode/0.1.0',
    };

    const check = async (label: string, path: string) => {
      try {
        const res = await fetch(`https://api.github.com${path}`, { headers });
        const scopes = res.headers.get('x-oauth-scopes') ?? '(none)';
        if (res.ok) {
          lines.push(`✅ ${label}: ${res.status} OK | scopes: ${scopes}`);
        } else {
          const body = await res.text().catch(() => '');
          lines.push(`❌ ${label}: ${res.status} ${res.statusText} | scopes: ${scopes}`);
          if (body) lines.push(`   → ${body.slice(0, 120)}`);
        }
        return { ok: res.ok, status: res.status, scopes };
      } catch (e) {
        lines.push(`💥 ${label}: network error — ${e}`);
        return { ok: false, status: 0, scopes: '' };
      }
    };

    const user   = await check('GET /user (auth verify)', '/user');
    const copilot = await check('GET /user/copilot', '/user/copilot');
    await check('GET /user/copilot/billing/usage', '/user/copilot/billing/usage');

    // Diagnosis
    lines.push('─── Diagnosis ───');
    if (!user.ok) {
      lines.push('→ PAT is invalid or expired. Regenerate at github.com/settings/tokens');
    } else if (!copilot.ok && copilot.status === 404) {
      const hasCopilotScope = user.scopes.includes('copilot') || user.scopes.includes('manage_billing');
      if (!hasCopilotScope) {
        lines.push('→ FIX: PAT is missing "copilot" scope.');
        lines.push('  1. Go to: github.com/settings/tokens');
        lines.push('  2. Edit your ACIL token → check ✅ copilot → Save');
        lines.push('  3. Run "ACIL: Connect GitHub Account" again (no need to regenerate)');
      } else {
        lines.push('→ "copilot" scope present but /user/copilot returns 404.');
        lines.push('  Your Copilot plan type may not expose this endpoint.');
        lines.push('  Run "ACIL: Set Budget Manually" to configure without API sync.');
      }
    } else if (copilot.ok) {
      lines.push('→ All endpoints accessible. Sync should work. Re-run "ACIL: Connect GitHub Account".');
    }
    return lines;
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
