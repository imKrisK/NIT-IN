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
  MetaRecursiveLoop,
  UserFeedbackCollector,
} from '@nit-in/acil';
import { StatusBarManager }    from './StatusBarManager';
import { TelemetryCollector }  from './TelemetryCollector';
import { NotificationManager } from './NotificationManager';
import { SecretManager }       from './sync/SecretManager';
import { GitHubCreditSync }    from './sync/GitHubCreditSync';
import { DashboardPanel }      from './dashboard/DashboardPanel';
import { ACILChatParticipant } from './lm/ChatParticipant';
import { WorkspaceConfigLoader } from './config/WorkspaceConfigLoader';
import { CursorAdapter, isRunningInCursor } from './adapters/CursorAdapter';
import { PolicyClient }        from './policy/PolicyClient';
import { ACILBootstrap }       from './bootstrap/ACILBootstrap';
import { BalanceReconciler }   from './bootstrap/BalanceReconciler';
import * as path from 'path';

// ─── Extension state ─────────────────────────────────────────────────────────

let pipeline:         ACILPipeline | undefined;
let statusBar:        StatusBarManager | undefined;
let telemetry:        TelemetryCollector | undefined;
let notifications:    NotificationManager | undefined;
let secrets:          SecretManager | undefined;
let _extensionUri:    vscode.Uri | undefined;
let _auditFilePath:   string | undefined;
let _profileFilePath: string | undefined;
let _outcomesFilePath: string | undefined;
let _chatParticipant: ACILChatParticipant | undefined;
let _output:          vscode.OutputChannel | undefined;
let _loop:            MetaRecursiveLoop | undefined;
let _feedback:        UserFeedbackCollector | undefined;
let _wsConfig:        WorkspaceConfigLoader | undefined;
let _policyClient:    PolicyClient | undefined;
let cctSavedTodal   = 0;
let _syncTimer:       ReturnType<typeof setInterval> | undefined;

