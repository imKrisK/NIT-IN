/**
 * ACIL VS Code Extension — Main Entry Point
 *
 * Activates the AI Credit Intelligence Layer inside VS Code.
 * Wires together all ACIL components through the ACILPipeline
 * and registers VS Code commands, status bar, and telemetry hooks.
 *
 * Activation: onStartupFinished — loads with every VS Code session.
 *
 * Architecture:
 *   TelemetryCollector  → signals  → ACILPipeline.preflight()
 *   ACILPipeline        → decision → API call (by Copilot/user)
 *   API response        → tokens   → ACILPipeline.postflight()
 *   postflight result   → display  → StatusBarManager + NotificationManager
 *
 * NOTE: ACIL intercepts telemetry signals and provides pre-flight guidance,
 * but does NOT proxy or intercept the actual API call payload. The developer
 * decides whether to accept ACIL's model/compression recommendations.
 * ACIL is an advisory + enforcement layer, not a transparent proxy (Phase 7 v1).
 * Phase 8 will introduce full transparent proxy mode.
 */

import * as vscode from 'vscode';
import {
  ACILPipeline,
  BudgetPeriod,
  EnforcementState,
  ModelId,
  SessionType,
  QualityRequirement,
} from '@nit-in/acil';
import { StatusBarManager }    from './StatusBarManager';
import { TelemetryCollector }  from './TelemetryCollector';
import { NotificationManager } from './NotificationManager';
import { SecretManager }       from './sync/SecretManager';
import { GitHubCreditSync }    from './sync/GitHubCreditSync';
import { DashboardPanel }      from './dashboard/DashboardPanel';

// ─── Extension state ─────────────────────────────────────────────────────────

let pipeline:        ACILPipeline | undefined;
let statusBar:       StatusBarManager | undefined;
let telemetry:       TelemetryCollector | undefined;
let notifications:   NotificationManager | undefined;
let secrets:         SecretManager | undefined;
let _extensionUri:   vscode.Uri | undefined;
let cctSavedTodal  = 0;
let _syncTimer:      ReturnType<typeof setInterval> | undefined;

// ─── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  _extensionUri = context.extensionUri;
  const config  = vscode.workspace.getConfiguration('acil');

  // Initialize pipeline with user's budget config
  const period = buildBudgetPeriod(config);
  pipeline      = new ACILPipeline(period, config.get<number>('overageCostPerUnit', 0.04));
  statusBar     = new StatusBarManager();
  telemetry     = new TelemetryCollector();
  notifications = new NotificationManager();

  // Initialize SecretManager with VS Code's keychain-backed storage
  secrets = new SecretManager(context.secrets);

  // Initial status bar render
  refreshStatusBar();

  // Sync GitHub credit balance on startup (non-blocking)
  syncGitHubBalance();

  // Re-sync every 30 minutes while VS Code is open
  _syncTimer = setInterval(() => syncGitHubBalance(), 30 * 60 * 1000);
  context.subscriptions.push({ dispose: () => { if (_syncTimer) clearInterval(_syncTimer); } });

  // ── Register Commands ──────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('acil.showStatus', () => showStatusPanel()),
    vscode.commands.registerCommand('acil.showForecast', () => showForecastPanel()),
    vscode.commands.registerCommand('acil.showSessionHistory', () => showHistoryPanel()),
    vscode.commands.registerCommand('acil.setMonthlyBudget', () => setMonthlyBudget()),
    vscode.commands.registerCommand('acil.connectGitHub', () => connectGitHub()),
    vscode.commands.registerCommand('acil.syncNow', () => syncGitHubBalance(true)),
    vscode.commands.registerCommand('acil.disconnectGitHub', () => disconnectGitHub()),
    vscode.commands.registerCommand('acil.showDashboard', () => {
      if (pipeline && _extensionUri) DashboardPanel.show(_extensionUri, pipeline);
    }),
  );

  // ── Manual pre-flight command (invoked before running an AI agent task) ───
  context.subscriptions.push(
    vscode.commands.registerCommand('acil.runPreflight', async () => {
      await runManualPreflight();
    })
  );

  // ── Config change listener ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('acil')) {
        const cfg = vscode.workspace.getConfiguration('acil');
        pipeline = new ACILPipeline(buildBudgetPeriod(cfg), cfg.get<number>('overageCostPerUnit', 0.04));
        cctSavedTodal = 0;
        refreshStatusBar();
      }
    })
  );

  // ── Telemetry listener: refresh status bar on document changes ─────────────
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => refreshStatusBar())
  );

  // Register disposables
  context.subscriptions.push(statusBar, telemetry);

  vscode.window.showInformationMessage('ACIL activated — AI credit intelligence layer running.');
}

export function deactivate(): void {
  if (_syncTimer) clearInterval(_syncTimer);
  statusBar?.dispose();
  telemetry?.dispose();
}

