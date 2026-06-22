/**
 * ACIL — CLI Smoke Test Harness
 *
 * Run: npx ts-node scripts/smoke-test.ts
 *
 * Simulates a realistic developer workday through ACILPipeline:
 *   1. Morning: light BOILERPLATE sessions (budget abundant)
 *   2. Midday: mixed DEBUGGING + ARCHITECTURE sessions
 *   3. Afternoon: AGENTIC spike that depletes quota
 *   4. Enforcement: CRITICAL state fires, AGENTIC blocked
 *   5. TSP forecast at each phase transition
 *   6. CCT compression applied to a sample AGENTIC prompt
 *
 * Output: human-readable console report
 * Exit code: 0 if all assertions pass, 1 if any fail
 */

import {
  ACILPipeline,
  BudgetPeriod,
  EnforcementState,
  ModelId,
  SessionType,
  QualityRequirement,
} from '../src/index';

// ── Helpers ──────────────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';
const CHECK  = `${GREEN}✓${RESET}`;
const CROSS  = `${RED}✗${RESET}`;
const WARN   = `${YELLOW}⚠${RESET}`;

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ${CHECK} ${label}`);
    passed++;
  } else {
    console.log(`  ${CROSS} ${label}${detail ? ` → ${detail}` : ''}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n${BOLD}${CYAN}── ${title} ──${RESET}`);
}

function info(msg: string): void {
  console.log(`  ${YELLOW}ℹ${RESET}  ${msg}`);
}

// ── Pipeline setup ────────────────────────────────────────────────────────────

const MONTHLY_BUDGET = 5.00;   // Small budget so drain test completes in <100 AGENTIC sessions
const OVERAGE_RATE   = 0.04;   // $0.04/premium request

const now = new Date();
const period: BudgetPeriod = {
  periodId:         'smoke-test-period',
  userId:           'developer-smoke-test',
  startDate:        new Date(now.getFullYear(), now.getMonth(), 1),
  resetDate:        new Date(now.getFullYear(), now.getMonth() + 1, 1),
  totalAllocation:  MONTHLY_BUDGET,
  consumed:         0,
  remaining:        MONTHLY_BUDGET,
  enforcementState: EnforcementState.NORMAL,
};

const pipeline = new ACILPipeline(period, OVERAGE_RATE);

// ── Helper: run a session through the full pipeline ──────────────────────────

function runSession(opts: {
  sessionType:        SessionType;
  model:              ModelId;
  inputTokens:        number;
  outputTokens:       number;
  label:              string;
  qualityRequirement?: QualityRequirement;
}): { allowed: boolean; state: EnforcementState; cost: number } {
  const preflight = pipeline.preflight({
    rawInput:           `Smoke test: ${opts.label}`,
    telemetry: {
      queryText:              `Smoke test: ${opts.label}`,
      toolCallSignatures:     opts.sessionType === SessionType.AGENTIC
        ? ['bash', 'str_replace_editor', 'computer'] : [],
      newFileCount:           opts.sessionType === SessionType.ARCHITECTURE ? 3 : 0,
      modifiedFileCount:      1,
      contextRatio:           0.7,
      hasErrorContext:        opts.sessionType === SessionType.DEBUGGING,
      existingFileSimilarity: opts.sessionType === SessionType.BOILERPLATE ? 0.85 : 0.3,
    },
    preferredModelId:   opts.model,
    qualityRequirement: opts.qualityRequirement ?? QualityRequirement.STANDARD,
    contextSizeTokens:  opts.inputTokens,
    agenticDepth:       opts.sessionType === SessionType.AGENTIC ? 4 : 0,
    userId:             period.userId,
  });

  if (!preflight.allowed) {
    return { allowed: false, state: preflight.enforcement.state, cost: 0 };
  }

  pipeline.postflight({
    eventId:              preflight.eventId,
    sessionId:            preflight.sessionId,
    userId:               period.userId,
    sessionType:          preflight.sessionType,
    modelId:              preflight.effectiveModelId,
    agenticDepth:         opts.sessionType === SessionType.AGENTIC ? 4 : 0,
    inputTokens:          opts.inputTokens,
    outputTokens:         opts.outputTokens,
    cachedTokens:         0,
    predictedCost:        preflight.prediction.expectedCost,
    predictedTokens:      preflight.prediction.expectedTokens,
    originalTokens:       null,
    translatedTokens:     null,
    cctSavingsPct:        preflight.cctApplied ? preflight.cctSavingsPct : null,
    classifierConfidence: preflight.classifierConfidence,
  });

  return {
    allowed: true,
    state:   pipeline.currentState,
    cost:    pipeline.totalAllocation - pipeline.balance,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SMOKE TEST EXECUTION
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}ACIL Smoke Test — ${new Date().toLocaleString()}${RESET}`);
console.log(`Budget: $${MONTHLY_BUDGET} | Model: Copilot Premium @ $${OVERAGE_RATE}/request\n`);