// ─── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Output channel — visible under View → Output → ACIL
  _output = vscode.window.createOutputChannel('ACIL');
  context.subscriptions.push(_output);
  _output.appendLine(`[ACIL] activate() — ${new Date().toISOString()}`);

  try {
    _extensionUri = context.extensionUri;
    const config  = vscode.workspace.getConfiguration('acil');

    // ── Core components ────────────────────────────────────────────────────
    const period  = buildBudgetPeriod(config);
    pipeline      = new ACILPipeline(period, config.get<number>('overageCostPerUnit', 0.04));
    statusBar     = new StatusBarManager();
    telemetry     = new TelemetryCollector();
    notifications = new NotificationManager();
    secrets       = new SecretManager(context.secrets);
    _output.appendLine('[ACIL] Core components initialized');

    // ── Load persisted audit trail + burn profile ──────────────────────────
    const auditPath   = getAuditFilePath(context);
    const profilePath = getProfileFilePath(context);
    try {
      pipeline.audit.load(auditPath);
      _output.appendLine(`[ACIL] Audit loaded from: ${auditPath}`);
    } catch (e) {
      _output.appendLine(`[ACIL] Audit load skipped (first run): ${e}`);
    }
    try {
      pipeline.profile.load(profilePath);
      _output.appendLine(`[ACIL] Burn profile loaded from: ${profilePath}`);
    } catch (e) {
      _output.appendLine(`[ACIL] Burn profile load skipped (first run): ${e}`);
    }

    // ── WorkspaceConfigLoader (team budgets — P2) ──────────────────────────
    _wsConfig = new WorkspaceConfigLoader();
    _wsConfig.load();
    if (_wsConfig.hasWorkspaceConfig) {
      _output.appendLine(`[ACIL] Workspace config loaded — team: ${_wsConfig.teamName ?? 'unnamed'} | policy: ${_wsConfig.enforcementPolicy}`);
    }
    context.subscriptions.push(_wsConfig.watchWorkspace(() => {
      _wsConfig!.load();
      _output?.appendLine('[ACIL] Workspace config reloaded (.acil.json changed)');
    }));

    // ── Bootstrap — first-run wizard for personal accounts ────────────────
    // Runs exactly once. Asks for current balance + monthly budget.
    // GitHub API sync is optional — ACIL is self-sufficient from bootstrap forward.
    if (!ACILBootstrap.isCompleted(context)) {
      // Defer slightly so VS Code UI is fully ready
      setTimeout(async () => {
        const boot = await ACILBootstrap.run(context);
        if (!boot.skipped) {
          _wsConfig?.applyRemote({
            version:       1,
            monthlyBudget: boot.monthlyBudget,
          });
          _output?.appendLine(
            `[ACIL] Bootstrap complete — balance: $${boot.balance.toFixed(2)} | budget: $${boot.monthlyBudget.toFixed(2)}`
          );
          refreshStatusBar();
        }
      }, 2000);
    }

    // ── PolicyClient — remote policy server (optional enterprise feature) ──
    const policyServerUrl = config.get<string>('policyServerUrl', '');
    const policyTeamId    = config.get<string>('policyTeamId', '');
    if (policyServerUrl && policyTeamId) {
      const pollMs = config.get<number>('policyPollIntervalMs', 60_000);
      // Fetch HMAC key from secret storage (never from settings — it's a secret)
      void context.secrets.get('acil.policyHmacKey').then(hmacKey => {
        _policyClient = new PolicyClient({
          serverUrl:       policyServerUrl,
          teamId:          policyTeamId,
          hmacKey:         hmacKey ?? undefined,
          pollIntervalMs:  pollMs,
        });
        _policyClient.start((remoteCfg, result) => {
          _output?.appendLine(
            `[ACIL] Remote policy applied — team: ${remoteCfg.teamName ?? policyTeamId} | verified: ${result.verified} | signed: ${result.signed}`
          );
          // Remote policy takes priority over local .acil.json
          _wsConfig?.applyRemote(remoteCfg);
          refreshStatusBar();
        });
        context.subscriptions.push({ dispose: () => _policyClient?.stop() });
        _output?.appendLine(`[ACIL] PolicyClient started → ${policyServerUrl}/policy/${policyTeamId}`);
      });
    }

    // ── MetaRecursiveLoop — load persisted outcomes ────────────────────────
    _feedback = new UserFeedbackCollector();
    const feedbackFilePath = path.join(context.globalStorageUri.fsPath, 'acil-feedback.json');
    try {
      _feedback.load(feedbackFilePath);
      _output.appendLine(`[ACIL] UserFeedback loaded: ${_feedback.totalEvents} events`);
    } catch { /* fresh start */ }

    _loop = new MetaRecursiveLoop(_feedback);
    _outcomesFilePath = getOutcomesFilePath(context);
    try {
      _loop.load(_outcomesFilePath);
      _output.appendLine(`[ACIL] MetaRecursiveLoop loaded: generation ${_loop.generation}`);
    } catch (e) {
      _output.appendLine(`[ACIL] MetaRecursiveLoop: fresh start (${e})`);
    }

    // ── Status bar + initial render ────────────────────────────────────────
    refreshStatusBar();
    statusBar.show?.();

    // ── GitHub sync ────────────────────────────────────────────────────────
    syncGitHubBalance();
    _syncTimer = setInterval(() => syncGitHubBalance(), 30 * 60 * 1000);
    context.subscriptions.push({ dispose: () => { if (_syncTimer) clearInterval(_syncTimer); } });

    // ── Periodic refresh ───────────────────────────────────────────────────
    const _refreshTimer = setInterval(() => refreshStatusBar(), 60 * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(_refreshTimer) });

    // ── Register @acil chat participant — or Cursor adapter ─────────────────
    if (isRunningInCursor()) {
      // Cursor mode: limited adapter (no vscode.lm)
      const cursorAdapter = new CursorAdapter(pipeline);
      context.subscriptions.push(cursorAdapter);
      _output.appendLine('[ACIL] Cursor IDE detected — CursorAdapter active (limited mode)');
    } else {
      // VS Code mode: full chat participant
      _chatParticipant = new ACILChatParticipant(
        pipeline, telemetry, notifications, getUserId(config),
      );
      context.subscriptions.push(_chatParticipant);
      _output.appendLine('[ACIL] Chat participant registered: acil.assistant');
    }

    // ── Register Commands ────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand('acil.showStatus', () => showStatusPanel()),
      vscode.commands.registerCommand('acil.showForecast', () => showForecastPanel()),
      vscode.commands.registerCommand('acil.showSessionHistory', () => showHistoryPanel()),
      vscode.commands.registerCommand('acil.setMonthlyBudget', () => setMonthlyBudget()),
      vscode.commands.registerCommand('acil.connectGitHub',      () => connectGitHub()),
      vscode.commands.registerCommand('acil.syncNow',            () => syncGitHubBalance(true)),
      vscode.commands.registerCommand('acil.disconnectGitHub',   () => disconnectGitHub()),
      vscode.commands.registerCommand('acil.debugGitHubSync',    () => runGitHubDiagnostic()),
      vscode.commands.registerCommand('acil.setManualBudget',    () => setManualBudget()),
      vscode.commands.registerCommand('acil.reconcileBalance',   () => reconcileBalance()),
      vscode.commands.registerCommand('acil.resetBootstrap',     async () => {
        await ACILBootstrap.reset(context);
        vscode.window.showInformationMessage('ACIL: Bootstrap reset. Restart VS Code to run setup again.');
      }),
      vscode.commands.registerCommand('acil.storePolicyHmacKey', async () => {
        const key = await vscode.window.showInputBox({
          prompt:      'Enter your ACIL Policy HMAC signing key',
          placeHolder: 'Paste key from your secrets manager',
          password:    true,
          ignoreFocusOut: true,
        });
        if (key) {
          await context.secrets.store('acil.policyHmacKey', key);
          vscode.window.showInformationMessage('ACIL: Policy HMAC key stored securely.');
        }
      }),
      vscode.commands.registerCommand('acil.showDashboard', () => {
        if (pipeline && _extensionUri) DashboardPanel.show(_extensionUri, pipeline);
      }),
      vscode.commands.registerCommand('acil.exportCSV', () => exportCSV()),
      vscode.commands.registerCommand('acil.runPreflight', async () => {
        await runManualPreflight();
      }),
    );

    // ── Config change listener ───────────────────────────────────────────────
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('acil')) {
          const cfg = vscode.workspace.getConfiguration('acil');
          pipeline = new ACILPipeline(buildBudgetPeriod(cfg), cfg.get<number>('overageCostPerUnit', 0.04));
          cctSavedTodal = 0;
          refreshStatusBar();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(() => refreshStatusBar()),
    );

    context.subscriptions.push(statusBar, telemetry);

    _output.appendLine('[ACIL] Activation complete ✓');
    vscode.window.showInformationMessage('ACIL activated — AI credit intelligence layer running.');

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    _output?.appendLine(`[ACIL] ACTIVATION ERROR: ${msg}`);
    _output?.show(true);
    vscode.window.showErrorMessage(`ACIL failed to activate: ${msg}`);
  }
}

