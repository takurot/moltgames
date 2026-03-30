import { describe, expect, it } from 'vitest';

import {
  KpiAggregator,
  type MatchSummary,
  type TurnEventSummary,
  type ReturnEvent,
} from '../../../src/services/kpi-aggregator.js';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

const makeMatch = (overrides: Partial<MatchSummary> = {}): MatchSummary => ({
  matchId: 'match-1',
  gameId: 'prompt-injection-arena',
  ruleVersion: '1.0.0',
  queueType: 'ranked',
  ratingBracket: '1400-1600',
  winnerId: 'agent-a',
  winnerSeat: 'first',
  finalScores: { 'agent-a': 60, 'agent-b': 40 },
  durationMs: 120_000,
  createdAt: '2026-03-01T10:00:00.000Z',
  ...overrides,
});

const makeTurnEvent = (overrides: Partial<TurnEventSummary> = {}): TurnEventSummary => ({
  matchId: 'match-1',
  actionType: 'attack',
  seat: 'first',
  scoreDiffBefore: 0,
  scoreDiffAfter: 5,
  ...overrides,
});

const makeReturnEvent = (overrides: Partial<ReturnEvent> = {}): ReturnEvent => ({
  uid: 'user-1',
  previousMatchId: 'match-1',
  returnedAt: '2026-03-02T10:00:00.000Z',
  previousMatchAt: '2026-03-01T10:00:00.000Z', // 24h later → qualifies
  ...overrides,
});

// ---------------------------------------------------------------------------
// computeCMR – Competitive Match Rate
// ---------------------------------------------------------------------------

