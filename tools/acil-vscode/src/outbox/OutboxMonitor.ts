/**
 * OutboxMonitor — Polls the GitHub outbox for PENDING_REVIEW drafts
 * and drives the status bar badge next to the main ACIL item.
 *
 * Badge states:
 *   No drafts:     hidden
 *   1+ pending:    📬 <n> pending   (amber background)
 *   Just arrived:  📬 <n> NEW ✦    (pulses for 30s then settles)
 *
 * Click → triggers OutboxReviewPanel.open()
 */

import * as vscode from 'vscode';
import { OutboxClient, ReplyDraft } from './OutboxClient';

const POLL_INTERVAL_MS = 15 * 60 * 1000;   // 15 min background
const FOCUS_POLL_DELAY = 1_500;             // re-check 1.5s after window focus
const PULSE_DURATION_MS = 30_000;          // "NEW ✦" badge pulse duration

export class OutboxMonitor implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private readonly _disposables: vscode.Disposable[] = [];

  private _pending:       ReplyDraft[] = [];
  private _lastCount      = -1;           // -1 = never polled
  private _pulseTimer:    NodeJS.Timeout | undefined;
  private _pollTimer:     NodeJS.Timeout | undefined;
  private _polling        = false;

  /** Fires whenever the pending queue changes. OutboxReviewPanel subscribes. */
  private readonly _onChanged = new vscode.EventEmitter<ReplyDraft[]>();
  readonly onChanged = this._onChanged.event;

  constructor(
    private readonly client:     OutboxClient,
    private readonly onReview:   () => void,    // callback → open ReviewPanel
  ) {
    // Status bar item — sits just left of the main ACIL item
    this._item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right, 997
    );
    this._item.command = 'acil.openOutbox';
    this._item.tooltip  = 'ACIL Outbox — click to review reply drafts';
    this._disposables.push(this._item);

    // Re-poll on window focus
    this._disposables.push(
      vscode.window.onDidChangeWindowState(e => {
        if (e.focused) {
          setTimeout(() => this._poll(), FOCUS_POLL_DELAY);
        }
      })
    );

    this._disposables.push(this._onChanged);
  }

  /** Start background polling. Called from extension activate(). */
  start(): void {
    void this._poll();
    this._pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  /** Force an immediate poll (e.g. from 'acil.checkOutbox' command). */
  async refresh(): Promise<void> {
    await this._poll();
  }

  get pending(): ReplyDraft[] { return this._pending; }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async _poll(): Promise<void> {
    if (this._polling) return;
    this._polling = true;
    try {
      const drafts = await this.client.fetchPending();
      this._pending = drafts;
      this._updateBadge(drafts);
      this._onChanged.fire(drafts);
    } catch {
      // silent — outbox is optional (no token = no badge, no error)
    } finally {
      this._polling = false;
    }
  }

  private _updateBadge(drafts: ReplyDraft[]): void {
    const count = drafts.length;

    if (count === 0) {
      this._item.hide();
      this._lastCount = 0;
      return;
    }

    const isNew = this._lastCount >= 0 && count > this._lastCount;
    this._lastCount = count;

    if (isNew) {
      // Pulse: show "NEW ✦" badge for 30s then settle
      this._item.text            = `$(mail) ${count} NEW ✦`;
      this._item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this._item.show();

      if (this._pulseTimer) clearTimeout(this._pulseTimer);
      this._pulseTimer = setTimeout(() => {
        this._item.text            = `$(mail) ${count} pending`;
        this._item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      }, PULSE_DURATION_MS);

      // Also fire a non-intrusive info message
      void vscode.window.showInformationMessage(
        `ACIL Outbox: ${count - (this._lastCount - (count - this._lastCount))} new reply draft(s) ready for review.`,
        'Review Now'
      ).then(choice => {
        if (choice === 'Review Now') this.onReview();
      });
    } else {
      this._item.text            = `$(mail) ${count} pending`;
      this._item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this._item.show();
    }
  }

  dispose(): void {
    if (this._pollTimer)  clearInterval(this._pollTimer);
    if (this._pulseTimer) clearTimeout(this._pulseTimer);
    this._disposables.forEach(d => d.dispose());
  }
}