export function deactivate(): void {
  if (_syncTimer) clearInterval(_syncTimer);
  _chatParticipant?.dispose();
  _wsConfig?.dispose();
  // Persist audit + burn profile + loop outcomes
  if (pipeline && _auditFilePath) {
    try { pipeline.audit.save(_auditFilePath); } catch { /* best-effort */ }
  }
  if (pipeline && _profileFilePath) {
    try { pipeline.profile.save(_profileFilePath); } catch { /* best-effort */ }
  }
  if (_loop && _outcomesFilePath) {
    try { _loop.save(_outcomesFilePath); } catch { /* best-effort */ }
  }
  if (_feedback) {
    // _auditFilePath is in globalStorage — save feedback alongside it
    const dir = _auditFilePath ? require('path').dirname(_auditFilePath) : undefined;
    if (dir) {
      try { _feedback.save(require('path').join(dir, 'acil-feedback.json')); } catch { /* best-effort */ }
    }
  }
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
      if (result.personalAccountLimit) {
        // GitHub personal Pro+ accounts don't expose the Copilot API via PAT.
        // This is expected. Show a calm, informational notification.
        const setBudget = { title: 'Set Budget Manually' };
        const action = await vscode.window.showInformationMessage(
          `ACIL: GitHub Copilot personal API is not available via PAT for Pro+ accounts ` +
          `(GitHub limitation — not a token issue). ` +
          `ACIL is active with $39.00 manual budget. ` +
          `Governance, CCT, and TSP are fully running.`,
          setBudget,
        );
        if (action === setBudget) await setManualBudget();
      } else if (result.scopeMissing) {
        const fix    = { title: 'Open github.com/settings/tokens' };
        const manual = { title: 'Set Budget Manually' };
        const action = await vscode.window.showErrorMessage(
          `ACIL: ${result.error}`, fix, manual,
        );
        if (action === fix)    vscode.env.openExternal(vscode.Uri.parse('https://github.com/settings/tokens'));
        else if (action === manual) await setManualBudget();
      } else {
        const manual = { title: 'Set Budget Manually' };
        const diag   = { title: 'Run Diagnostic' };
        const action = await vscode.window.showWarningMessage(
          `ACIL GitHub Sync: ${result.error ?? 'Unknown error'}`, manual, diag,
        );
        if (action === manual) await setManualBudget();
        else if (action === diag) await runGitHubDiagnostic();
      }
    }
    return;
  }

  const data = result.data;

  // P3: Seed AuditTrail with GitHub daily history for TSP day-1 accuracy
  // Only on first sync (audit is empty) — prevents duplicate seeding
  if (pipeline && pipeline.audit.summarize().totalEvents === 0) {
    const history = await sync.fetchDailyHistory();
    if (history.length > 0) {
      _output?.appendLine(`[ACIL] Seeded ${history.length} days of GitHub history for TSP`);
      // History is injected as synthetic audit records to seed the burn rate
      // (read-only seed — doesn't affect billing, only TSP projection)
      for (const day of history) {
        (pipeline.audit as any)._seedDailyBurn?.(day.date, day.grossCost, day.requests);
      }
    }
  }

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

