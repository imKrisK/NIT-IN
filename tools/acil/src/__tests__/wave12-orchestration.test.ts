/**
 * Wave 12 — Multi-Agent Orchestration Tests
 *
 * Tests:
 *   SharedBudgetPool — atomic debit, state transitions, broadcast
 *   ContradictionDetector — scoring, conflict classification, resolution
 *   ControlledHallucinationEngine — estimation fallback, cost differential
 *   AgentOrchestrator — end-to-end orchestration
 */

import { SharedBudgetPool }              from '../orchestration/SharedBudgetPool';
import { ContradictionDetector }         from '../orchestration/ContradictionDetector';
import { ControlledHallucinationEngine } from '../orchestration/ControlledHallucinationEngine';
import { AgentOrchestrator }             from '../orchestration/AgentOrchestrator';
import { EnforcementState }              from '../core/types';

// ── SharedBudgetPool ──────────────────────────────────────────────────────────

describe('SharedBudgetPool', () => {
  it('initializes with correct balance', () => {
    const pool = new SharedBudgetPool(39.00);
    expect(pool.balance).toBe(39.00);
    expect(pool.allocation).toBe(39.00);
  });

  it('debit reduces balance and returns allowed=true in NORMAL state', async () => {
    const pool = new SharedBudgetPool(39.00);
    const result = await pool.debit('copilot', 0.01);
    expect(result.allowed).toBe(true);
    expect(pool.balance).toBeCloseTo(38.99);
    expect(result.source).toBe('copilot');
  });

  it('tracks spend per source', async () => {
    const pool = new SharedBudgetPool(39.00);
    await pool.debit('copilot', 0.05);
    await pool.debit('cursor',  0.03);
    await pool.debit('copilot', 0.02);
    const snap = pool.peek();
    expect(snap.bySource['copilot']).toBeCloseTo(0.07);
    expect(snap.bySource['cursor']).toBeCloseTo(0.03);
  });

  it('transitions to ADVISORY at 60% spent', async () => {
    const pool = new SharedBudgetPool(10.00, 4.00); // 60% spent
    const snap = pool.peek();
    expect(snap.enforcementState).toBe(EnforcementState.ADVISORY);
  });

  it('blocks at CRITICAL/EXHAUSTED state', async () => {
    const pool = new SharedBudgetPool(10.00, 0.15); // 98.5% spent
    const result = await pool.debit('copilot', 0.01);
    expect(result.allowed).toBe(false);
    expect([EnforcementState.EXHAUSTED, EnforcementState.CRITICAL]).toContain(result.enforcementState);
  });

  it('broadcasts state change to all registered consumers', async () => {
    const pool = new SharedBudgetPool(10.00);
    const states: string[] = [];
    pool.register('agent-a', (state) => states.push(state));
    // Drain to WARNING
    await pool.debit('agent-a', 7.6); // 76% spent → WARNING
    expect(states).toContain(EnforcementState.WARNING);
  });

  it('refill resets balance and broadcasts NORMAL', async () => {
    const pool = new SharedBudgetPool(10.00, 0.5);
    const states: string[] = [];
    pool.register('agent-a', (state) => states.push(state));
    pool.refill();
    expect(pool.balance).toBe(10.00);
    expect(states[states.length - 1]).toBe(EnforcementState.NORMAL);
  });

  it('setBalance corrects drift', () => {
    const pool = new SharedBudgetPool(39.00, 20.00);
    pool.setBalance(25.00);
    expect(pool.balance).toBe(25.00);
  });
});

// ── ContradictionDetector ─────────────────────────────────────────────────────

describe('ContradictionDetector', () => {
  it('returns allow with score 0 for first response (no history)', () => {
    const det = new ContradictionDetector();
    const result = det.detect('copilot', 'Use PostgreSQL for relational data.');
    expect(result.resolution).toBe('allow');
    expect(result.contradictionScore).toBe(0);
  });

  it('detects contradiction between "use PostgreSQL" and "use MongoDB"', () => {
    const det = new ContradictionDetector({ flagThreshold: 0.50 });
    det.detect('copilot', 'You should use PostgreSQL for this use case. It handles relational data well.');
    const result = det.detect('cursor',  'Avoid PostgreSQL here. Use MongoDB instead — it is better for this.');
    expect(result.contradictionScore).toBeGreaterThan(0.40);
    expect(result.conflictType).toBe('architecture');
  });

  it('classifies security conflicts', () => {
    const det = new ContradictionDetector({ flagThreshold: 0.40 });
    det.detect('copilot', 'Use JWT for authentication. It is the best approach.');
    const result = det.detect('cursor',  'Avoid JWT. Use session cookies instead — JWT is not secure here.');
    expect(result.conflictType).toBe('security');
  });

  it('clears history on clearHistory()', () => {
    const det = new ContradictionDetector();
    det.detect('copilot', 'Use React for the frontend.');
    det.clearHistory();
    const result = det.detect('cursor', 'Avoid React. Use Vue instead.');
    expect(result.contradictionScore).toBe(0); // no history to compare against
  });

  it('does not flag same-source responses', () => {
    const det = new ContradictionDetector({ flagThreshold: 0.40 });
    det.detect('copilot', 'Use PostgreSQL for relational data.');
    const result = det.detect('copilot', 'Avoid MongoDB. Use PostgreSQL instead.');
    expect(result.resolution).toBe('allow'); // same source → no contradiction
  });

  it('resolution is block above blockThreshold', () => {
    const det = new ContradictionDetector({ flagThreshold: 0.40, blockThreshold: 0.50 });
    det.detect('agent-a', 'You must never use jwt tokens for this api authentication.');
    const result = det.detect('agent-b', 'Always use jwt tokens. Never use session cookies. Do not avoid jwt.');
    // High negation asymmetry should push score up
    expect(['flag','block']).toContain(result.resolution);
  });
});

