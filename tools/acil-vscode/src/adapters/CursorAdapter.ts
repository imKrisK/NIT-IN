/**
 * ACIL — Cursor IDE Adapter
 *
 * Enables ACIL cost governance in Cursor IDE, which uses its own
 * AI routing (not the VS Code vscode.lm API).
 *
 * Cursor's extension API as of 2026:
 *   - Cursor uses a fork of VS Code with `cursor.chat` namespace
 *   - Extensions can hook `cursor.chat.onDidSendMessage` (proposed API)
 *   - Standard VS Code workspace/document APIs are available
 *   - `vscode.lm` is NOT available in Cursor
 *
 * Strategy (Phase 1 — current):
 *   - Use `@nit-in/acil` npm package directly (no vscode.lm dependency)
 *   - TelemetryCollector works (uses standard workspace APIs)
 *   - ACILPipeline.preflight() + postflight() work (no VS Code API)
 *   - Status bar works (standard VS Code StatusBarItem)
 *   - NO CopilotInterceptor (requires vscode.lm.sendRequest)
 *   - NO ChatParticipant (requires vscode.chat.createChatParticipant)
 *
 * Strategy (Phase 2 — roadmap):
 *   - Hook Cursor's HTTP proxy layer to intercept AI requests
 *   - Use `cursor.ai.onWillSendRequest` when Cursor exposes it
 *
 * COMPATIBILITY: Works in Cursor 0.40+ via standard VS Code extension APIs.
 * Install: package.json engines.vscode = "^1.80.0" (Cursor-compatible range)
 *
 * @author imKrisK (github.com/imKrisK)
 * @see https://conversationmine.ai
 */

import * as vscode from 'vscode';
import {
  ACILPipeline,
  BudgetPeriod,
  EnforcementState,
  SessionType,
  QualityRequirement,
} from '@nit-in/acil';

// Detect if running in Cursor vs standard VS Code
export function isRunningInCursor(): boolean {
  return vscode.env.appName.toLowerCase().includes('cursor') ||
    vscode.env.uriScheme === 'cursor';
}

/**
 * CursorAdapter — provides ACIL governance in Cursor IDE
 * without requiring vscode.lm API.
 *
 * Limitations vs VS Code:
 *   - No @acil chat participant (Cursor uses different chat model)
 *   - No real countTokens() — uses len/4 estimate
 *   - No automatic request interception — developer calls runPreflight() manually
 *
 * What works:
 *   - Status bar with live balance
 *   - TSP forecast (accessible via command palette)
 *   - Dashboard WebView
 *   - TelemetryCollector (file events → session classification)
 *   - GitHub credit sync
 *   - AuditTrail persistence
 *   - MetaRecursiveLoop calibration
 *   - CSV export
 */
export class CursorAdapter implements vscode.Disposable {
  private _pipeline:      ACILPipeline;
  private _statusItem:    vscode.StatusBarItem;
  private _disposables:   vscode.Disposable[] = [];

  constructor(pipeline: ACILPipeline) {
    this._pipeline   = pipeline;

    // Status bar — same as VS Code extension
    this._statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right, 1000,
    );
    this._statusItem.command = 'acil.showDashboard';
    this._statusItem.tooltip = 'ACIL — AI Credit Intelligence Layer\nby @imKrisK | Cursor Mode (limited)';
    this._refreshStatusBar();
    this._statusItem.show();

    // Refresh every 60s
    const timer = setInterval(() => this._refreshStatusBar(), 60_000);
    this._disposables.push({ dispose: () => clearInterval(timer) });

    // Warn that chat participant is not available
    vscode.window.showInformationMessage(
      'ACIL running in Cursor Mode. @acil chat participant unavailable. Commands available via Ctrl+Shift+P.',
      'Got it',
    );
  }

  /**
   * Manual preflight — developer calls this from command palette
   * before running an expensive AI operation in Cursor.
   *
   * Shows predicted cost + enforcement state in a VS Code notification.
   */
  async runManualPreflight(queryText: string): Promise<boolean> {
    const preflight = this._pipeline.preflight({
      rawInput:           queryText,
      telemetry: {
        queryText,
        toolCallSignatures:     [],
        newFileCount:           0,
        modifiedFileCount:      1,
        contextRatio:           0.7,
        hasErrorContext:        /error|exception|failed/i.test(queryText),
        existingFileSimilarity: 0.5,
      },
      preferredModelId:   'copilot-premium' as any,
      qualityRequirement: QualityRequirement.STANDARD,
      contextSizeTokens:  Math.ceil(queryText.length / 4),
      agenticDepth:       0,
      userId:             'cursor-developer',
    });

    if (!preflight.allowed) {
      vscode.window.showErrorMessage(
        `ACIL [Cursor]: Blocked — ${preflight.enforcement.state}. Balance: $${this._pipeline.balance.toFixed(2)}`,
      );
      return false;
    }

    const proceed = await vscode.window.showInformationMessage(
      `ACIL [Cursor]: ${preflight.sessionType} session · ~$${preflight.prediction.expectedCost.toFixed(3)} · Balance: $${this._pipeline.balance.toFixed(2)}`,
      { modal: false },
      'Proceed',
    );
    return proceed === 'Proceed';
  }

  dispose(): void {
    this._statusItem.dispose();
    this._disposables.forEach(d => d.dispose());
  }

  private _refreshStatusBar(): void {
    const b = this._pipeline.balance;
    const t = this._pipeline.totalAllocation;
    const p = t > 0 ? Math.round((b / t) * 100) : 0;
    this._statusItem.text = `⚡ ACIL [Cursor] $${b.toFixed(2)} (${p}%)`;
    if (this._pipeline.currentState === EnforcementState.CRITICAL ||
        this._pipeline.currentState === EnforcementState.EXHAUSTED) {
      this._statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
  }
}

/**
 * Roadmap for full Cursor support (Phase 2):
 *
 * When Cursor exposes cursor.ai hooks:
 *   1. Register cursor.ai.onWillSendRequest → run preflight()
 *   2. Register cursor.ai.onDidReceiveResponse → run postflight()
 *   3. Register cursor.chat.createParticipant → @acil in Cursor chat
 *
 * ETA: Cursor 0.50+ (based on their public roadmap, Q4 2026)
 *
 * Until then: CursorAdapter provides full governance except request interception.
 * Manual `acil.runPreflight` command covers the gap for power users.
 */