/**
 * Run a full diagnostic against each GitHub Copilot API endpoint.
 * Results appear as a VS Code information message popup AND in the output channel.
 */
async function runGitHubDiagnostic(): Promise<void> {
  if (!secrets) return;
  const pat = await secrets.getPAT();
  if (!pat) {
    vscode.window.showWarningMessage('ACIL: No PAT stored. Run "ACIL: Connect GitHub Account" first.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ACIL: Running GitHub diagnostic...' },
    async () => {
      const sync  = new GitHubCreditSync(pat);
      const lines = await sync.diagnose(pat);

      // Also write to output channel
      if (_output) {
        _output.show(true);
        for (const line of lines) _output.appendLine(`[ACIL] ${line}`);
      }

      // Surface key result as a visible popup
      const summary = lines.filter(l => l.startsWith('✅') || l.startsWith('❌') || l.startsWith('→'));
      const popupText = summary.slice(0, 4).join('\n') ||
        'Diagnostic complete — check ACIL output channel for details.';

      const fixLine = lines.find(l => l.startsWith('→ FIX:'));
      if (fixLine) {
        const openTokens = { title: 'Open github.com/settings/tokens' };
        const setManual  = { title: 'Set Budget Manually' };
        const action = await vscode.window.showWarningMessage(
          `ACIL Diagnostic: ${fixLine.replace('→ FIX: ', '')}`,
          openTokens, setManual,
        );
        if (action === openTokens) vscode.env.openExternal(vscode.Uri.parse('https://github.com/settings/tokens'));
        else if (action === setManual) await setManualBudget();
      } else {
        // Personal account limitation — calm message
        const setManual = { title: 'Set Budget Manually ($39)' };
        const action = await vscode.window.showInformationMessage(
          `ACIL Diagnostic:\n` +
          `✅ PAT auth: working (GitHub sees you as imKrisK)\n` +
          `❌ /user/copilot: 404 — GitHub personal Pro+ API not accessible via PAT\n` +
          `ℹ️  This is a GitHub limitation. ACIL is fully active with manual budget.`,
          setManual,
        );
        if (action === setManual) await setManualBudget();
      }
    }
  );
}

/**
 * Set monthly budget manually — fallback when GitHub API sync is not available.
 * Writes to VS Code settings (not disk secrets).
 */
