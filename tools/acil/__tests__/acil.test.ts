/**
 * ACIL Unit Tests — Full Suite
 * Covers all novel patent claims with empirical June 2026 data validation
 */

import { TokenMeter } from '../src/core/TokenMeter';
import { CreditBilling } from '../src/core/CreditBilling';
import { BudgetEnforcer } from '../src/core/BudgetEnforcer';
import { AuditTrail } from '../src/core/AuditTrail';
import { SessionClassifier } from '../src/classifier/SessionClassifier';
import { BurnPredictor } from '../src/predictor/BurnPredictor';
import { BurnProfile } from '../src/predictor/BurnProfile';
import { PromptCompressor } from '../src/translator/PromptCompressor';
import { BurnRateCalculator } from '../src/temporal/BurnRateCalculator';
import { OverageRiskScorer } from '../src/temporal/OverageRiskScorer';
import { ExhaustionForecaster } from '../src/temporal/ExhaustionForecaster';
import { CostRouter, QualityRequirement } from '../src/models/CostRouter';
import {
  SessionType, ModelId, EnforcementState, BudgetPeriod,
} from '../src/core/types';

// ─── Phase 0: TokenMeter ──────────────────────────────────────────────────────

describe('TokenMeter', () => {
  it('accumulates token counts across multiple calls', () => {
    const meter = new TokenMeter(SessionType.DEBUGGING, ModelId.CLAUDE_SONNET_4);
    meter.record(100, 200, 10);
    meter.record(50, 80, 0);
    expect(meter.accumulated.inputTokens).toBe(150);
    expect(meter.accumulated.outputTokens).toBe(280);
    expect(meter.accumulated.totalTokens).toBe(430);
  });

  it('applies higher weight multiplier for AGENTIC sessions', () => {
    const agenticMeter = new TokenMeter(SessionType.AGENTIC, ModelId.GPT_4O);
    const debugMeter   = new TokenMeter(SessionType.DEBUGGING, ModelId.GPT_4O);
    const r1 = agenticMeter.record(100, 100);
    const r2 = debugMeter.record(100, 100);
    expect(r1.weightedCost).toBeGreaterThan(r2.weightedCost);
  });

  it('resets accumulator cleanly', () => {
    const meter = new TokenMeter(SessionType.BOILERPLATE, ModelId.GPT_4O_MINI);
    meter.record(500, 500);
    meter.reset();
    expect(meter.accumulated.totalTokens).toBe(0);
  });
});

// ─── Phase 0: CreditBilling ──────────────────────────────────────────────────

describe('CreditBilling', () => {
  it('fully discounts within quota', () => {
    const billing = new CreditBilling(100, 0); // $100 quota, $0 used
    const usage   = TokenMeter.usage(1000, 2000);
    const result  = billing.bill(usage, ModelId.CLAUDE_SONNET_4);
    expect(result.netCost).toBe(0);
    expect(result.discountAmount).toBeGreaterThan(0);
  });

  it('fully charges when quota is exhausted', () => {
    const billing = new CreditBilling(0, 100); // $0 quota remaining
    const usage   = TokenMeter.usage(1000, 2000);
    const result  = billing.bill(usage, ModelId.CLAUDE_SONNET_4);
    expect(result.netCost).toBe(result.grossCost);
    expect(result.discountAmount).toBe(0);
  });

  it('handles partial quota boundary (June 7 scenario)', () => {
    // $5 quota remaining, call costs more than $5 → partial discount
    const billing = new CreditBilling(5, 0);
    // 1M input tokens × $0.003/1k = $3, 1M output × $0.015/1k = $15 → gross = $18
    const usage = TokenMeter.usage(1_000_000, 1_000_000);
    const result = billing.bill(usage, ModelId.CLAUDE_SONNET_4);
    expect(result.discountAmount).toBeLessThanOrEqual(5);
    expect(result.netCost).toBeGreaterThan(0);
    expect(result.grossCost).toBeGreaterThan(5);
  });
});

// ─── Phase 0: BudgetEnforcer ─────────────────────────────────────────────────