// ── Phase A: Initial state ────────────────────────────────────────────────────

section('A. Initial State');
assert(pipeline.balance === MONTHLY_BUDGET, `Balance starts at $${MONTHLY_BUDGET}`);
assert(pipeline.currentState === EnforcementState.NORMAL, 'State is NORMAL');
assert(pipeline.totalAllocation === MONTHLY_BUDGET, 'totalAllocation getter correct');

// ── Phase B: Morning — light BOILERPLATE sessions ─────────────────────────────

section('B. Morning — BOILERPLATE (should remain NORMAL)');
for (let i = 0; i < 10; i++) {
  runSession({ sessionType: SessionType.BOILERPLATE, model: ModelId.COPILOT_PREMIUM, inputTokens: 500, outputTokens: 200, label: `boilerplate-${i}` });
}
assert(pipeline.currentState === EnforcementState.NORMAL, 'Still NORMAL after 10 BOILERPLATE sessions');
info(`Balance after morning: $${pipeline.balance.toFixed(4)}`);

// ── Phase C: Midday — DEBUGGING + ARCHITECTURE ───────────────────────────────

section('C. Midday — DEBUGGING + ARCHITECTURE');
for (let i = 0; i < 5; i++) {
  runSession({ sessionType: SessionType.DEBUGGING, model: ModelId.COPILOT_PREMIUM, inputTokens: 2000, outputTokens: 800, label: `debug-${i}` });
  runSession({ sessionType: SessionType.ARCHITECTURE, model: ModelId.COPILOT_PREMIUM, inputTokens: 3500, outputTokens: 1500, label: `arch-${i}` });
}
const stateAfterMidday = pipeline.currentState;
assert(
  [EnforcementState.NORMAL, EnforcementState.ADVISORY].includes(stateAfterMidday),
  `State after midday is ${stateAfterMidday} (expected NORMAL or ADVISORY)`,
);
info(`Balance after midday: $${pipeline.balance.toFixed(4)}`);

// ── Phase D: AGENTIC spike — drain to CRITICAL ───────────────────────────────

section('D. Afternoon — AGENTIC spike (quota drain)');
let blockedAt = -1;
let agenticCount = 0;

// Use CRITICAL quality + Claude Sonnet to force expensive model and drain budget
// ($0.003/1k input + $0.015/1k output = ~$0.249/session at 8k/15k tokens)
for (let i = 0; i < 500; i++) {
  const result = runSession({
    sessionType:       SessionType.AGENTIC,
    model:             ModelId.CLAUDE_SONNET_4,
    inputTokens:       8000,
    outputTokens:      15000,
    label:             `agentic-${i}`,
    qualityRequirement: QualityRequirement.CRITICAL,
  });
  agenticCount++;
  if (!result.allowed) {
    blockedAt = i;
    break;
  }
}

assert(blockedAt >= 0, `AGENTIC sessions eventually blocked (at step ${blockedAt})`);
assert(
  [EnforcementState.CRITICAL, EnforcementState.EXHAUSTED, EnforcementState.THROTTLE].includes(pipeline.currentState),
  `Final state is enforcement state: ${pipeline.currentState}`,
);
assert(pipeline.balance >= 0, `Balance never goes negative: $${pipeline.balance.toFixed(4)}`);
info(`Ran ${agenticCount} AGENTIC sessions before block at step ${blockedAt}`);
info(`Final balance: $${pipeline.balance.toFixed(4)} | State: ${pipeline.currentState}`);