// ─── GitHub Sync ──────────────────────────────────────────────────────────────

/**
 * Prompt the developer to connect their GitHub account via PAT.
 * Called by 'acil.connectGitHub' command.
 */
async function connectGitHub(): Promise<void> {
  if (!secrets) return;

  const token = await secrets.promptAndStore();
  if (!token) return;

  await syncGitHubBalance(true);
}

/**
 * Sync live GitHub Copilot balance into the pipeline.
 * Silent on success; shows error only on explicit sync (showNotification=true).
 */
async function syncGitHubBalance(showNotification = false): Promise<void> {
  if (!pipeline || !secrets) return;

  const pat = await secrets.getPAT();
  if (!pat) {
    if (showNotification) {
      const connect = { title: 'Connect GitHub' };
      const action = await vscode.window.showWarningMessage(
        'ACIL: No GitHub token stored. Connect your account to sync live credit balance.',
        connect,
      );
      if (action === connect) await connectGitHub();
    }
    return;
  }

  const sync   = new GitHubCreditSync(pat);
  const result = await sync.fetchBillingData();

  if (!result.success || !result.data) {
    if (showNotification) {
      vscode.window.showErrorMessage(`ACIL GitHub Sync: ${result.error}`);
    }
    return;
  }

  const data = result.data;

  // Rebuild pipeline with live budget period from GitHub
  const livePeriod    = sync.toBudgetPeriod(data);
  const config        = vscode.workspace.getConfiguration('acil');
  const overageRate   = config.get<number>('overageCostPerUnit', 0.04);

  pipeline = new ACILPipeline(livePeriod, overageRate);
  refreshStatusBar();

  if (showNotification) {
    vscode.window.showInformationMessage(
      `ACIL synced: ${data.premiumRequestsRemaining.toLocaleString()} premium requests remaining` +
      ` ($${livePeriod.remaining.toFixed(2)}) — plan: ${data.planType}`,
    );
  }
}

/**
 * Remove stored PAT and revert to manual config.
 */
async function disconnectGitHub(): Promise<void> {
  if (!secrets) return;
  await secrets.deletePAT();
  vscode.window.showInformationMessage('ACIL: GitHub account disconnected. Using manual budget config.');
}

// ─── Core: Manual Pre-flight ──────────────────────────────────────────────────

async function runManualPreflight(): Promise<void> {
  if (!pipeline || !telemetry || !notifications) return;

  const config      = vscode.workspace.getConfiguration('acil');
  const enableCCT   = config.get<boolean>('enableCCT', true);
  const preferredId = (config.get<string>('preferredModel', 'copilot-premium') as ModelId);

  // Prompt developer for their intended query
  const queryText = await vscode.window.showInputBox({
    placeHolder:  'Describe your AI request (for pre-flight cost estimate)...',
    prompt:       'ACIL Pre-flight: What are you about to ask the AI?',
  });
  if (!queryText) return;

  const signals  = telemetry.collect(queryText);
  const preflight = pipeline.preflight({
    rawInput:           queryText,
    telemetry:          signals,
    preferredModelId:   preferredId,
    qualityRequirement: QualityRequirement.STANDARD,
    contextSizeTokens:  estimateCurrentContext(),
    agenticDepth:       signals.toolCallSignatures.length > 0 ? 3 : 0,
    userId:             getUserId(config),
  });

  if (!preflight.allowed) {
    notifications.notifyEnforcement(
      preflight.enforcement.state,
      preflight.enforcement.message,
      preflight.forecast,
    );
    return;
  }

  // Agentic gate
  if (preflight.sessionType === SessionType.AGENTIC) {
    const confirmed = await notifications.confirmAgenticSession(
      preflight.prediction.expectedCost,
      preflight.prediction.expectedTokens,
      pipeline.balance,
      preflight.sessionType,
    );
    if (!confirmed) return;
  }

  // Show result
  const cctNote = enableCCT && preflight.cctApplied
    ? `\nCCT: compressed input (saved ${Math.round(preflight.cctSavingsPct * 100)}% tokens)`
    : '';

  const modelNote = preflight.enforcement.wasDowngraded
    ? `\nModel: ${preflight.effectiveModelId} (downgraded from ${preferredId})`
    : `\nModel: ${preflight.effectiveModelId}`;

  vscode.window.showInformationMessage(
    `ACIL Pre-flight: ${preflight.sessionType} session\n` +
    `Predicted: ~$${preflight.prediction.expectedCost.toFixed(3)} / ~${preflight.prediction.expectedTokens.toLocaleString()} tokens` +
    `${modelNote}${cctNote}`,
  );

  refreshStatusBar();
}

// ─── Panel views ──────────────────────────────────────────────────────────────