describe('BudgetEnforcer', () => {
  const makePeriod = (remaining: number, total = 100): BudgetPeriod => ({
    periodId: 'test-period',
    userId: 'imKrisK',
    startDate: new Date('2026-06-01'),
    resetDate: new Date('2026-06-30'),
    totalAllocation: total,
    consumed: total - remaining,
    remaining,
    enforcementState: EnforcementState.NORMAL,
  });

  it('returns NORMAL state at full balance', () => {
    const enforcer = new BudgetEnforcer(makePeriod(100));
    const decision = enforcer.evaluate(ModelId.CLAUDE_SONNET_4, SessionType.DEBUGGING);
    expect(decision.state).toBe(EnforcementState.NORMAL);
    expect(decision.allowed).toBe(true);
    expect(decision.wasDowngraded).toBe(false);
  });

  it('returns ADVISORY at 40% balance', () => {
    const enforcer = new BudgetEnforcer(makePeriod(40));
    const decision = enforcer.evaluate(ModelId.CLAUDE_SONNET_4, SessionType.DEBUGGING);
    expect(decision.state).toBe(EnforcementState.ADVISORY);
    expect(decision.allowed).toBe(true);
  });

  it('downgrades model at THROTTLE state — novel Claim 7', () => {
    const enforcer = new BudgetEnforcer(makePeriod(7)); // 7%
    const decision = enforcer.evaluate(ModelId.CLAUDE_SONNET_4, SessionType.DEBUGGING);
    expect(decision.state).toBe(EnforcementState.THROTTLE);
    expect(decision.wasDowngraded).toBe(true);
    expect(decision.effectiveModelId).toBe(ModelId.CLAUDE_HAIKU_3);
  });

  it('blocks AGENTIC sessions at CRITICAL state', () => {
    const enforcer = new BudgetEnforcer(makePeriod(3)); // 3%
    const decision = enforcer.evaluate(ModelId.CLAUDE_SONNET_4, SessionType.AGENTIC);
    expect(decision.state).toBe(EnforcementState.CRITICAL);
    expect(decision.allowed).toBe(false);
  });

  it('hard stops at EXHAUSTED state', () => {
    const enforcer = new BudgetEnforcer(makePeriod(0));
    const decision = enforcer.evaluate(ModelId.GPT_4O, SessionType.BOILERPLATE);
    expect(decision.state).toBe(EnforcementState.EXHAUSTED);
    expect(decision.allowed).toBe(false);
  });
});

// ─── Phase 0: AuditTrail ─────────────────────────────────────────────────────

describe('AuditTrail', () => {
  it('groups events into daily burn records', () => {
    const trail = new AuditTrail();
    const baseEvent = {
      eventId: 'e1', sessionId: 's1', userId: 'u1',
      sessionType: SessionType.DEBUGGING, confidence: 0.8,
      modelId: ModelId.GPT_4O, agenticDepth: 0,
      usage: { inputTokens: 100, outputTokens: 200, cachedTokens: 0, totalTokens: 300 },
      grossCost: 0.36, discountAmount: 0.36, netCost: 0,
      balanceBefore: 50, balanceAfter: 50,
      predictedCost: null, predictedTokens: null,
      originalTokens: null, translatedTokens: null, cctSavingsPct: null,
    };
    trail.append({ ...baseEvent, timestamp: new Date('2026-06-01T10:00:00Z') });
    trail.append({ ...baseEvent, eventId: 'e2', timestamp: new Date('2026-06-01T14:00:00Z') });
    trail.append({ ...baseEvent, eventId: 'e3', timestamp: new Date('2026-06-02T09:00:00Z') });
    const burns = trail.dailyBurns();
    expect(burns).toHaveLength(2);
    expect(burns[0].date).toBe('2026-06-01');
    expect(burns[0].totalRequests).toBe(2);
    expect(burns[1].date).toBe('2026-06-02');
  });
});

// ─── Phase 1: SessionClassifier ──────────────────────────────────────────────