describe('KpiAggregator.computeCMR', () => {
  const agg = new KpiAggregator();

  it('returns 0 for an empty match list', () => {
    expect(agg.computeCMR([])).toBe(0);
  });

  it('counts matches decided by ≤10% score difference', () => {
    const competitive = makeMatch({ finalScores: { 'agent-a': 55, 'agent-b': 50 } }); // diff=5, max=55, 9.1%
    const blowout = makeMatch({ finalScores: { 'agent-a': 80, 'agent-b': 20 } }); // diff=60, 75%
    const result = agg.computeCMR([competitive, blowout]);
    expect(result).toBeCloseTo(0.5);
  });

  it('treats a zero-score match as non-competitive to avoid division by zero', () => {
    const zeroMatch = makeMatch({ finalScores: { 'agent-a': 0, 'agent-b': 0 } });
    expect(agg.computeCMR([zeroMatch])).toBe(0);
  });

  it('handles all competitive matches', () => {
    const matches = [
      makeMatch({ matchId: 'm1', finalScores: { a: 51, b: 50 } }),
      makeMatch({ matchId: 'm2', finalScores: { a: 100, b: 95 } }),
    ];
    expect(agg.computeCMR(matches)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeCWR – Comeback Win Rate
// ---------------------------------------------------------------------------

describe('KpiAggregator.computeCWR', () => {
  const agg = new KpiAggregator();

  it('returns 0 for an empty match list', () => {
    expect(agg.computeCWR([], [])).toBe(0);
  });

  it('counts matches where the eventual winner was trailing before winning', () => {
    const comeback = makeMatch({ matchId: 'm1', winnerSeat: 'first' });
    const comebackEvents = [
      makeTurnEvent({ matchId: 'm1', seat: 'first', scoreDiffBefore: -2, scoreDiffAfter: 1 }),
    ];

    const frontRun = makeMatch({ matchId: 'm2', winnerSeat: 'second', winnerId: 'agent-b' });
    const frontRunEvents = [
      makeTurnEvent({ matchId: 'm2', seat: 'second', scoreDiffBefore: 3, scoreDiffAfter: 4 }),
    ];

    expect(
      agg.computeCWR([comeback, frontRun], [...comebackEvents, ...frontRunEvents]),
    ).toBeCloseTo(0.5);
  });

  it('handles draw (no winnerId) by treating it as non-comeback win', () => {
    const draw = makeMatch({ winnerId: null, winnerSeat: null, finalScores: { a: 50, b: 50 } });
    expect(agg.computeCWR([draw], [makeTurnEvent({ scoreDiffBefore: -1 })])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeADI – Action Diversity Index (Shannon entropy)
// ---------------------------------------------------------------------------

describe('KpiAggregator.computeADI', () => {
  const agg = new KpiAggregator();

  it('returns 0 for an empty event list', () => {
    expect(agg.computeADI([])).toBe(0);
  });

  it('returns 0 when all actions are the same type', () => {
    const events = [
      makeTurnEvent({ actionType: 'attack' }),
      makeTurnEvent({ actionType: 'attack' }),
    ];
    expect(agg.computeADI(events)).toBeCloseTo(0);
  });

  it('returns 1 for equally-distributed action types after normalization', () => {
    const events = [
      makeTurnEvent({ actionType: 'attack' }),
      makeTurnEvent({ actionType: 'defend' }),
      makeTurnEvent({ actionType: 'negotiate' }),
      makeTurnEvent({ actionType: 'flee' }),
    ];
    expect(agg.computeADI(events)).toBeCloseTo(1, 3);
  });

  it('produces a non-zero entropy for two different action types (50/50)', () => {
    const events = [
      makeTurnEvent({ actionType: 'attack' }),
      makeTurnEvent({ actionType: 'defend' }),
    ];
    expect(agg.computeADI(events)).toBeCloseTo(1, 3);
  });
});

// ---------------------------------------------------------------------------
// computeRIR24 – Return In 24h Rate
// ---------------------------------------------------------------------------

describe('KpiAggregator.computeRIR24', () => {
  const agg = new KpiAggregator();

  it('returns 0 when there are no matches', () => {
    expect(agg.computeRIR24([], [])).toBe(0);
  });

  it('returns 0 when there are no return events', () => {
    expect(agg.computeRIR24([makeMatch()], [])).toBe(0);
  });

  it('counts users who returned within 24 h', () => {
    const matches = [
      makeMatch({ matchId: 'm1', createdAt: '2026-03-01T10:00:00.000Z' }),
      makeMatch({ matchId: 'm2', createdAt: '2026-03-01T11:00:00.000Z' }),
    ];
    const returnEvents: ReturnEvent[] = [
      {
        uid: 'user-1',
        previousMatchId: 'm1',
        previousMatchAt: '2026-03-01T10:00:00.000Z',
        returnedAt: '2026-03-02T09:00:00.000Z', // 23h later → qualifies
      },
    ];
    // 1 returner out of 2 matches → 0.5
    expect(agg.computeRIR24(matches, returnEvents)).toBeCloseTo(0.5);
  });

  it('does not count users who returned after 24 h', () => {
    const matches = [makeMatch({ matchId: 'm1', createdAt: '2026-03-01T10:00:00.000Z' })];
    const returnEvents: ReturnEvent[] = [
      {
        uid: 'user-1',
        previousMatchId: 'm1',
        previousMatchAt: '2026-03-01T10:00:00.000Z',
        returnedAt: '2026-03-02T11:00:00.000Z', // 25h later → does not qualify
      },
    ];
    expect(agg.computeRIR24(matches, returnEvents)).toBe(0);
  });

  it('counts each prior match at most once even if multiple participants return', () => {
    const matches = [makeMatch({ matchId: 'm1' })];
    const returnEvents: ReturnEvent[] = [
      makeReturnEvent({ uid: 'user-1', previousMatchId: 'm1' }),
      makeReturnEvent({ uid: 'user-2', previousMatchId: 'm1' }),
    ];

    expect(agg.computeRIR24(matches, returnEvents)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// aggregate – main aggregation function
// ---------------------------------------------------------------------------

describe('KpiAggregator.aggregate', () => {
  const agg = new KpiAggregator();

  it('returns a KpiSnapshot with all primary KPI metrics', () => {
    const matches: MatchSummary[] = Array.from({ length: 10 }, (_, i) =>
      makeMatch({
        matchId: `m${i}`,
        finalScores: { 'agent-a': 55, 'agent-b': 50 },
      }),
    );

    const turnEvents: TurnEventSummary[] = [
      makeTurnEvent({ actionType: 'attack' }),
      makeTurnEvent({ actionType: 'defend' }),
    ];

    const snapshot = agg.aggregate({
      gameId: 'prompt-injection-arena',
      ruleVersion: '1.0.0',
      queueType: 'ranked',
      ratingBracket: '1400-1600',
      period: '2026-03-01/2026-03-08',
      matches,
      turnEvents,
      returnEvents: [],
    });

    expect(snapshot.gameId).toBe('prompt-injection-arena');
    expect(snapshot.ruleVersion).toBe('1.0.0');
    expect(snapshot.sampleSize).toBe(10);
    expect(typeof snapshot.metrics.CMR).toBe('number');
    expect(typeof snapshot.metrics.CWR).toBe('number');
    expect(typeof snapshot.metrics.ADI).toBe('number');
    expect(typeof snapshot.metrics.RIR24).toBe('number');
    expect(snapshot.metrics.ADI).toBeGreaterThanOrEqual(0);
    expect(snapshot.metrics.ADI).toBeLessThanOrEqual(1);
    expect(typeof snapshot.computedAt).toBe('string');
  });

  it('attaches 95% confidence intervals for each metric', () => {
    const matches: MatchSummary[] = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ matchId: `m${i}` }),
    );

    const snapshot = agg.aggregate({
      gameId: 'prompt-injection-arena',
      ruleVersion: '1.0.0',
      queueType: 'ranked',
      ratingBracket: '1400-1600',
      period: '2026-03-01/2026-03-08',
      matches,
      turnEvents: [],
      returnEvents: [],
    });

    for (const name of ['CMR', 'CWR', 'RIR24']) {
      const ci = snapshot.confidence[name];
      expect(ci).toBeDefined();
      expect(Array.isArray(ci)).toBe(true);
      expect(ci![0]).toBeLessThanOrEqual(snapshot.metrics[name]!);
      expect(ci![1]).toBeGreaterThanOrEqual(snapshot.metrics[name]!);
    }

    const adiCi = snapshot.confidence.ADI;
    expect(adiCi[0]).toBeGreaterThanOrEqual(0);
    expect(adiCi[1]).toBeLessThanOrEqual(1);
  });
});