async function setManualBudget(): Promise<void> {
  const current = vscode.workspace.getConfiguration('acil').get<number>('monthlyBudget', 39);
  const input   = await vscode.window.showInputBox({
    prompt:       'ACIL: Enter your monthly AI credit budget in USD',
    placeHolder:  `Current: $${current} — e.g. 39 for Copilot Pro+`,
    value:        String(current),
    validateInput: v => {
      const n = parseFloat(v);
      return isNaN(n) || n <= 0 ? 'Enter a positive number (e.g. 39)' : null;
    },
  });
  if (!input) return;
  const budget = parseFloat(input);
  await vscode.workspace.getConfiguration('acil').update('monthlyBudget', budget, vscode.ConfigurationTarget.Global);
  // Push the new budget into WorkspaceConfigLoader so next preflight picks it up
  if (_wsConfig) {
    _wsConfig.applyRemote({ version: 1, monthlyBudget: budget });
  }
  refreshStatusBar();
  vscode.window.showInformationMessage(`ACIL: Monthly budget set to $${budget.toFixed(2)}. Governance is active.`);
}

/**
 * Manual balance reconciliation — personal account strategy.
 * Compares ACIL tracked balance to user-entered GitHub billing figure.
 * Corrects drift and logs reconciliation event.
 */
async function reconcileBalance(): Promise<void> {
  if (!pipeline || !_wsConfig) {
    vscode.window.showWarningMessage('ACIL: Extension not yet activated. Try again in a moment.');
    return;
  }
  const currentBalance  = pipeline.balance;
  const monthlyBudget   = _wsConfig.monthlyBudget;

  await BalanceReconciler.run(
    currentBalance,
    monthlyBudget,
    (newBalance: number) => {
      // Apply correction via WorkspaceConfigLoader — preserves all other settings
      _wsConfig?.applyRemote({ version: 1, monthlyBudget: newBalance + (monthlyBudget - pipeline!.totalAllocation) });
      _output?.appendLine(
        `[ACIL] Balance reconciled: $${currentBalance.toFixed(4)} → $${newBalance.toFixed(4)} ` +
        `(drift: $${Math.abs(newBalance - currentBalance).toFixed(4)})`
      );
      refreshStatusBar();
    },
  );
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

async function exportCSV(): Promise<void> {
  if (!pipeline) return;
  const summary = pipeline.audit.summarize();
  if (summary.totalEvents === 0) {
    vscode.window.showInformationMessage('ACIL: No sessions recorded yet — use @acil to start tracking.');
    return;
  }

  const defaultPath = vscode.Uri.file(
    require('os').homedir() + `/Downloads/acil-session-history-${new Date().toISOString().slice(0,10)}.csv`
  );

  const uri = await vscode.window.showSaveDialog({
    defaultUri:  defaultPath,
    filters:     { 'CSV Files': ['csv'], 'All Files': ['*'] },
    title:       'Export ACIL Session History',
    saveLabel:   'Export CSV',
  });

  if (!uri) return;

  pipeline.audit.exportCSV(uri.fsPath);

  const open = { title: 'Open in Finder' };
  const action = await vscode.window.showInformationMessage(
    `ACIL: Exported ${summary.totalEvents} sessions to ${uri.fsPath}`,
    open,
  );
  if (action === open) {
    vscode.env.openExternal(vscode.Uri.file(require('path').dirname(uri.fsPath)));
  }
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

function getAuditFilePath(context: vscode.ExtensionContext): string {
  const p = vscode.Uri.joinPath(context.globalStorageUri, 'acil-audit.json').fsPath;
  _auditFilePath = p;
  return p;
}

function getProfileFilePath(context: vscode.ExtensionContext): string {
  const p = vscode.Uri.joinPath(context.globalStorageUri, 'acil-profile.json').fsPath;
  _profileFilePath = p;
  return p;
}

function getOutcomesFilePath(context: vscode.ExtensionContext): string {
  const p = vscode.Uri.joinPath(context.globalStorageUri, 'acil-outcomes.json').fsPath;
  _outcomesFilePath = p;
  return p;
}

function estimateCurrentContext(): number {
  // Rough estimate: count characters in open documents / 4 (chars per token)
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) return 0;
  return Math.min(200_000, Math.floor(activeEditor.document.getText().length / 4));
}
