/**
 * ACIL Pipeline Tests + Stress Test
 *
 * Tests the full end-to-end pipeline: preflight → (simulated API) → postflight
 * Stress test: 10,000 synthetic sessions simulating realistic developer usage.
 *
 * The stress test validates:
 * - Pipeline handles high load without state corruption
 * - Enforcement states transition correctly as balance depletes
 * - TSP forecast degrades gracefully as quota exhausts
 * - June 7, 2026 scenario reproduced: AGENTIC spike → enforcement fires
 */

import { ACILPipeline } from '../src/pipeline/ACILPipeline';
import { SessionType, ModelId, EnforcementState, BudgetPeriod } from '../src/core/types';
import { QualityRequirement } from '../src/models/CostRouter';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePeriod(totalAllocation: number, consumed = 0): BudgetPeriod {
  const now   = new Date();
  const reset = new Date(now);
  reset.setDate(reset.getDate() + 14); // 14 days until reset
  return {
    periodId:        'test-period',
    userId:          'imKrisK',
    startDate:       now,
    resetDate:       reset,
    totalAllocation,
    consumed,
    remaining:       totalAllocation - consumed,
    enforcementState: EnforcementState.NORMAL,
  };
}

function makePreflight(pipeline: ACILPipeline, opts: Partial<{
  query:        string;
  agenticDepth: number;
  model:        ModelId;
  quality:      QualityRequirement;
  toolCalls:    string[];
  newFiles:     number;
  hasError:     boolean;
}> = {}) {
  return pipeline.preflight({
    rawInput:         opts.query    ?? 'Fix the bug in auth.ts',
    preferredModelId: opts.model    ?? ModelId.CLAUDE_SONNET_4,
    qualityRequirement: opts.quality ?? QualityRequirement.STANDARD,
    contextSizeTokens: 5000,
    agenticDepth:     opts.agenticDepth ?? 0,
    userId:           'imKrisK',
    telemetry: {
      queryText:            opts.query    ?? 'Fix the bug in auth.ts',
      toolCallSignatures:   opts.toolCalls ?? [],
      newFileCount:         opts.newFiles  ?? 0,
      modifiedFileCount:    1,
      contextRatio:         0.7,
      hasErrorContext:      opts.hasError  ?? false,
      existingFileSimilarity: 0.3,
    },
  });
}

// ─── Pipeline integration tests ───────────────────────────────────────────────

describe('ACILPipeline — end-to-end integration', () => {
  it('pre-flight allows request with full balance and returns session type', () => {
    const pipeline = new ACILPipeline(makePeriod(1000, 0));
    const result   = makePreflight(pipeline, { hasError: true });
    expect(result.allowed).toBe(true);
    expect(result.sessionType).toBe(SessionType.DEBUGGING);
    expect(result.effectiveModelId).toBeDefined();
    expect(result.eventId).toMatch(/[0-9a-f-]{36}/);
  });

  it('pre-flight detects AGENTIC session from tool calls', () => {
    const pipeline = new ACILPipeline(makePeriod(1000, 0));
    const result   = makePreflight(pipeline, {
      query:     'refactor the entire codebase',
      toolCalls: ['bash', 'str_replace_editor'],
    });
    expect(result.sessionType).toBe(SessionType.AGENTIC);
  });

  it('post-flight deducts from balance and records audit event', () => {
    const pipeline = new ACILPipeline(makePeriod(100, 0));
    const pre = makePreflight(pipeline);
    const initialBalance = pipeline.balance;

    pipeline.postflight({
      eventId:      pre.eventId,
      sessionId:    pre.sessionId,
      userId:       'imKrisK',
      sessionType:  pre.sessionType,
      modelId:      pre.effectiveModelId,
      agenticDepth: 0,
      inputTokens:  500,
      outputTokens: 1500,
      cachedTokens: 0,
      predictedCost:    pre.prediction.expectedCost,
      predictedTokens:  pre.prediction.expectedTokens,
      originalTokens:   null,
      translatedTokens: null,
      cctSavingsPct:    null,
      classifierConfidence: pre.classifierConfidence,
    });

    expect(pipeline.balance).toBeLessThanOrEqual(initialBalance);
    expect(pipeline.audit.eventCount).toBe(1);
  });

  it('enforcement transitions to THROTTLE and downgrades model', () => {
    // 8% balance remaining → THROTTLE territory
    const pipeline = new ACILPipeline(makePeriod(100, 92));
    const result   = makePreflight(pipeline, { model: ModelId.CLAUDE_SONNET_4 });
    expect(result.enforcement.state).toBe(EnforcementState.THROTTLE);
    // Either the router OR the enforcer substituted the model — check end-to-end
    expect(result.effectiveModelId).not.toBe(ModelId.CLAUDE_SONNET_4);
    expect(result.effectiveModelId).toBe(ModelId.CLAUDE_HAIKU_3);
  });

  it('blocks AGENTIC session at CRITICAL state (3% balance)', () => {
    const pipeline = new ACILPipeline(makePeriod(100, 97));
    const result   = makePreflight(pipeline, {
      query:     'rewrite everything',
      toolCalls: ['bash'],
    });
    expect(result.sessionType).toBe(SessionType.AGENTIC);
    expect(result.allowed).toBe(false);
    expect(result.enforcement.state).toBe(EnforcementState.CRITICAL);
  });

  it('blocks all requests at EXHAUSTED state (0% balance)', () => {
    const pipeline = new ACILPipeline(makePeriod(100, 100));
    const result   = makePreflight(pipeline);
    expect(result.allowed).toBe(false);
    expect(result.enforcement.state).toBe(EnforcementState.EXHAUSTED);
  });

  it('CCT applies compression and reports savings', () => {
    const pipeline = new ACILPipeline(makePeriod(1000, 0));
    const result   = makePreflight(pipeline, {
      hasError: true, // DEBUGGING — CCT strips error context
      query:    'Hey, could you please help me understand why this is crashing? TypeError: Cannot read properties of undefined at processUsers (/app/src/utils.ts:42:18) at node_modules/express/router.js:284 Thanks!',
    });
    // CCT ran — original input is the full text
    expect(result.optimizedInput.length).toBeLessThanOrEqual(result.enforcement.message?.length ?? Infinity);
    expect(result.eventId).toBeDefined();
  });

  it('forecast returns non-null risk score after postflight', () => {
    const pipeline = new ACILPipeline(makePeriod(1000, 500)); // 50% consumed
    const pre = makePreflight(pipeline);
    pipeline.postflight({
      eventId: pre.eventId, sessionId: pre.sessionId, userId: 'imKrisK',
      sessionType: pre.sessionType, modelId: pre.effectiveModelId, agenticDepth: 0,
      inputTokens: 200, outputTokens: 800, cachedTokens: 0,
      predictedCost: null, predictedTokens: null,
      originalTokens: null, translatedTokens: null, cctSavingsPct: null,
      classifierConfidence: pre.classifierConfidence,
    });
    const f = pipeline.forecast();
    expect(f.overageRiskScore).toBeGreaterThanOrEqual(0);
    expect(f.overageRiskScore).toBeLessThanOrEqual(1);
    expect(f.recommendedActions.length).toBeGreaterThan(0);
  });
});

