/**
 * OutboxReviewPanel — VS Code Quick Pick flow for reviewing reply drafts.
 *
 * Flow:
 *   1. List view:    All PENDING_REVIEW drafts with classification icon + excerpt
 *   2. Detail view:  Full draft text + 4 actions (Approve+Copy, Edit, Reject, Skip)
 *   3. Edit view:    InputBox pre-filled with draft — save → Approve+Copy
 *
 * After Approve: copies text to clipboard + updates GitHub status → APPROVED.
 * After Reject:  updates GitHub status → REJECTED.
 * Both actions trigger an OutboxMonitor refresh.
 */

import * as vscode from 'vscode';
import { OutboxClient, ReplyDraft } from './OutboxClient';
import { OutboxMonitor } from './OutboxMonitor';
import { DiscordWebhookClient } from './DiscordWebhookClient';

const CLASSIFICATION_ICONS: Record<string, string> = {
  INSTALL_QUESTION:   '$(wrench)',
  PRICING_QUESTION:   '$(tag)',
  FEATURE_REQUEST:    '$(lightbulb)',
  PRAISE:             '$(heart)',
  COMPETITOR_MENTION: '$(info)',
  TECHNICAL_QUESTION: '$(symbol-method)',
  GENERAL:            '$(comment)',
};

export class OutboxReviewPanel {
  constructor(
    private readonly client:  OutboxClient,
    private readonly monitor: OutboxMonitor,
    private readonly discord: DiscordWebhookClient,
  ) {}

  /** Entry point — show the list of pending drafts. */
  async open(): Promise<void> {
    const drafts = this.monitor.pending;

    if (drafts.length === 0) {
      void vscode.window.showInformationMessage('ACIL Outbox: no pending reply drafts. All caught up!');
      return;
    }

    await this._showList(drafts);
  }

  // ── Step 1: List ────────────────────────────────────────────────────────────

  private async _showList(drafts: ReplyDraft[]): Promise<void> {
    type DraftItem = vscode.QuickPickItem & { draft: ReplyDraft };

    const items: DraftItem[] = drafts.map(d => ({
      draft:       d,
      label:       `${CLASSIFICATION_ICONS[d.classification] ?? '$(comment)'}  @${d.reply_to.username}  —  ${d.classification}`,
      description: d.reply_to.like_count > 0 ? `❤️ ${d.reply_to.like_count}` : undefined,
      detail:      `"${d.reply_to.excerpt.slice(0, 120)}${d.reply_to.excerpt.length > 120 ? '…' : ''}"`,
    }));

    const refreshItem: vscode.QuickPickItem = {
      label:       '$(refresh)  Refresh outbox',
      description: 'Re-fetch from GitHub',
      alwaysShow:  true,
    };

    const pick = await vscode.window.showQuickPick(
      [...items, refreshItem],
      {
        title:        `ACIL Outbox — ${drafts.length} reply draft${drafts.length !== 1 ? 's' : ''} pending review`,
        placeHolder:  'Select a draft to review',
        matchOnDetail: true,
      }
    );

    if (!pick) return;

    if (pick === refreshItem) {
      await this.monitor.refresh();
      if (this.monitor.pending.length > 0) await this._showList(this.monitor.pending);
      return;
    }

    await this._showDetail((pick as DraftItem).draft);
  }

  // ── Step 2: Detail ──────────────────────────────────────────────────────────

  private async _showDetail(draft: ReplyDraft): Promise<void> {
    const icon    = CLASSIFICATION_ICONS[draft.classification] ?? '$(comment)';
    const platform = draft.platform === 'cursor_forum' ? 'Cursor Forum' : draft.platform;

    type ActionItem = vscode.QuickPickItem & { action: string };

    const actions: ActionItem[] = [
      {
        action:      'approve',
        label:       '$(check)  Approve — copy to clipboard',
        description: 'Marks APPROVED + copies text so you can paste in the forum',
      },
      {
        action:      'approve_discord',
        label:       '$(megaphone)  Approve + Post to Discord',
        description: 'Marks APPROVED + posts reply directly to Discord channel via webhook',
      },
      {
        action:      'edit',
        label:       '$(edit)  Edit draft first',
        description: 'Open in input box, then approve',
      },
      {
        action:      'reject',
        label:       '$(x)  Reject',
        description: 'Marks REJECTED — will not appear again',
      },
      {
        action:      'skip',
        label:       '$(debug-step-over)  Skip for now',
        description: 'Leave as PENDING — review later',
      },
      {
        action:      'open',
        label:       '$(link-external)  Open forum thread',
        description: draft.topic_url,
      },
      {
        action:      'back',
        label:       '$(arrow-left)  Back to list',
      },
    ];

    const pick = await vscode.window.showQuickPick(actions, {
      title: `${icon}  Reply to @${draft.reply_to.username}  [${draft.classification}]`,
      placeHolder: draft.draft_reply,   // shows draft text as the placeholder
      matchOnDescription: true,
    });

    if (!pick) return;

    switch (pick.action) {
      case 'approve':         await this._approve(draft, draft.draft_reply);        break;
      case 'approve_discord': await this._approveAndPost(draft, draft.draft_reply); break;
      case 'edit':            await this._edit(draft);                               break;
      case 'reject':          await this._reject(draft);                             break;
      case 'open':
        void vscode.env.openExternal(vscode.Uri.parse(draft.topic_url));
        break;
      case 'back':
        await this._showList(this.monitor.pending);
        break;
      case 'skip':
      default:
        break;
    }
  }