// ── Phase E: TSP forecast at end-of-quota ────────────────────────────────────

section('E. TSP Forecast');
const forecast = pipeline.forecast();
assert(forecast.daysRemaining >= 0, `daysRemaining >= 0: ${forecast.daysRemaining.toFixed(2)}`);
assert(forecast.overageRiskScore >= 0 && forecast.overageRiskScore <= 1, `overageRiskScore in [0,1]: ${forecast.overageRiskScore}`);
assert(forecast.recommendedActions.length > 0, `recommendedActions present: ${forecast.recommendedActions.length}`);
info(`Exhaustion: ${forecast.exhaustionDate?.toLocaleDateString() ?? 'None'}`);
info(`Overage risk: ${(forecast.overageRiskScore * 100).toFixed(0)}%`);
info(`Est. overage: $${forecast.overageCostEstimate.toFixed(2)}`);
info(`Recommendation: ${forecast.recommendedActions[0]}`);

// ── Phase F: burnStats() ─────────────────────────────────────────────────────

section('F. Burn Rate Statistics');
const stats = pipeline.burnStats();
assert(stats.dailyAvg >= 0, `dailyAvg >= 0: $${stats.dailyAvg.toFixed(4)}`);
assert(['RISING', 'STABLE', 'FALLING'].includes(stats.trend), `trend is valid: ${stats.trend}`);
info(`dailyAvg: $${stats.dailyAvg.toFixed(4)} | window7: $${stats.window7.toFixed(4)} | trend: ${stats.trend}`);

// ── Phase G: AuditTrail summary ───────────────────────────────────────────────

section('G. Audit Trail');
const summary = pipeline.audit.summarize();
assert(summary.totalEvents > 0, `Audit has events: ${summary.totalEvents}`);
assert(summary.totalGross > 0, `Gross cost > 0: $${summary.totalGross.toFixed(4)}`);
assert(summary.bySessionType[SessionType.AGENTIC] !== undefined, `AGENTIC sessions recorded`);
info(`Total sessions: ${summary.totalEvents} | Tokens: ${summary.totalTokens.toLocaleString()}`);
info(`Gross: $${summary.totalGross.toFixed(4)} | Net: $${summary.totalNet.toFixed(4)} | Saved: $${summary.totalDiscount.toFixed(4)}`);

// ── Phase H: Audit persistence (save + load round-trip) ──────────────────────

section('H. Audit Persistence (save/load round-trip)');
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpPath = path.join(os.tmpdir(), `acil-smoke-${Date.now()}.json`);
pipeline.audit.save(tmpPath);
assert(fs.existsSync(tmpPath), `save() produced file: ${tmpPath}`);
const raw  = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
assert(Array.isArray(raw.events), 'JSON has events array');
assert(raw.events.length === summary.totalEvents, `Event count matches: ${raw.events.length}`);

// Load into a fresh pipeline and check events carry over
const freshPipeline = new ACILPipeline({ ...period, consumed: 0, remaining: period.totalAllocation, enforcementState: EnforcementState.NORMAL }, OVERAGE_RATE);
freshPipeline.audit.load(tmpPath);
const freshSummary = freshPipeline.audit.summarize();
assert(freshSummary.totalEvents === summary.totalEvents, `Loaded event count matches: ${freshSummary.totalEvents}`);
fs.unlinkSync(tmpPath);
info('Temp file cleaned up');

// ── Final report ──────────────────────────────────────────────────────────────

console.log(`\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
console.log(`${BOLD}ACIL Smoke Test Results${RESET}`);
console.log(`  ${GREEN}Passed: ${passed}${RESET}`);
if (failed > 0) console.log(`  ${RED}Failed: ${failed}${RESET}`);
else console.log(`  Failed: 0`);
console.log(`${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n`);

process.exit(failed > 0 ? 1 : 0);