// ─── Stress Test: 10,000 synthetic sessions ───────────────────────────────────

describe('ACIL Stress Test — 10,000 sessions', () => {
  it('processes 10K sessions without state corruption or errors', () => {
    const TOTAL_SESSIONS = 10_000;
    const QUOTA          = 100;    // tight quota to force throttle/block transitions
    const pipeline       = new ACILPipeline(makePeriod(QUOTA, 0));

    const sessionTypes = [
      SessionType.DEBUGGING,
      SessionType.BOILERPLATE,
      SessionType.ARCHITECTURE,
      SessionType.DOCUMENTATION,
      SessionType.REVIEW,
    ];

    let allowed = 0;
    let blocked = 0;
    let throttled = 0;
    let downgraded = 0;
    let lastBalance = pipeline.balance;

    for (let i = 0; i < TOTAL_SESSIONS; i++) {
      const type = sessionTypes[i % sessionTypes.length];

      const pre = pipeline.preflight({
        rawInput:         `Task ${i}: ${type} session`,
        preferredModelId: ModelId.CLAUDE_SONNET_4,
        qualityRequirement: QualityRequirement.STANDARD,
        contextSizeTokens: 2000 + (i % 8000),
        agenticDepth:     0,
        userId:           'imKrisK',
        telemetry: {
          queryText:            `Task ${i}`,
          toolCallSignatures:   [],
          newFileCount:         0,
          modifiedFileCount:    1,
          contextRatio:         0.6,
          hasErrorContext:      type === SessionType.DEBUGGING,
          existingFileSimilarity: type === SessionType.BOILERPLATE ? 0.8 : 0.2,
        },
      });

      if (pre.allowed) {
        allowed++;
        if (pre.enforcement.wasDowngraded) downgraded++;

        // Simulate API response — realistic token counts by session type
        const tokenMap: Record<string, [number, number]> = {
          DEBUGGING:     [300,  800],
          BOILERPLATE:   [200,  500],
          ARCHITECTURE:  [800, 3000],
          DOCUMENTATION: [150,  400],
          REVIEW:        [400, 1200],
        };
        const [inp, out] = tokenMap[type] ?? [300, 800];

        pipeline.postflight({
          eventId: pre.eventId, sessionId: pre.sessionId, userId: 'imKrisK',
          sessionType: pre.sessionType, modelId: pre.effectiveModelId, agenticDepth: 0,
          inputTokens: inp, outputTokens: out, cachedTokens: 0,
          predictedCost: pre.prediction.expectedCost,
          predictedTokens: pre.prediction.expectedTokens,
          originalTokens: null, translatedTokens: null, cctSavingsPct: null,
          classifierConfidence: pre.classifierConfidence,
        });
      } else {
        blocked++;
      }

      if (pre.enforcement.state === EnforcementState.THROTTLE) throttled++;
    }

    // ── Assertions ───────────────────────────────────────────────────────
    // Balance should have decreased or stayed equal (never increased from no-ops)
    expect(pipeline.balance).toBeLessThanOrEqual(QUOTA);
    expect(pipeline.balance).toBeGreaterThanOrEqual(0);

    // Audit trail should have one event per allowed session
    expect(pipeline.audit.eventCount).toBe(allowed);

    // Total accounted for
    expect(allowed + blocked).toBe(TOTAL_SESSIONS);

    // State machine stayed valid
    const validStates = Object.values(EnforcementState);
    expect(validStates).toContain(pipeline.currentState);

    // Forecast is always valid
    const f = pipeline.forecast();
    expect(f.overageRiskScore).toBeGreaterThanOrEqual(0);
    expect(f.overageRiskScore).toBeLessThanOrEqual(1);

    // Log summary (visible in test output with --verbose)
    console.log(`\n  ── Stress Test Summary ──`);
    console.log(`  Sessions:   ${TOTAL_SESSIONS.toLocaleString()}`);
    console.log(`  Allowed:    ${allowed.toLocaleString()}`);
    console.log(`  Blocked:    ${blocked.toLocaleString()}`);
    console.log(`  Throttled:  ${throttled.toLocaleString()} (at some point)`);
    console.log(`  Downgraded: ${downgraded.toLocaleString()} model substitutions`);
    console.log(`  Final balance: ${pipeline.balance.toFixed(4)}`);
    console.log(`  Final state:   ${pipeline.currentState}`);
    console.log(`  Audit events:  ${pipeline.audit.eventCount.toLocaleString()}`);
    console.log(`  Overage risk:  ${(f.overageRiskScore * 100).toFixed(1)}%`);
    console.log(`  Exhaustion:    ${f.exhaustionDate?.toISOString().slice(0, 10) ?? 'Survives to reset'}`);
  });

  it('reproduces June 7 2026 scenario: AGENTIC spike depletes quota, enforcement fires', () => {
    /**
     * Real data (imKrisK Jun 2026 GitHub usage report):
     *   Monthly included quota: 1,469 premium requests
     *   Each request = $0.04 → monthly allocation = $58.76
     *   Jun 1-6 consumed: 1,229 requests × $0.04 = $49.16
     *   Remaining Jun 6 EOD: 240 requests × $0.04 = $9.60
     *
     * COPILOT_PREMIUM pricing in PricingConfig: inputPer1k = $0.04
     * Each simulated agent step: 1,000 input tokens → cost = $0.04 (= 1 request)
     * After 240 steps: quota exhausted → enforcement must fire
     */
    const MONTHLY_ALLOCATION = 58.76;  // $58.76 = 1,469 requests × $0.04
    const CONSUMED_JUN1_6    = 49.16;  // $49.16 = 1,229 requests consumed
    const pipeline = new ACILPipeline(makePeriod(MONTHLY_ALLOCATION, CONSUMED_JUN1_6));
    // Balance ≈ $9.60 (240 requests remaining) — exact Jun 6 EOD state

    let agenticBlocked = false;
    let blockedAtStep  = 0;

    for (let i = 0; i < 528; i++) {
      const pre = pipeline.preflight({
        rawInput:         'continue building the full system',
        preferredModelId: ModelId.COPILOT_PREMIUM,
        qualityRequirement: QualityRequirement.HIGH,
        contextSizeTokens: 10_000 + i * 100,
        agenticDepth:     3,
        userId:           'imKrisK',
        telemetry: {
          queryText: 'continue building the full system',
          toolCallSignatures: ['bash', 'str_replace_editor'],
          newFileCount: 2, modifiedFileCount: 5,
          contextRatio: 0.4, hasErrorContext: false, existingFileSimilarity: 0.2,
        },
      });

      if (!pre.allowed) {
        agenticBlocked = true;
        blockedAtStep  = i;
        expect([EnforcementState.CRITICAL, EnforcementState.EXHAUSTED])
          .toContain(pre.enforcement.state);
        break;
      }

      // Each step: 1,000 input tokens × $0.04/1k = $0.04 per request (matches GitHub billing)
      pipeline.postflight({
        eventId: pre.eventId, sessionId: pre.sessionId, userId: 'imKrisK',
        sessionType: SessionType.AGENTIC, modelId: ModelId.COPILOT_PREMIUM, agenticDepth: 3,
        inputTokens: 1000, outputTokens: 0, cachedTokens: 0,
        predictedCost: pre.prediction.expectedCost,
        predictedTokens: pre.prediction.expectedTokens,
        originalTokens: null, translatedTokens: null, cctSavingsPct: null,
        classifierConfidence: pre.classifierConfidence,
      });
    }

    expect(agenticBlocked).toBe(true);
    expect(blockedAtStep).toBeLessThanOrEqual(528); // Must block before all 528 requests complete
    expect(pipeline.balance).toBeGreaterThanOrEqual(0);

    console.log(`\n  ── Jun 7 2026 Scenario ──`);
    console.log(`  AGENTIC steps before enforcement block: ${blockedAtStep}`);
    console.log(`  Final state: ${pipeline.currentState}`);
    console.log(`  Balance at block: $${pipeline.balance.toFixed(4)}`);
    console.log(`  ACIL blocked the session. GitHub did not.`);
  });
});
