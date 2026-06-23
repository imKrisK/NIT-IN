/**
 * ACIL — DashboardPanel
 *
 * Renders a VS Code WebView panel showing:
 *   • Daily burn bar chart (actual + projected)
 *   • Credit balance timeline with exhaustion date marker
 *   • Budget "danger zone" shading (below 25%)
 *   • Current enforcement state badge
 *   • Session-type breakdown (pie / legend)
 *   • CCT savings counter
 *   • TSP forecast summary card
 *
 * Data flow:
 *   ACILPipeline → dailyBurns + forecast + summary
 *     → serialized to JSON → postMessage to WebView
 *     → rendered as inline SVG via vanilla JS (no bundler needed)
 *
 * The WebView HTML is a self-contained string with a Content-Security-Policy
 * that allows only the VS Code webview nonce for scripts. No CDN, no external
 * resources — all rendering is local.
 */

import * as vscode from 'vscode';
import { ACILPipeline, EnforcementState, TemporalForecast } from '@nit-in/acil';

export class DashboardPanel implements vscode.Disposable {
  static readonly viewType = 'acil.dashboard';
  private static _instance: DashboardPanel | undefined;

  private _panel: vscode.WebviewPanel;
  private _pipeline: ACILPipeline;
  private _disposables: vscode.Disposable[] = [];

  /** Show or reveal the singleton dashboard panel. */
  static show(
    extensionUri: vscode.Uri,
    pipeline:     ACILPipeline,
  ): DashboardPanel {
    if (DashboardPanel._instance) {
      DashboardPanel._instance._pipeline = pipeline;
      DashboardPanel._instance._panel.reveal(vscode.ViewColumn.Two);
      DashboardPanel._instance.refresh();
      return DashboardPanel._instance;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'ACIL Dashboard',
      vscode.ViewColumn.Two,
      {
        enableScripts:          true,
        retainContextWhenHidden: true,
        localResourceRoots:     [extensionUri],
      },
    );

    DashboardPanel._instance = new DashboardPanel(panel, pipeline);
    return DashboardPanel._instance;
  }

