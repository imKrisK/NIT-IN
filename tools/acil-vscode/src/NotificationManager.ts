/**
 * ACIL VS Code Extension — NotificationManager
 *
 * Displays graduated enforcement notifications matching the RTCE state machine.
 * Each enforcement state triggers a distinct VS Code notification pattern.
 *
 * NORMAL    → silent (no notification)
 * ADVISORY  → information message (dismissible, non-blocking)
 * WARNING   → warning message with session type suggestion
 * THROTTLE  → warning message (model was transparently downgraded)
 * CRITICAL  → error message (agentic sessions blocked)
 * EXHAUSTED → error message + calendar note
 *
 * Pre-flight agentic gate:
 *   When an AGENTIC session is detected and predicted cost is high,
 *   shows a modal confirmation: "This session will cost ~$X. Proceed?"
 */

import * as vscode from 'vscode';
import { EnforcementState, SessionType, TemporalForecast } from '@nit-in/acil';

export class NotificationManager {
  private _lastNotifiedState: EnforcementState = EnforcementState.NORMAL;
  private _lastNotifyTime:    number = 0;
  private _notifyIntervalMs = 5 * 60 * 1000; // max once per 5 min per state

  /**
   * Show enforcement state notification (rate-limited to avoid spam).
   */
  notifyEnforcement(
    state:    EnforcementState,
    message:  string | null,
    forecast: TemporalForecast,
  ): void {
    const now      = Date.now();
    const stateChanged = state !== this._lastNotifiedState;
    const throttled    = now - this._lastNotifyTime < this._notifyIntervalMs;

    if (!stateChanged && throttled) return;
    if (!message || state === EnforcementState.NORMAL) return;

    this._lastNotifiedState = state;
    this._lastNotifyTime    = now;

    const budgetAction = { title: 'Set Budget' };
    const forecastAction = { title: 'See Forecast' };
    const dismissAction  = { title: 'Dismiss' };

    switch (state) {
      case EnforcementState.ADVISORY:
        vscode.window.showInformationMessage(
          `ACIL: ${message}`,
          dismissAction,
        );
        break;

      case EnforcementState.WARNING:
        vscode.window.showWarningMessage(
          `ACIL ⚠️: ${message}`,
          forecastAction,
          dismissAction,
        ).then(action => {
          if (action === forecastAction) vscode.commands.executeCommand('acil.showForecast');
        });
        break;

      case EnforcementState.THROTTLE:
        vscode.window.showWarningMessage(
          `ACIL 🔄: ${message}`,
          dismissAction,
        );
        break;

      case EnforcementState.CRITICAL:
        vscode.window.showErrorMessage(
          `ACIL 🔴: ${message}`,
          forecastAction,
          budgetAction,
        ).then(action => {
          if (action === forecastAction) vscode.commands.executeCommand('acil.showForecast');
          if (action === budgetAction)   vscode.commands.executeCommand('acil.setMonthlyBudget');
        });
        break;

      case EnforcementState.EXHAUSTED: {
        const resetDate = forecast.exhaustionDate
          ? `Resets: check billing dashboard.`
          : 'Credit quota depleted.';
        vscode.window.showErrorMessage(
          `ACIL ⛔: Quota exhausted. ${resetDate} Upgrade or wait for reset.`,
          { modal: false },
          budgetAction,
        ).then(action => {
          if (action === budgetAction) vscode.commands.executeCommand('acil.setMonthlyBudget');
        });
        break;
      }
    }
  }

  /**
   * Pre-flight modal for AGENTIC sessions with high predicted cost.
   * Wave 10: "pre-execution burn rate predictor... before any API call is transmitted"
   *
   * Returns true if developer confirms, false if they cancel.
   */
  async confirmAgenticSession(
    predictedCost: number,
    predictedTokens: number,
    balance: number,
    sessionType: SessionType,
  ): Promise<boolean> {
    if (predictedCost < 0.10) return true; // Don't gate cheap sessions
    if (sessionType !== SessionType.AGENTIC) return true;

    const pct = balance > 0
      ? Math.round((predictedCost / balance) * 100)
      : 100;

    const msg = `ACIL Pre-flight: This agentic session is predicted to cost ~$${predictedCost.toFixed(2)} (~${predictedTokens.toLocaleString()} tokens), consuming ${pct}% of your remaining budget ($${balance.toFixed(2)}).`;

    const proceed = await vscode.window.showWarningMessage(
      msg,
      { modal: true },
      { title: 'Proceed', isCloseAffordance: false },
      { title: 'Cancel', isCloseAffordance: true },
    );

    return proceed?.title === 'Proceed';
  }

  /**
   * Show CCT savings toast (once per session, non-blocking).
   */
  notifyCCTSavings(savedTokens: number, savingsPct: number): void {
    if (savedTokens < 50) return; // Skip trivial savings
    vscode.window.showInformationMessage(
      `ACIL CCT: Compressed prompt — saved ${savedTokens} tokens (${Math.round(savingsPct * 100)}% reduction).`
    );
  }
}