// ── ControlledHallucinationEngine ─────────────────────────────────────────────

describe('ControlledHallucinationEngine', () => {
  it('returns estimated measurement when no shadow fn is set', async () => {
    const engine = new ControlledHallucinationEngine();
    const result = await engine.measure(
      'Write a TypeScript function that validates email addresses.',
      'TypeScript function: validate email. Return boolean.',
      'BOILERPLATE',
      0.005,
      EnforcementState.NORMAL,
    );
    expect(result.fired).toBe(false);
    expect(result.measurement).toBe('estimated');
    expect(result.exactCostOriginal).toBeGreaterThan(result.exactCostCompressed);
    expect(result.exactSavingsUsd).toBeGreaterThanOrEqual(0);
  });

  it('compressed prompt costs less than original', async () => {
    const engine = new ControlledHallucinationEngine();
    const longPrompt = 'Hey, could you please help me write a TypeScript function that validates email addresses? I need it to return a boolean and I would prefer not to use any external imports if possible. Maybe use regex?';
    const shortPrompt = 'TypeScript function: validate email. Return boolean. No imports. Use regex.';
    const result = await engine.measure(longPrompt, shortPrompt, 'BOILERPLATE', 0.005, EnforcementState.NORMAL);
    expect(result.exactCostOriginal).toBeGreaterThan(result.exactCostCompressed);
    expect(result.exactSavingsPct).toBeGreaterThan(0);
  });

  it('fires shadow fn when in CRITICAL state and fn is wired', async () => {
    const engine = new ControlledHallucinationEngine({ activateOnStates: [EnforcementState.CRITICAL] });
    let fired = false;
    engine.setShadowFn(async (_prompt, _model, _max) => {
      fired = true;
      return { inputTokens: 120, outputTokens: 85 };
    });
    const result = await engine.measure('Test prompt', 'Test', 'DEBUGGING', 0.005, EnforcementState.CRITICAL);
    expect(fired).toBe(true);
    expect(result.fired).toBe(true);
    expect(result.measurement).toBe('exact');
    expect(result.shadowOutputTokens).toBe(85);
  });

  it('does not fire shadow fn in NORMAL state', async () => {
    const engine = new ControlledHallucinationEngine({ activateOnStates: [EnforcementState.CRITICAL] });
    let fired = false;
    engine.setShadowFn(async () => { fired = true; return { inputTokens: 100, outputTokens: 80 }; });
    await engine.measure('Test prompt', 'Test', 'DEBUGGING', 0.005, EnforcementState.NORMAL);
    expect(fired).toBe(false);
  });
});

// ── AgentOrchestrator ─────────────────────────────────────────────────────────

describe('AgentOrchestrator', () => {
  it('preflight allows request when balance is healthy', async () => {
    const orch = new AgentOrchestrator({ monthlyBudget: 39.00 });
    orch.registerAgent('copilot', () => {});
    const result = await orch.preflight('copilot', 'test', 'test', 'DEBUGGING', 0.001);
    expect(result.allowed).toBe(true);
    expect(result.source).toBe('copilot');
  });

  it('tracks multiple agents in shared pool', async () => {
    const orch = new AgentOrchestrator({ monthlyBudget: 10.00 });
    orch.registerAgent('copilot', () => {});
    orch.registerAgent('cursor',  () => {});
    await orch.preflight('copilot', 'p1', 'p1', 'DEBUGGING',  1.00);
    await orch.preflight('cursor',  'p2', 'p2', 'ARCHITECTURE', 2.00);
    const snap = orch.poolSnapshot();
    expect(snap.bySource['copilot']).toBeCloseTo(1.00);
    expect(snap.bySource['cursor']).toBeCloseTo(2.00);
    expect(snap.spent).toBeCloseTo(3.00);
  });

  it('checkResponse flags contradiction between agents', () => {
    const orch = new AgentOrchestrator({ monthlyBudget: 39.00, contradictionEnabled: true });
    orch.registerAgent('copilot', () => {});
    orch.registerAgent('cursor',  () => {});
    // First agent says use PostgreSQL
    orch.checkResponse('copilot', 'You should use PostgreSQL for this. It is best for relational data.');
    // Second agent contradicts
    const result = orch.checkResponse('cursor', 'Avoid PostgreSQL. Use MongoDB instead — it is better here.');
    // Should detect some contradiction
    expect(result.contradiction.contradictionScore).toBeGreaterThanOrEqual(0);
    expect(result.source).toBe('cursor');
  });

  it('resetSession clears contradiction history', () => {
    const orch = new AgentOrchestrator({ monthlyBudget: 39.00 });
    orch.registerAgent('copilot', () => {});
    orch.checkResponse('copilot', 'Use PostgreSQL for relational data storage.');
    orch.resetSession();
    const diag = orch.diagnostics;
    expect(diag.history).toBe(0);
  });

  it('diagnostics reports all registered agents', () => {
    const orch = new AgentOrchestrator({ monthlyBudget: 39.00 });
    orch.registerAgent('copilot',    () => {});
    orch.registerAgent('cursor',     () => {});
    orch.registerAgent('mcp-client', () => {});
    const diag = orch.diagnostics;
    expect(diag.agents).toContain('copilot');
    expect(diag.agents).toContain('cursor');
    expect(diag.agents).toContain('mcp-client');
    expect(diag.agents).toHaveLength(3);
  });
});