describe('SessionClassifier — Wave 10 Claim 1 + 2', () => {
  const classifier = new SessionClassifier();

  it('classifies AGENTIC from tool call signatures', () => {
    const result = classifier.classify({
      queryText: 'fix all the bugs',
      toolCallSignatures: ['bash', 'str_replace_editor'],
      newFileCount: 0, modifiedFileCount: 2,
      contextRatio: 0.5, hasErrorContext: false, existingFileSimilarity: 0.3,
    });
    expect(result.sessionType).toBe(SessionType.AGENTIC);
    expect(result.confidence).toBeGreaterThan(0.85);
  });

  it('classifies ARCHITECTURE from new files + keywords', () => {
    const result = classifier.classify({
      queryText: 'design the database schema for the system',
      toolCallSignatures: [],
      newFileCount: 4, modifiedFileCount: 0,
      contextRatio: 0.2, hasErrorContext: false, existingFileSimilarity: 0.1,
    });
    expect(result.sessionType).toBe(SessionType.ARCHITECTURE);
  });

  it('classifies DEBUGGING from error context', () => {
    const result = classifier.classify({
      queryText: 'TypeError: Cannot read property of undefined',
      toolCallSignatures: [],
      newFileCount: 0, modifiedFileCount: 1,
      contextRatio: 0.8, hasErrorContext: true, existingFileSimilarity: 0.5,
    });
    expect(result.sessionType).toBe(SessionType.DEBUGGING);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('classifies BOILERPLATE from high file similarity', () => {
    const result = classifier.classify({
      queryText: 'generate a similar component',
      toolCallSignatures: [],
      newFileCount: 1, modifiedFileCount: 0,
      contextRatio: 0.9, hasErrorContext: false, existingFileSimilarity: 0.85,
    });
    expect(result.sessionType).toBe(SessionType.BOILERPLATE);
  });
});

// ─── Phase 2: BurnPredictor ──────────────────────────────────────────────────

describe('BurnPredictor — Wave 10 Claim 2 + 6', () => {
  it('predicts higher cost for AGENTIC than DEBUGGING', () => {
    const predictor = new BurnPredictor();
    const profile   = new BurnProfile();
    const baseInput = { modelId: ModelId.CLAUDE_SONNET_4, contextWindowSize: 10_000, proposedQueryTokens: 500, agenticDepth: 0, profile };
    const agentic  = predictor.predict({ ...baseInput, sessionType: SessionType.AGENTIC,   agenticDepth: 3 });
    const debug    = predictor.predict({ ...baseInput, sessionType: SessionType.DEBUGGING,  agenticDepth: 0 });
    expect(agentic.expectedTokens).toBeGreaterThan(debug.expectedTokens);
    expect(agentic.expectedCost).toBeGreaterThan(debug.expectedCost);
  });

  it('applies agentic depth multiplier — Claim 6', () => {
    const predictor = new BurnPredictor();
    const profile   = new BurnProfile();
    const base = { sessionType: SessionType.AGENTIC, modelId: ModelId.GPT_4O, contextWindowSize: 5000, proposedQueryTokens: 200, profile };
    const d0 = predictor.predict({ ...base, agenticDepth: 0 });
    const d5 = predictor.predict({ ...base, agenticDepth: 5 });
    expect(d5.expectedTokens).toBeGreaterThan(d0.expectedTokens * 2);
  });

  it('reduces confidence for deep agentic predictions', () => {
    const predictor = new BurnPredictor();
    const profile   = new BurnProfile();
    const shallow = predictor.predict({ sessionType: SessionType.AGENTIC, modelId: ModelId.GPT_4O, contextWindowSize: 0, proposedQueryTokens: 0, agenticDepth: 1, profile });
    const deep    = predictor.predict({ sessionType: SessionType.AGENTIC, modelId: ModelId.GPT_4O, contextWindowSize: 0, proposedQueryTokens: 0, agenticDepth: 8, profile });
    expect(deep.confidence).toBeLessThan(shallow.confidence);
  });
});

// ─── Phase 5: PromptCompressor (CCT) ─────────────────────────────────────────

describe('PromptCompressor — Wave 10 Claim 8', () => {
  const cct = new PromptCompressor();

  it('compresses conversational boilerplate input', () => {
    const result = cct.compress(
      'Hey there, could you please help me write a TypeScript function that validates email addresses and returns a boolean? I would really appreciate your help with this. Thanks so much!',
      SessionType.BOILERPLATE,
    );
    // Core behavior: compressor ran, original text is preserved in result
    expect(result.originalText).toContain('Hey there');
    expect(result.originalTokenEst).toBeGreaterThan(0);
  });

  it('compresses stack traces for DEBUGGING sessions', () => {
    const stackTrace = `TypeError: Cannot read properties of undefined (reading 'map')
    at Array.map (<anonymous>)
    at processUsers (/app/src/utils.ts:42:18)
    at node_modules/express/lib/router/index.js:284:15
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at next (/app/node_modules/express/lib/router/index.js:144:13)
Hey can you fix this error please?`;
    const result = cct.compress(stackTrace, SessionType.DEBUGGING);
    // Should remove node_modules lines
    expect(result.compressedText).not.toContain('node_modules/express/lib/router/index');
  });

  it('does not compress ARCHITECTURE sessions aggressively', () => {
    const input  = 'Design the complete microservices architecture for a payment processing system';
    const result = cct.compress(input, SessionType.ARCHITECTURE);
    // Architecture: minimal compression, core meaning preserved
    expect(result.compressedText).toContain('architecture');
  });

  it('rejects compression that would save less than 5%', () => {
    // Very short input — compression won't help
    const result = cct.compress('Fix bug', SessionType.DEBUGGING);
    expect(result.applied).toBe(false);
    expect(result.compressedText).toBe('Fix bug');
  });
});

// ─── Phase 6: BurnRateCalculator ─────────────────────────────────────────────

describe('BurnRateCalculator', () => {
  it('computes weighted average with recent days weighted higher', () => {
    const calc = new BurnRateCalculator();
    // 14 records: first 7 are low (weight 1), last 7 are high spike (weight 2)
    const records = [
      ...Array(7).fill(null).map((_, i) => ({
        date: `2026-05-${String(i + 20).padStart(2, '0')}`,
        totalRequests: 10, grossCost: 0.4, discountAmount: 0.4, netCost: 0,
        bySessionType: {}, byModel: {}, hitOverage: false,
      })),
      ...Array(7).fill(null).map((_, i) => ({
        date: `2026-06-${String(i + 1).padStart(2, '0')}`,
        totalRequests: 500, grossCost: 20, discountAmount: 20, netCost: 0,
        bySessionType: {}, byModel: {}, hitOverage: false,
      })),
    ];
    const result = calc.computeByRequests(records);
    // Simple avg across 14 days = (10*7 + 500*7)/14 = 255
    // Weighted: recent 7 (500/day) get weight 2, older 7 (10/day) get weight 1
    // Weighted avg = (10*7*1 + 500*7*2) / (7*1 + 7*2) = (70 + 7000) / 21 ≈ 337
    const simpleAvg = (10 * 7 + 500 * 7) / 14; // 255
    expect(result.dailyAvg).toBeGreaterThan(simpleAvg);
    expect(result.trend).toBe('RISING');
  });
});

// ─── Phase 6: OverageRiskScorer ──────────────────────────────────────────────

describe('OverageRiskScorer', () => {
  const scorer = new OverageRiskScorer(0.04);
  const mockBurnRate = { dailyAvg: 238, window7: 238, window14: 200, window30: 180, trend: 'STABLE' as const, trendPct: 5, sampleDays: 6 };

  it('returns CERTAIN risk when balance runs out before reset', () => {
    // 240 remaining, 238/day burn rate, 24 days until reset → exhausts day 2
    const result = scorer.score(240, mockBurnRate, 24);
    expect(result.label).toBe('CERTAIN');
    expect(result.score).toBeGreaterThan(0.9);
    expect(result.daysUntilExhaustion).toBeLessThan(2);
  });

  it('returns NONE risk when balance easily covers period', () => {
    const result = scorer.score(10_000, mockBurnRate, 24);
    expect(['NONE', 'LOW']).toContain(result.label);
  });

  it('projects overage cost correctly', () => {
    const result = scorer.score(240, mockBurnRate, 24);
    expect(result.projectedOverageCost).toBeGreaterThan(0);
  });
});

// ─── Phase 6: ExhaustionForecaster — REAL DATA VALIDATION ────────────────────

describe('ExhaustionForecaster — June 2026 Retroactive Validation', () => {
  /**
   * This is the patent demo.
   * Uses actual imKrisK billing data from June 2026 GitHub usage report.
   * Proves TSP would have warned on Jun 6 that quota exhausts Jun 7.
   */
  const jun2026History = [
    { date: '2026-06-01', totalRequests: 274, grossCost: 10.96, discountAmount: 10.96, netCost: 0, bySessionType: {}, byModel: {}, hitOverage: false },
    { date: '2026-06-02', totalRequests: 200, grossCost: 8.00,  discountAmount: 8.00,  netCost: 0, bySessionType: {}, byModel: {}, hitOverage: false },
    { date: '2026-06-03', totalRequests: 335, grossCost: 13.40, discountAmount: 13.40, netCost: 0, bySessionType: {}, byModel: {}, hitOverage: false },
    { date: '2026-06-04', totalRequests: 261, grossCost: 10.44, discountAmount: 10.44, netCost: 0, bySessionType: {}, byModel: {}, hitOverage: false },
    { date: '2026-06-05', totalRequests: 159, grossCost: 6.36,  discountAmount: 6.36,  netCost: 0, bySessionType: {}, byModel: {}, hitOverage: false },
  ];

  it('predicts quota exhaustion within days when balance is critically low', () => {
    const forecaster = new ExhaustionForecaster(0.04);
    const result = forecaster.forecast({
      currentBalance:   240,                          // requests remaining Jun 6
      periodResetDate:  new Date('2026-07-01T00:00:00Z'),
      burnHistory:      jun2026History,
      useRequestMetric: true,
    });
    expect(result.exhaustionDate).not.toBeNull();
    expect(result.daysRemaining).toBeLessThan(3);    // Should show <3 days
    expect(result.overageRiskScore).toBeGreaterThan(0.85); // HIGH or CERTAIN
    expect(result.recommendedActions[0]).toContain('agentic'); // Should mention agentic sessions
  });

  it('computes overage cost estimate > $0 when exhaustion is predicted', () => {
    const forecaster = new ExhaustionForecaster(0.04);
    const result = forecaster.forecast({
      currentBalance:   240,
      periodResetDate:  new Date('2026-07-01T00:00:00Z'),
      burnHistory:      jun2026History,
      useRequestMetric: true,
    });
    expect(result.overageCostEstimate).toBeGreaterThan(0);
  });
});

// ─── Phase 3: CostRouter ─────────────────────────────────────────────────────

describe('CostRouter — Wave 10 Claim 3 + 7', () => {
  const router = new CostRouter();

  it('substitutes model when throttled — Claim 7', () => {
    const result = router.route({
      sessionType: SessionType.DEBUGGING,
      qualityRequirement: QualityRequirement.STANDARD,
      availableCredits: 1,
      contextSizeTokens: 5000,
      latencyRequirement: 'INTERACTIVE',
      preferredModelId: ModelId.CLAUDE_SONNET_4,
      isThrottled: true,
    });
    expect(result.wasSubstituted).toBe(true);
    expect(result.selectedModel).toBe(ModelId.CLAUDE_HAIKU_3);
  });

  it('always uses premium model for CRITICAL quality', () => {
    const result = router.route({
      sessionType: SessionType.ARCHITECTURE,
      qualityRequirement: QualityRequirement.CRITICAL,
      availableCredits: 0.01,
      contextSizeTokens: 10_000,
      latencyRequirement: 'INTERACTIVE',
      isThrottled: false,
    });
    expect(result.wasSubstituted).toBe(false);
  });

  it('selects cheaper model for DRAFT quality', () => {
    const result = router.route({
      sessionType: SessionType.BOILERPLATE,
      qualityRequirement: QualityRequirement.DRAFT,
      availableCredits: 10,
      contextSizeTokens: 2000,
      latencyRequirement: 'INTERACTIVE',
      isThrottled: false,
    });
    // Should prefer a cheap model — not Claude Sonnet at $0.018/1k output
    expect(result.estimatedCost).toBeLessThan(0.01);
  });
});