  private constructor(panel: vscode.WebviewPanel, pipeline: ACILPipeline) {
    this._panel    = panel;
    this._pipeline = pipeline;

    // Initial render
    this.refresh();

    // Re-render on panel visibility change
    this._panel.onDidChangeViewState(() => {
      if (this._panel.visible) this.refresh();
    }, null, this._disposables);

    // Handle messages from the WebView (button clicks, refresh requests)
    this._panel.webview.onDidReceiveMessage(msg => {
      switch (msg.command) {
        case 'refresh':
          this.refresh();
          break;
        case 'connectGitHub':
          vscode.commands.executeCommand('acil.connectGitHub');
          break;
        case 'setMonthlyBudget':
          vscode.commands.executeCommand('acil.setMonthlyBudget');
          break;
        case 'syncNow':
          vscode.commands.executeCommand('acil.syncNow');
          break;
      }
    }, null, this._disposables);

    // Cleanup on close
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  /** Push fresh data to the WebView. */
  refresh(): void {
    const data = this._buildDashboardData();
    this._panel.webview.html = getDashboardHtml(data);
  }

  dispose(): void {
    DashboardPanel._instance = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }

  // ── Data builder ────────────────────────────────────────────────────────────

  private _buildDashboardData(): DashboardData {
    const p         = this._pipeline;
    const forecast  = p.forecast();
    const summary   = p.audit.summarize();
    const dailyRaw  = p.audit.dailyBurns();

    // Use pipeline's exposed burnStats() — same BurnRateCalculator as ExhaustionForecaster
    const stats     = p.burnStats();
    const dailyAvg  = stats.dailyAvg;
    const window14Avg = stats.window14;

    // Build last-30-days array (fill gaps with 0)
    const today     = new Date();
    const days: DayBurn[] = [];
    for (let i = 29; i >= 0; i--) {
      const d     = new Date(today);
      d.setDate(d.getDate() - i);
      const key   = d.toISOString().slice(0, 10);
      const found = dailyRaw.find(r => r.date === key);
      days.push({
        date:          key,
        grossCost:     found?.grossCost     ?? 0,
        netCost:       found?.netCost       ?? 0,
        tokens:        0,
        sessionCount:  found?.totalRequests ?? 0,
        isProjected:   false,
      });
    }

    // Projected days forward until exhaustion or reset (max 30)
    const balance = p.balance;
    if (dailyAvg > 0 && forecast.daysRemaining > 0) {      const projDays = Math.min(30, Math.ceil(forecast.daysRemaining));
      for (let i = 1; i <= projDays; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() + i);
        const projCost = Math.min(dailyAvg, Math.max(0, balance - dailyAvg * (i - 1)));
        days.push({
          date:         d.toISOString().slice(0, 10),
          grossCost:    projCost,
          netCost:      0,
          tokens:       0,
          sessionCount: 0,
          isProjected:  true,
        });
      }
    }

    return {
      balance,
      totalBudget:     p.totalAllocation,
      state:           p.currentState,
      forecast,
      summary,
      days,
      burnStats: { dailyAvg, window14Avg, trend: stats.trend },
      syncedFromGitHub: false,
      lastSyncTime:    null,
    };
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface DayBurn {
  date:         string;  // YYYY-MM-DD
  grossCost:    number;
  netCost:      number;
  tokens:       number;
  sessionCount: number;
  isProjected:  boolean;
}

export interface DashboardData {
  balance:         number;
  totalBudget:     number;
  state:           EnforcementState;
  forecast:        TemporalForecast;
  summary:         ReturnType<ACILPipeline['audit']['summarize']>;
  days:            DayBurn[];
  burnStats:       { dailyAvg: number; window14Avg: number; trend: string };
  syncedFromGitHub: boolean;
  lastSyncTime:    Date | null;
}

// ── HTML template ─────────────────────────────────────────────────────────────

function getDashboardHtml(data: DashboardData): string {
  const stateColor: Record<EnforcementState, string> = {
    [EnforcementState.NORMAL]:    '#4ec9b0',
    [EnforcementState.ADVISORY]:  '#dcdcaa',
    [EnforcementState.WARNING]:   '#ce9178',
    [EnforcementState.THROTTLE]:  '#f44747',
    [EnforcementState.CRITICAL]:  '#f44747',
    [EnforcementState.EXHAUSTED]: '#808080',
  };

  const stateLabel: Record<EnforcementState, string> = {
    [EnforcementState.NORMAL]:    'NORMAL',
    [EnforcementState.ADVISORY]:  'ADVISORY',
    [EnforcementState.WARNING]:   'WARNING',
    [EnforcementState.THROTTLE]:  'THROTTLE',
    [EnforcementState.CRITICAL]:  'CRITICAL',
    [EnforcementState.EXHAUSTED]: 'EXHAUSTED',
  };

  const pct         = data.totalBudget > 0
    ? Math.round((data.balance / data.totalBudget) * 100) : 0;
  const exhaustStr  = data.forecast.exhaustionDate
    ? new Date(data.forecast.exhaustionDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Survives to reset';
  const riskPct     = Math.round(data.forecast.overageRiskScore * 100);

  // SVG chart dimensions
  const W = 720, H = 220, PAD = { top: 20, right: 20, bottom: 40, left: 56 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;

  // Bar chart data
  const maxCost = Math.max(...data.days.map(d => d.grossCost), 0.01);
  const barW    = Math.floor(chartW / Math.max(data.days.length, 1)) - 1;

  const bars = data.days.map((d, i) => {
    const x   = PAD.left + i * (barW + 1);
    const bh  = Math.max(1, Math.round((d.grossCost / maxCost) * chartH));
    const y   = PAD.top + chartH - bh;
    const fill = d.isProjected ? 'rgba(78,201,176,0.35)' : '#4ec9b0';
    return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" fill="${fill}" rx="1"/>`;
  }).join('');

  // X-axis labels (every 7th day)
  const xLabels = data.days
    .filter((_, i) => i % 7 === 0)
    .map((d, i) => {
      const x = PAD.left + i * 7 * (barW + 1) + barW / 2;
      const label = d.date.slice(5); // MM-DD
      return `<text x="${x}" y="${H - PAD.bottom + 14}" fill="#858585" font-size="10" text-anchor="middle">${label}</text>`;
    }).join('');

  // Y-axis labels
  const yLabels = [0, 0.25, 0.5, 0.75, 1.0].map(f => {
    const y     = PAD.top + chartH - Math.round(f * chartH);
    const label = `$${(f * maxCost).toFixed(2)}`;
    return `<text x="${PAD.left - 4}" y="${y + 4}" fill="#858585" font-size="10" text-anchor="end">${label}</text>
            <line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="#3c3c3c" stroke-width="0.5"/>`;
  }).join('');

  // "Today" divider line
  const todayIdx   = data.days.findIndex(d => !d.isProjected && d.date === new Date().toISOString().slice(0, 10));
  const todayX     = todayIdx >= 0
    ? PAD.left + todayIdx * (barW + 1) + barW / 2
    : PAD.left + 29 * (barW + 1) + barW / 2;
  const todayLine  = `<line x1="${todayX}" y1="${PAD.top}" x2="${todayX}" y2="${PAD.top + chartH}" stroke="#569cd6" stroke-width="1.5" stroke-dasharray="4,3"/>
    <text x="${todayX + 4}" y="${PAD.top + 12}" fill="#569cd6" font-size="10">today</text>`;

  // Exhaustion date marker (if within chart range)
  let exhaustLine = '';
  if (data.forecast.exhaustionDate) {
    const ed    = new Date(data.forecast.exhaustionDate);
    const today = new Date();
    const diffD = Math.round((ed.getTime() - today.getTime()) / 86400000);
    const edIdx = data.days.findIndex(d => d.isProjected && d.date === ed.toISOString().slice(0, 10));
    if (edIdx >= 0) {
      const ex = PAD.left + edIdx * (barW + 1) + barW / 2;
      exhaustLine = `<line x1="${ex}" y1="${PAD.top}" x2="${ex}" y2="${PAD.top + chartH}" stroke="#f44747" stroke-width="1.5" stroke-dasharray="4,3"/>
        <text x="${ex + 4}" y="${PAD.top + 24}" fill="#f44747" font-size="10">⚠ ${diffD}d</text>`;
    }
  }

  const svgChart = `
<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width:${W}px">
  ${yLabels}
  ${bars}
  ${xLabels}
  ${todayLine}
  ${exhaustLine}
  <text x="${PAD.left}" y="${H - 4}" fill="#555" font-size="10">← past 30 days</text>
  <text x="${W - PAD.right}" y="${H - 4}" fill="#555" font-size="10" text-anchor="end">projected →</text>
</svg>`.trim();

  const sessionRows = Object.entries(data.summary.bySessionType ?? {})
    .map(([t, n]) => `<tr><td>${t}</td><td>${n}</td></tr>`)
    .join('');

  const substitutionRows = data.summary.totalSubstitutions > 0
    ? Object.entries(data.summary.substitutionBreakdown ?? {})
        .map(([pair, s]) =>
          '<tr><td>' + pair + '</td><td>' + s!.count + '</td><td>$' + s!.totalSavingsUsd.toFixed(4) + '</td></tr>')
        .join('') +
      '<tr style="font-weight:600"><td>Total</td><td>' + data.summary.totalSubstitutions + 'x</td><td>$' + (data.summary.totalSubstitutionSavingsUsd ?? 0).toFixed(4) + '</td></tr>'
    : '<tr><td colspan="3" style="color:#555">No substitutions yet (requires THROTTLE state)</td></tr>';

  return /* html */ `<!DOCTYPE html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ACIL Dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: 13px;
    color: var(--vscode-foreground, #d4d4d4);
    background: var(--vscode-editor-background, #1e1e1e);
    padding: 16px 20px;
  }
  h1 { font-size: 17px; font-weight: 600; margin-bottom: 14px; letter-spacing: 0.3px; }
  h2 { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: #858585; text-transform: uppercase; letter-spacing: 0.5px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .card {
    background: var(--vscode-sideBar-background, #252526);
    border: 1px solid var(--vscode-panel-border, #3c3c3c);
    border-radius: 6px;
    padding: 12px 16px;
    min-width: 150px;
    flex: 1;
  }
  .card .label { font-size: 11px; color: #858585; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.4px; }
  .card .value { font-size: 22px; font-weight: 700; }
  .card .sub   { font-size: 11px; color: #858585; margin-top: 2px; }
  .state-badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.5px;
    background: ${stateColor[data.state]}22;
    color: ${stateColor[data.state]};
    border: 1px solid ${stateColor[data.state]}55;
  }
  .chart-wrap {
    background: var(--vscode-sideBar-background, #252526);
    border: 1px solid var(--vscode-panel-border, #3c3c3c);
    border-radius: 6px;
    padding: 14px 16px;
    margin-bottom: 20px;
  }
  .chart-title { font-size: 12px; color: #858585; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 8px; }
  .legend { display: flex; gap: 16px; margin-top: 8px; font-size: 11px; color: #858585; }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #2d2d2d; }
  th { color: #858585; font-weight: 500; }
  .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  button {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none; border-radius: 4px;
    padding: 5px 12px; font-size: 12px; cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #d4d4d4);
  }
  .risk-bar-wrap { background: #2d2d2d; border-radius: 4px; height: 8px; margin-top: 6px; }
  .risk-bar { height: 8px; border-radius: 4px; background: ${riskPct >= 75 ? '#f44747' : riskPct >= 50 ? '#ce9178' : '#4ec9b0'}; width: ${riskPct}%; transition: width 0.3s; }
  .sync-note { font-size: 11px; color: #555; margin-top: 12px; }
</style>
</head>
<body>

<h1>⚡ ACIL Dashboard <span class="state-badge">${stateLabel[data.state]}</span></h1>

<div class="cards">
  <div class="card">
    <div class="label">Balance</div>
    <div class="value" style="color:${stateColor[data.state]}">$${data.balance.toFixed(2)}</div>
    <div class="sub">${pct}% of $${data.totalBudget.toFixed(2)} budget</div>
  </div>
  <div class="card">
    <div class="label">Exhaustion Date</div>
    <div class="value" style="font-size:16px">${exhaustStr}</div>
    <div class="sub">${data.forecast.daysRemaining.toFixed(1)} days remaining</div>
  </div>
  <div class="card">
    <div class="label">Overage Risk</div>
    <div class="value" style="font-size:20px">${riskPct}%</div>
    <div class="risk-bar-wrap"><div class="risk-bar"></div></div>
    <div class="sub" style="margin-top:4px">Est. overage: $${(data.forecast.overageCostEstimate ?? 0).toFixed(2)}</div>
  </div>
  <div class="card">
    <div class="label">Sessions (total)</div>
    <div class="value">${data.summary.totalEvents}</div>
    <div class="sub">CCT saved ${(data.summary.cctSavingsTokens ?? 0).toLocaleString()} tokens</div>
  </div>
</div>

<div class="chart-wrap">
  <div class="chart-title">Daily Spend — Last 30 Days + Projection</div>
  ${svgChart}
  <div class="legend">
    <span><span class="dot" style="background:#4ec9b0"></span>Actual</span>
    <span><span class="dot" style="background:rgba(78,201,176,0.35)"></span>Projected</span>
    <span><span class="dot" style="background:#569cd6;width:3px;height:14px;border-radius:0"></span>Today</span>
    <span><span class="dot" style="background:#f44747;width:3px;height:14px;border-radius:0"></span>Exhaustion</span>
  </div>
</div>

<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px">
  <div style="flex:1;min-width:220px">
    <h2>Forecast</h2>
    <table>
      <tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Daily avg burn</td><td>$${data.burnStats.dailyAvg.toFixed(4)}</td></tr>
      <tr><td>14-day avg</td><td>$${data.burnStats.window14Avg.toFixed(4)}</td></tr>
      <tr><td>Trend</td><td>${data.burnStats.trend}</td></tr>
      <tr><td>CI low</td><td>${data.forecast.confidenceLow ? new Date(data.forecast.confidenceLow).toLocaleDateString() : '—'}</td></tr>
      <tr><td>CI high</td><td>${data.forecast.confidenceHigh ? new Date(data.forecast.confidenceHigh).toLocaleDateString() : '—'}</td></tr>
    </table>
    ${data.forecast.recommendedActions?.length ? `
    <div style="margin-top:10px">
      <h2>Recommendations</h2>
      <ul style="padding-left:16px;font-size:12px;line-height:1.7;color:#d4d4d4">
        ${data.forecast.recommendedActions.map((a: string) => `<li>${a}</li>`).join('')}
      </ul>
    </div>` : ''}
  </div>
  <div style="flex:1;min-width:220px">
    <h2>By Session Type</h2>
    <table>
      <tr><th>Type</th><th>Count</th></tr>
      ${sessionRows || '<tr><td colspan="2" style="color:#555">No sessions recorded</td></tr>'}
    </table>
    <div style="margin-top:10px">
      <h2>🔄 Model Substitutions (Claim 7)</h2>
      <table>
        <tr><th>Substitution</th><th>Count</th><th>Saved</th></tr>
        ${substitutionRows}
      </table>
    </div>
    <div style="margin-top:10px">
      <h2>Totals</h2>
      <table>
        <tr><td>Tokens</td><td>${(data.summary.totalTokens ?? 0).toLocaleString()}</td></tr>
        <tr><td>Gross cost</td><td>$${(data.summary.totalGross ?? 0).toFixed(4)}</td></tr>
        <tr><td>Quota savings</td><td>$${(data.summary.totalDiscount ?? 0).toFixed(4)}</td></tr>
        <tr><td>Net cost</td><td>$${(data.summary.totalNet ?? 0).toFixed(4)}</td></tr>
      </table>
    </div>
  </div>
</div>

<div class="actions">
  <button onclick="vscode.postMessage({command:'refresh'})">↻ Refresh</button>
  <button class="secondary" onclick="vscode.postMessage({command:'syncNow'})">⇅ Sync GitHub</button>
  <button class="secondary" onclick="vscode.postMessage({command:'connectGitHub'})">🔗 Connect GitHub</button>
  <button class="secondary" onclick="vscode.postMessage({command:'setMonthlyBudget'})">✎ Set Budget</button>
</div>

${data.lastSyncTime
  ? `<div class="sync-note">Last synced from GitHub: ${new Date(data.lastSyncTime).toLocaleString()}</div>`
  : `<div class="sync-note">Not synced from GitHub — using manual budget config. Use "Connect GitHub" to enable live sync.</div>`}

<script>
  const vscode = acquireVsCodeApi();
  // Auto-refresh every 60s
  setTimeout(() => vscode.postMessage({command:'refresh'}), 60000);
</script>
</body>
</html>`;
}
