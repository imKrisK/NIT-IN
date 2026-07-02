/**
 * ACIL VS Code Extension — StatusBarManager
 *
 * Manages the VS Code status bar item that shows:
 *   [ACIL] 🟢 $4.32 remaining | 18 days | DEBUGGING ~$0.02
 *          🟡 $0.80 remaining | 2 days  | ⚠️ ADVISORY
 *          🔴 THROTTLE — model downgraded
 *          ⛔ EXHAUSTED — quota depleted
 *
 * Also manages:
 *   [CCT] saved 847 tokens today
 *   TSP forecast mini-badge
 */

import * as vscode from 'vscode';
import { EnforcementState, SessionType, TemporalForecast } from '@nit-in/acil';

const STATE_ICONS: Record<EnforcementState, string> = {
  [EnforcementState.NORMAL]:    '$(circle-filled)',   // green dot
  [EnforcementState.ADVISORY]:  '$(warning)',
  [EnforcementState.WARNING]:   '$(warning)',
  [EnforcementState.THROTTLE]:  '$(circle-slash)',
  [EnforcementState.CRITICAL]:  '$(error)',
  [EnforcementState.EXHAUSTED]: '$(stop-circle)',
};

const STATE_COLORS: Partial<Record<EnforcementState, vscode.ThemeColor>> = {
  [EnforcementState.ADVISORY]:  new vscode.ThemeColor('statusBarItem.warningBackground'),
  [EnforcementState.WARNING]:   new vscode.ThemeColor('statusBarItem.warningBackground'),
  [EnforcementState.THROTTLE]:  new vscode.ThemeColor('statusBarItem.errorBackground'),
  [EnforcementState.CRITICAL]:  new vscode.ThemeColor('statusBarItem.errorBackground'),
  [EnforcementState.EXHAUSTED]: new vscode.ThemeColor('statusBarItem.errorBackground'),
};

export class StatusBarManager implements vscode.Disposable {
  private _mainItem:    vscode.StatusBarItem;
  private _cctItem:     vscode.StatusBarItem;
  private _tspItem:     vscode.StatusBarItem;

  constructor() {
    // Main credit balance + enforcement state — opens dashboard on click
    this._mainItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right, 1000
    );
    this._mainItem.command = 'acil.showDashboard';
    this._mainItem.tooltip  = 'ACIL — AI Credit Intelligence Layer\nby @imKrisK (github.com/imKrisK)\nClick to open dashboard';

    // CCT savings counter
    this._cctItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right, 999
    );
    this._cctItem.tooltip = 'ACIL: Chat-to-Completion translation savings today';

    // TSP forecast
    this._tspItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right, 998
    );
    this._tspItem.command = 'acil.showForecast';
    this._tspItem.tooltip  = 'ACIL: Click for spend forecast';
  }

  /**
   * Update all status bar items after each pipeline event.
   */
  update(opts: {
    balance:        number;
    totalBudget:    number;
    state:          EnforcementState;
    sessionType:    SessionType;
    predictedCost:  number;
    cctSavedTokens: number;
    forecast:       TemporalForecast;
    wasDowngraded:  boolean;
    effectiveModel: string;
  }): void {
    this._updateMain(opts);
    this._updateCCT(opts.cctSavedTokens);
    this._updateTSP(opts.forecast);

    this._mainItem.show();
    this._cctItem.show();
    this._tspItem.show();
  }

  hide(): void {
    this._mainItem.hide();
    this._cctItem.hide();
    this._tspItem.hide();
  }

  show(): void {
    this._mainItem.show();
    this._cctItem.show();
    this._tspItem.show();
  }

  dispose(): void {
    this._mainItem.dispose();
    this._cctItem.dispose();
    this._tspItem.dispose();
  }

  private _updateMain(opts: {
    balance:       number;
    totalBudget:   number;
    state:         EnforcementState;
    sessionType:   SessionType;
    predictedCost: number;
    wasDowngraded: boolean;
    effectiveModel: string;
  }): void {
    const icon  = STATE_ICONS[opts.state];
    const color = STATE_COLORS[opts.state];
    const pct   = opts.totalBudget > 0
      ? Math.round((opts.balance / opts.totalBudget) * 100)
      : 0;

    let text: string;

    switch (opts.state) {
      case EnforcementState.THROTTLE:
        text = `${icon} ACIL: THROTTLE → ${opts.effectiveModel}`;
        break;
      case EnforcementState.CRITICAL:
        text = `${icon} ACIL: CRITICAL $${opts.balance.toFixed(2)} (${pct}%)`;
        break;
      case EnforcementState.EXHAUSTED:
        text = `${icon} ACIL: EXHAUSTED`;
        break;
      default: {
        const sessionLabel = opts.sessionType.slice(0, 4).toUpperCase();
        const costEst = opts.predictedCost > 0
          ? ` | ${sessionLabel} ~$${opts.predictedCost.toFixed(3)}`
          : '';
        text = `${icon} ACIL $${opts.balance.toFixed(2)} (${pct}%)${costEst}`;
      }
    }

    this._mainItem.text                 = text;
    this._mainItem.backgroundColor      = color;
  }

  private _updateCCT(savedTokens: number): void {
    if (savedTokens <= 0) {
      this._cctItem.text = '$(zap) CCT 0';
      return;
    }
    this._cctItem.text = `$(zap) CCT -${savedTokens.toLocaleString()}t`;
  }

  private _updateTSP(forecast: TemporalForecast): void {
    if (!forecast.exhaustionDate) {
      this._tspItem.text = '$(clock) ∞';
      return;
    }
    const days = Math.max(0, Math.round(forecast.daysRemaining));
    const riskIcon =
      forecast.overageRiskScore >= 0.90 ? '$(error)' :
      forecast.overageRiskScore >= 0.60 ? '$(warning)' : '$(clock)';
    this._tspItem.text = `${riskIcon} ${days}d`;
    this._tspItem.backgroundColor = forecast.overageRiskScore >= 0.60
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }
}
