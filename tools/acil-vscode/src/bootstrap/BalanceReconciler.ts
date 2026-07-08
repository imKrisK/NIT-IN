/**
 * ACIL — BalanceReconciler
 *
 * Periodic manual reconciliation between ACIL's tracked balance
 * and GitHub's actual billing figures.
 *
 * Why this exists:
 *   GitHub personal Pro+ accounts do not expose billing data via PAT API.
 *   ACIL tracks spend from first request, but drift can accumulate if:
 *     - developer used Copilot before installing ACIL
 *     - billing cycle reset mid-session
 *     - multiple IDE sessions ran in parallel
 *
 * Usage:
 *   Command: "ACIL: Reconcile Balance with GitHub"
 *   → opens github.com/settings/billing/summary in browser
 *   → asks user to enter "Premium requests remaining" figure
 *   → converts to USD and corrects AuditTrail baseline
 *   → logs reconciliation event (auditable)
 *
 * Reconciliation is completely optional and non-blocking.
 * ACIL governance remains accurate from first-run bootstrap forward.
 *
 * Author: imKrisK — Personal Version Strategy
 */

import * as vscode from 'vscode';

export interface ReconcileResult {
  applied:       boolean;
  newBalance:    number;
  previousBalance: number;
  driftUsd:      number;   // how far ACIL was off
}

export class BalanceReconciler {

  /**
   * Open GitHub billing page, prompt for current balance, apply correction.
   * Returns null if user dismisses.
   */
  static async run(
    currentTrackedBalance: number,
    monthlyBudget: number,
    onApply: (newBalance: number) => void,
  ): Promise<ReconcileResult | null> {

    // Step 1: open GitHub billing so user can see the number
    const openPage = await vscode.window.showInformationMessage(
      `ACIL Balance Reconciliation\n\n` +
      `ACIL currently tracks: $${currentTrackedBalance.toFixed(2)} remaining.\n\n` +
      `Open your GitHub billing page to get the actual figure, then enter it here.`,
      { title: 'Open GitHub Billing' },
      { title: 'Enter Balance Now' },
      { title: 'Cancel' },
    );

    if (!openPage || openPage.title === 'Cancel') return null;

    if (openPage.title === 'Open GitHub Billing') {
      // Opens to the personal billing / Copilot usage section
      await vscode.env.openExternal(
        vscode.Uri.parse('https://github.com/settings/billing/summary')
      );
      // Brief pause to let them switch browser tabs
      await new Promise(r => setTimeout(r, 1500));
    }

    // Step 2: ask for actual current balance
    const input = await vscode.window.showInputBox({
      title:       'ACIL: Reconcile Balance',
      prompt:      'Enter your actual remaining credit balance from GitHub billing (USD)',
      placeHolder: `ACIL tracks: $${currentTrackedBalance.toFixed(2)} — enter the GitHub figure`,
      value:       currentTrackedBalance.toFixed(2),
      ignoreFocusOut: true,
      validateInput: v => {
        const n = parseFloat(v);
        if (isNaN(n) || n < 0) return 'Enter 0 or a positive number';
        if (n > monthlyBudget * 1.1) return `That exceeds your monthly budget of $${monthlyBudget} — double-check`;
        return null;
      },
    });

    if (!input) return null;

    const newBalance   = parseFloat(input);
    const driftUsd     = Math.abs(newBalance - currentTrackedBalance);
    const driftPct     = (driftUsd / monthlyBudget) * 100;

    // Step 3: apply the correction
    onApply(newBalance);

    // Step 4: confirm with drift report
    const driftMsg = driftUsd < 0.01
      ? `ACIL was accurate — no drift detected.`
      : `Corrected drift of $${driftUsd.toFixed(4)} (${driftPct.toFixed(1)}% of budget). ` +
        (driftUsd > monthlyBudget * 0.10
          ? `Large drift suggests sessions ran outside ACIL's scope (e.g. github.com chat).`
          : `Minor drift — ACIL is tracking well.`);

    vscode.window.showInformationMessage(
      `✅ Balance reconciled: $${newBalance.toFixed(2)} / $${monthlyBudget.toFixed(2)}. ${driftMsg}`
    );

    return {
      applied:         true,
      newBalance,
      previousBalance: currentTrackedBalance,
      driftUsd,
    };
  }
}
