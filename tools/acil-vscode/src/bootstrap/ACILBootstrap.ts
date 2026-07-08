/**
 * ACIL — ACILBootstrap
 *
 * First-run setup wizard for personal accounts.
 * Runs exactly once — when no prior audit data or profile exists.
 *
 * Asks the developer two questions:
 *   1. What is your current remaining AI credit balance? (USD)
 *   2. What is your monthly budget? (defaults to $39 for Copilot Pro+)
 *
 * Seeds AuditTrail and ACILPipeline with that baseline so TSP has
 * accurate starting values from request #1.
 *
 * GitHub API sync is NOT required — from this point forward ACIL
 * tracks every request through CopilotInterceptor and is the source
 * of truth. GitHub billing dashboard is only used for periodic
 * manual reconciliation (optional).
 *
 * Author: imKrisK — Personal Version Strategy
 */

import * as vscode from 'vscode';

export interface BootstrapResult {
  completed:       boolean;
  balance:         number;   // USD
  monthlyBudget:   number;   // USD
  skipped:         boolean;  // user dismissed — use defaults
}

const BOOTSTRAP_KEY = 'acil.bootstrapCompleted';

export class ACILBootstrap {

  /** Returns true if bootstrap has already been completed. */
  static isCompleted(context: vscode.ExtensionContext): boolean {
    return context.globalState.get<boolean>(BOOTSTRAP_KEY, false);
  }

  /**
   * Run the first-run wizard if not yet completed.
   * Resolves immediately (with skipped: true) if already done.
   */
  static async run(context: vscode.ExtensionContext): Promise<BootstrapResult> {
    if (ACILBootstrap.isCompleted(context)) {
      return { completed: true, balance: 39, monthlyBudget: 39, skipped: true };
    }

    // ── Welcome message ─────────────────────────────────────────────────
    const start = await vscode.window.showInformationMessage(
      `👋 Welcome to ACIL — AI Credit Intelligence Layer.\n\n` +
      `Quick setup (2 questions, 30 seconds). ` +
      `ACIL needs your current Copilot credit balance to start tracking accurately.`,
      { modal: false },
      { title: 'Set Up Now' },
      { title: 'Use Defaults ($39)' },
    );

    if (!start || start.title === 'Use Defaults ($39)') {
      await context.globalState.update(BOOTSTRAP_KEY, true);
      return { completed: true, balance: 39, monthlyBudget: 39, skipped: true };
    }

    // ── Question 1: Monthly budget ───────────────────────────────────────
    const budgetInput = await vscode.window.showInputBox({
      title:       'ACIL Setup — Step 1 of 2',
      prompt:      'What is your monthly AI credit budget? (USD)',
      placeHolder: '39 — Copilot Pro+ · 19 — Copilot Pro · custom for team plans',
      value:       '39',
      ignoreFocusOut: true,
      validateInput: v => {
        const n = parseFloat(v);
        return isNaN(n) || n <= 0 ? 'Enter a positive number (e.g. 39)' : null;
      },
    });

    if (!budgetInput) {
      // Dismissed — use defaults silently
      await context.globalState.update(BOOTSTRAP_KEY, true);
      return { completed: true, balance: 39, monthlyBudget: 39, skipped: true };
    }

    const monthlyBudget = parseFloat(budgetInput);

    // ── Question 2: Current balance ──────────────────────────────────────
    const openBilling = { title: 'Open GitHub Billing Page' };
    await vscode.window.showInformationMessage(
      `To check your current balance: GitHub → Settings → Billing → Copilot.\n` +
      `It shows "Premium requests remaining this month."`,
      openBilling,
    );
    // Note: don't await the action — user may have already memorised it

    const balanceInput = await vscode.window.showInputBox({
      title:       'ACIL Setup — Step 2 of 2',
      prompt:      'What is your current remaining credit balance this month? (USD)',
      placeHolder: `e.g. ${monthlyBudget.toFixed(2)} if full balance, or lower if already used some`,
      value:       monthlyBudget.toFixed(2),
      ignoreFocusOut: true,
      validateInput: v => {
        const n = parseFloat(v);
        if (isNaN(n) || n < 0) return 'Enter 0 or a positive number';
        if (n > monthlyBudget * 2) return `That's more than 2× your monthly budget — double-check`;
        return null;
      },
    });

    if (!balanceInput) {
      await context.globalState.update(BOOTSTRAP_KEY, true);
      return { completed: true, balance: monthlyBudget, monthlyBudget, skipped: true };
    }

    const balance = parseFloat(balanceInput);

    // ── Mark complete ────────────────────────────────────────────────────
    await context.globalState.update(BOOTSTRAP_KEY, true);

    vscode.window.showInformationMessage(
      `✅ ACIL is calibrated. Balance: $${balance.toFixed(2)} / $${monthlyBudget.toFixed(2)}. ` +
      `CCT compression, TSP forecasting, and enforcement are now active on every request.`,
    );

    return { completed: true, balance, monthlyBudget, skipped: false };
  }

  /** Reset bootstrap state — allows re-running setup (for testing or plan change). */
  static async reset(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(BOOTSTRAP_KEY, false);
  }
}
