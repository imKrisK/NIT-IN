/**
 * ACIL — ChatParticipant
 *
 * Registers VS Code chat participant `@acil` with three slash commands:
 *
 *   @acil /status     — current credit balance + enforcement state
 *   @acil /forecast   — TSP burn timeline + exhaustion date
 *   @acil /budget     — set monthly budget interactively
 *   @acil <prompt>    — run ACIL-intercepted request: classify → predict → enforce → forward to model
 *
 * This is the primary entry point for developers to interact with ACIL
 * from the VS Code chat panel. It also demonstrates the Wave 10 Claim 1-3
 * pipeline in a live, observable way.
 *
 * Architecture:
 *   ChatParticipant handles @acil-directed messages.
 *   CopilotInterceptor handles the actual model call with preflight/postflight.
 *   The developer sees cost predictions inline before committing to the request.
 */

import * as vscode from 'vscode';
import { ACILPipeline, EnforcementState, SessionType, MetaRecursiveLoop } from '@nit-in/acil';
import { CopilotInterceptor } from './CopilotInterceptor';
import { TelemetryCollector }  from '../TelemetryCollector';
import { NotificationManager } from '../NotificationManager';

const PARTICIPANT_ID = 'acil.assistant';

export class ACILChatParticipant implements vscode.Disposable {
  private _participant: vscode.ChatParticipant;
  private _interceptor: CopilotInterceptor;
  private _pipeline:    ACILPipeline;
  private _loop:        MetaRecursiveLoop;

  constructor(
    pipeline:      ACILPipeline,
    telemetry:     TelemetryCollector,
    notifications: NotificationManager,
    userId:        string,
  ) {
    this._pipeline    = pipeline;
    this._interceptor = new CopilotInterceptor(pipeline, telemetry, notifications);
    this._loop        = new MetaRecursiveLoop();

    this._participant = vscode.chat.createChatParticipant(
      PARTICIPANT_ID,
      this._handler.bind(this),
    );

    this._participant.iconPath = new vscode.ThemeIcon('circuit-board');
    this._participant.followupProvider = {
      provideFollowups: (result, _context, _token) =>
        this._followups(result),
    };
  }

  dispose(): void {
    this._participant.dispose();
  }

  // ── Request handler ───────────────────────────────────────────────────────

  private async _handler(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token:    vscode.CancellationToken,
  ): Promise<vscode.ChatResult | void> {

    const userId = vscode.workspace.getConfiguration('acil').get<string>('userId', 'developer');

    // ── Slash commands ──────────────────────────────────────────────────────

    if (request.command === 'status') {
      return this._handleStatus(response);
    }

    if (request.command === 'forecast') {
      return this._handleForecast(response);
    }

    if (request.command === 'budget') {
      await vscode.commands.executeCommand('acil.setMonthlyBudget');
      response.markdown('Budget updated. Reload the extension if you want to reset the billing period.');
      return {};
    }

    if (request.command === 'report') {
      return this._handleReport(response);
    }

    // ── Default: intercepted model request ─────────────────────────────────

    const prompt    = request.prompt.trim();
    const model     = request.model;

    if (!prompt) {
      response.markdown([
        '**⚡ ACIL — AI Credit Intelligence Layer**',
        '*by [@imKrisK](https://github.com/imKrisK) · [conversationmine.ai](https://conversationmine.ai) · Patent Pending Wave 10*',
        '',
        'Commands:',
        '- `/status` — credit balance, developer archetype, recursive calibration state',
        '- `/forecast` — temporal spend forecast and exhaustion date',
        '- `/report` — 14-day daily usage breakdown',
        '- `/budget` — set your monthly AI credit budget',
        '',
        'Or type any prompt and ACIL will classify, predict cost, compress, and forward to the model.',
      ].join('\n'));
      return {};
    }

    // ── Run MetaRecursiveLoop calibration BEFORE preflight ─────────────────
    // This is "prediction before token burn" — recursive self-calibration
    const recursivePrediction = this._loop.calibrate(this._pipeline.audit);
    const preClassifiedType   = recursivePrediction.preClassifiedSession;

    response.progress(`ACIL: Pre-flight check (${preClassifiedType} · est. $${recursivePrediction.nextRequestCostEst.toFixed(3)})...`);

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];

    const interceptResult = await this._interceptor.sendRequest(
      model, messages, {}, token, userId,
    );