function showStatusPanel(): void {
  if (!pipeline) return;
  const f        = pipeline.forecast();
  const state    = pipeline.currentState;
  const balance  = pipeline.balance;
  const config   = vscode.workspace.getConfiguration('acil');
  const budget   = config.get<number>('monthlyBudget', 39.0);
  const pct      = budget > 0 ? Math.round((balance / budget) * 100) : 0;

  const lines = [
    `ACIL Credit Status`,
    `──────────────────`,
    `Balance:   $${balance.toFixed(2)} (${pct}% remaining)`,
    `State:     ${state}`,
    `Forecast:  ${f.exhaustionDate ? f.exhaustionDate.toLocaleDateString() : 'Survives to reset'}`,
    `Risk:      ${(f.overageRiskScore * 100).toFixed(0)}% overage probability`,
    f.overageCostEstimate > 0 ? `Est. overage: $${f.overageCostEstimate.toFixed(2)}` : '',
    `CCT saved: ${cctSavedTodal.toLocaleString()} tokens today`,
    ``,
    f.recommendedActions[0] ?? '',
  ].filter(Boolean).join('\n');

  vscode.window.showInformationMessage(lines, { modal: true }, { title: 'OK' });
}

function showForecastPanel(): void {
  if (!pipeline) return;
  const f = pipeline.forecast();
  const lines = [
    `ACIL Temporal Spend Forecast`,
    `────────────────────────────`,
    `Exhaustion date: ${f.exhaustionDate ? f.exhaustionDate.toLocaleDateString() : 'None — survives to reset'}`,
    `Days remaining:  ${f.daysRemaining.toFixed(1)}`,
    `Overage risk:    ${(f.overageRiskScore * 100).toFixed(0)}%`,
    `Est. overage:    $${f.overageCostEstimate.toFixed(2)}`,
    ``,
    `Recommended actions:`,
    ...f.recommendedActions.map(a => `• ${a}`),
  ].join('\n');

  vscode.window.showInformationMessage(lines, { modal: true }, { title: 'OK' });
}

function showHistoryPanel(): void {
  if (!pipeline) return;
  const summary = pipeline.audit.summarize();
  const lines = [
    `ACIL Session History`,
    `────────────────────`,
    `Total sessions:  ${summary.totalEvents}`,
    `Total tokens:    ${summary.totalTokens.toLocaleString()}`,
    `Gross cost:      $${summary.totalGross.toFixed(4)}`,
    `Net cost:        $${summary.totalNet.toFixed(4)}`,
    `Included savings:$${summary.totalDiscount.toFixed(4)}`,
    `CCT saved:       ${summary.cctSavingsTokens.toLocaleString()} tokens`,
    ``,
    `By session type:`,
    ...Object.entries(summary.bySessionType).map(([t, n]) => `  ${t}: ${n}`),
  ].join('\n');

  vscode.window.showInformationMessage(lines, { modal: true }, { title: 'OK' });
}

async function setMonthlyBudget(): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt:      'Set your monthly AI credit budget (USD)',
    placeHolder: '39.00',
    validateInput: v => isNaN(parseFloat(v)) ? 'Enter a number' : null,
  });
  if (!input) return;
  const config = vscode.workspace.getConfiguration('acil');
  await config.update('monthlyBudget', parseFloat(input), vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`ACIL: Monthly budget set to $${input}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function refreshStatusBar(): void {
  if (!pipeline || !statusBar) return;
  const f = pipeline.forecast();
  statusBar.update({
    balance:        pipeline.balance,
    totalBudget:    vscode.workspace.getConfiguration('acil').get<number>('monthlyBudget', 39.0),
    state:          pipeline.currentState,
    sessionType:    SessionType.UNKNOWN,
    predictedCost:  0,
    cctSavedTokens: cctSavedTodal,
    forecast:       f,
    wasDowngraded:  false,
    effectiveModel: vscode.workspace.getConfiguration('acil').get<string>('preferredModel', 'copilot-premium'),
  });
}

function buildBudgetPeriod(config: vscode.WorkspaceConfiguration): BudgetPeriod {
  const budget = config.get<number>('monthlyBudget', 39.0);
  const now    = new Date();
  const reset  = new Date(now.getFullYear(), now.getMonth() + 1, 1); // 1st of next month
  return {
    periodId:         'current-billing-period',
    userId:           getUserId(config),
    startDate:        new Date(now.getFullYear(), now.getMonth(), 1),
    resetDate:        reset,
    totalAllocation:  budget,
    consumed:         0,  // Will sync from GitHub API in Phase 8
    remaining:        budget,
    enforcementState: EnforcementState.NORMAL,
  };
}

function getUserId(config: vscode.WorkspaceConfiguration): string {
  return config.get<string>('userId', '') || 'developer';
}

function estimateCurrentContext(): number {
  // Rough estimate: count characters in open documents / 4 (chars per token)
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) return 0;
  return Math.min(200_000, Math.floor(activeEditor.document.getText().length / 4));
}