  // ── Step 3: Edit ────────────────────────────────────────────────────────────

  private async _edit(draft: ReplyDraft): Promise<void> {
    const edited = await vscode.window.showInputBox({
      title:       `Edit reply for @${draft.reply_to.username}`,
      value:       draft.draft_reply,
      prompt:      'Edit the reply text. Press Enter to approve, Escape to cancel.',
      placeHolder: draft.draft_reply,
      ignoreFocusOut: true,
    });

    if (edited === undefined) {
      // User escaped — go back to detail
      await this._showDetail(draft);
      return;
    }

    await this._approve(draft, edited.trim() || draft.draft_reply);
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  private async _approveAndPost(draft: ReplyDraft, text: string): Promise<void> {
    // Check webhook configured first
    const configured = await this.discord.isConfigured();
    if (!configured) {
      const setup = await vscode.window.showWarningMessage(
        'Discord webhook not configured. Set it up first.',
        'Connect Discord Webhook'
      );
      if (setup) await vscode.commands.executeCommand('acil.connectDiscordWebhook');
      return;
    }

    try {
      // 1. Mark APPROVED on GitHub
      await this.client.updateStatus(draft, 'APPROVED', text);

      // 2. Post to Discord via webhook
      await this.discord.postReply({
        username:       'imac_$trut',
        replyTo:        draft.reply_to.username,
        classification: draft.classification,
        text,
        forumUrl:       draft.topic_url,
        topicTitle:     `Topic ${draft.topic_id}`,
      });

      // 3. Mark POSTED on GitHub
      await this.client.updateStatus(draft, 'POSTED', text);

      void vscode.window.showInformationMessage(
        `Posted reply to @${draft.reply_to.username} on Discord + marked POSTED on GitHub.`,
        'Open Thread'
      ).then(choice => {
        if (choice === 'Open Thread') {
          void vscode.env.openExternal(vscode.Uri.parse(draft.topic_url));
        }
      });
    } catch (e: any) {
      void vscode.window.showErrorMessage(`ACIL Outbox: Discord post failed — ${e.message}`);
    }
    await this.monitor.refresh();
    if (this.monitor.pending.length > 0) await this._showList(this.monitor.pending);
  }

  private async _approve(draft: ReplyDraft, text: string): Promise<void> {
    try {
      await this.client.updateStatus(draft, 'APPROVED', text);
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage(
        `✅ Reply for @${draft.reply_to.username} approved — text copied to clipboard. Paste it in the forum.`,
        'Open Thread'
      ).then(choice => {
        if (choice === 'Open Thread') {
          void vscode.env.openExternal(vscode.Uri.parse(draft.topic_url));
        }
      });
    } catch (e: any) {
      void vscode.window.showErrorMessage(`ACIL Outbox: approve failed — ${e.message}`);
    }
    await this.monitor.refresh();
    // If more pending, show list again
    if (this.monitor.pending.length > 0) await this._showList(this.monitor.pending);
  }

  private async _reject(draft: ReplyDraft): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Reject draft for @${draft.reply_to.username}? This marks it as REJECTED on GitHub.`,
      { modal: false },
      'Reject'
    );
    if (confirm !== 'Reject') {
      await this._showDetail(draft);
      return;
    }
    try {
      await this.client.updateStatus(draft, 'REJECTED');
      void vscode.window.showInformationMessage(`❌ Draft for @${draft.reply_to.username} rejected.`);
    } catch (e: any) {
      void vscode.window.showErrorMessage(`ACIL Outbox: reject failed — ${e.message}`);
    }
    await this.monitor.refresh();
    if (this.monitor.pending.length > 0) await this._showList(this.monitor.pending);
  }
}