    if (interceptResult.blockedByACIL === true) {
      response.markdown([
        `**⛔ ACIL Blocked This Request**`,
        '',
        `State: \`${interceptResult.state}\``,
        '',
        interceptResult.message,
        '',
        `Balance: $${this._pipeline.balance.toFixed(2)} remaining`,
        '',
        'Use `/forecast` to see your spend timeline, or `/budget` to adjust your limit.',
      ].join('\n'));
      return { metadata: { blocked: true, state: interceptResult.state } };
    }

    let chunkCount = 0;
    for await (const chunk of interceptResult.text) {
      if (token.isCancellationRequested) break;
      response.markdown(chunk);
      chunkCount++;
    }

    // Show compact ACIL footer after response
    const forecast = this._pipeline.forecast();
    const riskPct  = Math.round(forecast.overageRiskScore * 100);
    response.markdown([
      '',
      `---`,
      `*ACIL: $${this._pipeline.balance.toFixed(2)} remaining · ` +
      `${riskPct}% overage risk · ` +
      `state: ${this._pipeline.currentState}*`,
    ].join('\n'));

    return {};
  }

  // ── /report command ───────────────────────────────────────────────────────

  private _handleReport(response: vscode.ChatResponseStream): vscode.ChatResult {
    const dailyBurns = this._pipeline.audit.dailyBurns();
    const summary    = this._pipeline.audit.summarize();

    if (dailyBurns.length === 0) {
      response.markdown('**ACIL Report:** No sessions recorded yet. Use `@acil` with any prompt to start tracking.');
      return {};
    }

    const rows = dailyBurns.slice(-14).map(d =>
      `| ${d.date} | ${d.totalRequests} | $${d.grossCost.toFixed(4)} | $${d.netCost.toFixed(4)} |`
    ).join('\n');

    const byModelRows = Object.entries(summary.byModel ?? {})
      .sort(([,a], [,b]) => (b as number) - (a as number))
      .map(([m, n]) => `| ${m} | ${n} |`)
      .join('\n');

    response.markdown([
      `## 📋 ACIL Session Report (last 14 days)`,
      '',
      `| Date | Requests | Gross | Net |`,
      `|------|----------|-------|-----|`,
      rows,
      '',
      `**Totals:** ${summary.totalEvents} sessions · ${summary.totalTokens.toLocaleString()} tokens · $${summary.totalGross.toFixed(4)} gross · $${summary.totalDiscount.toFixed(4)} saved by quota`,
      '',
      `### By Model`,
      `| Model | Sessions |`,
      `|-------|----------|`,
      byModelRows,
      '',
      `### By Session Type`,
      ...Object.entries(summary.bySessionType ?? {}).map(([t, n]) => `- **${t}**: ${n} sessions`),
      '',
      summary.totalSubstitutions > 0
        ? `### 🔄 Model Substitutions\n${Object.entries(summary.substitutionBreakdown ?? {}).map(([k, v]) => `- ${k}: ${v!.count}x · $${v!.totalSavingsUsd.toFixed(4)} saved`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n'));

    return {};
  }

  // ── /status command ───────────────────────────────────────────────────────

  private _handleStatus(response: vscode.ChatResponseStream): vscode.ChatResult {
    const balance   = this._pipeline.balance;
    const total     = this._pipeline.totalAllocation;
    const pct       = total > 0 ? Math.round((balance / total) * 100) : 0;
    const state     = this._pipeline.currentState;
    const summary   = this._pipeline.audit.summarize();
    const stats     = this._pipeline.burnStats();

    const stateEmoji: Record<EnforcementState, string> = {
      [EnforcementState.NORMAL]:    '🟢',
      [EnforcementState.ADVISORY]:  '🟡',
      [EnforcementState.WARNING]:   '🟠',
      [EnforcementState.THROTTLE]:  '🔄',
      [EnforcementState.CRITICAL]:  '🔴',
      [EnforcementState.EXHAUSTED]: '⛔',
    };

    const substitutionLines = summary.totalSubstitutions > 0
      ? Object.entries(summary.substitutionBreakdown ?? {})
          .map(([pair, data]) =>
            `| → ${pair} | ${data!.count}x | $${data!.totalSavingsUsd.toFixed(4)} |`)
          .join('\n')
      : '| — | 0 | $0.0000 |';

    // MetaRecursive calibration status
    const recursive   = this._loop.calibrate(this._pipeline.audit);
    const archetypeStr = recursive.developerArchetype
      ? `**${recursive.developerArchetype.archetype}** (${(recursive.developerArchetype.confidence * 100).toFixed(0)}% confidence)`
      : 'Calibrating... (need 5+ sessions)';
    const accuracyStr = recursive.predictionAccuracy !== null
      ? `${(recursive.predictionAccuracy * 100).toFixed(0)}%`
      : 'calibrating';

    response.markdown([
      `## ${stateEmoji[state]} ACIL Credit Status`,
      `*by [@imKrisK](https://github.com/imKrisK) · [conversationmine.ai](https://conversationmine.ai) · Patent Pending Wave 10*`,
      '',
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Balance | **$${balance.toFixed(2)}** (${pct}% of $${total.toFixed(2)}) |`,
      `| State | \`${state}\` |`,
      `| Sessions | ${summary.totalEvents} |`,
      `| Tokens used | ${summary.totalTokens.toLocaleString()} |`,
      `| Gross cost | $${summary.totalGross.toFixed(4)} |`,
      `| Quota savings | $${summary.totalDiscount.toFixed(4)} |`,
      `| CCT saved | ${(summary.cctSavingsTokens ?? 0).toLocaleString()} tokens |`,
      `| Daily avg burn | $${stats.dailyAvg.toFixed(4)} |`,
      `| Trend | ${stats.trend} |`,
      '',
      `### 🔄 Model Substitutions (Claim 7)`,
      `| Substitution | Count | Savings |`,
      `|---|---|---|`,
      substitutionLines,
      `| **Total saved** | **${summary.totalSubstitutions}x** | **$${(summary.totalSubstitutionSavingsUsd ?? 0).toFixed(4)}** |`,
      '',
      `### 🧠 Meta-Recursive Calibration (Wave 11)`,
      `| Field | Value |`,
      `|-------|-------|`,
      `| Developer archetype | ${archetypeStr} |`,
      `| Next session predicted | \`${recursive.preClassifiedSession}\` · ~$${recursive.nextRequestCostEst.toFixed(3)} |`,
      `| CCT threshold (adapted) | ${(recursive.adaptedCCTThreshold * 100).toFixed(0)}% |`,
      `| TSP multiplier (adapted) | ${recursive.adaptedTSPMultiplier.toFixed(2)}x |`,
      `| Prediction accuracy | ${accuracyStr} |`,
      `| Calibration generation | ${recursive.generation} |`,
    ].join('\n'));

    return {};
  }

  // ── /forecast command ─────────────────────────────────────────────────────

  private _handleForecast(response: vscode.ChatResponseStream): vscode.ChatResult {
    const forecast = this._pipeline.forecast();
    const riskPct  = Math.round(forecast.overageRiskScore * 100);
    const riskEmoji =
      riskPct >= 90 ? '🔴' :
      riskPct >= 60 ? '🟠' :
      riskPct >= 30 ? '🟡' : '🟢';

    const exhaustStr = forecast.exhaustionDate
      ? forecast.exhaustionDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'Survives to reset ✓';

    response.markdown([
      `## 📊 ACIL Temporal Spend Forecast`,
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| Exhaustion date | **${exhaustStr}** |`,
      `| Days remaining | ${forecast.daysRemaining.toFixed(1)} |`,
      `| Overage risk | ${riskEmoji} **${riskPct}%** |`,
      `| Est. overage cost | $${forecast.overageCostEstimate.toFixed(2)} |`,
      '',
      `### Recommended Actions`,
      ...forecast.recommendedActions.map(a => `- ${a}`),
      '',
      forecast.confidenceLow && forecast.confidenceHigh
        ? `*Confidence interval: ${new Date(forecast.confidenceLow).toLocaleDateString()} – ${new Date(forecast.confidenceHigh).toLocaleDateString()}*`
        : '',
    ].filter(Boolean).join('\n'));

    return {};
  }

  // ── Follow-ups ────────────────────────────────────────────────────────────

  private _followups(result: vscode.ChatResult): vscode.ChatFollowup[] {
    if (result.metadata?.['blocked']) {
      return [
        { prompt: '/forecast', label: '📊 See spend forecast', command: 'forecast' },
        { prompt: '/budget',   label: '💰 Adjust budget',      command: 'budget' },
      ];
    }
    return [
      { prompt: '/status',   label: '⚡ Check balance',        command: 'status' },
      { prompt: '/forecast', label: '📊 See forecast',         command: 'forecast' },
    ];
  }
}
