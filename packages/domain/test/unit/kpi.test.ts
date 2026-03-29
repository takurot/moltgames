import { describe, expect, it } from 'vitest';

import {
  computeKpiDiff,
  isStatisticallySignificant,
  PRIMARY_KPI_NAMES,
  GUARDRAIL_KPI_NAMES,
  type KpiSnapshot,
} from '../../src/kpi.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeSnapshot = (overrides: Partial<KpiSnapshot> = {}): KpiSnapshot => ({
  gameId: 'prompt-injection-arena',
  ruleVersion: '1.0.0',
  queueType: 'ranked',
  ratingBracket: '1400-1600',
  period: '2026-03-01/2026-03-08',
  sampleSize: 500,
  metrics: { CMR: 0.6, CWR: 0.55, ADI: 2.3, RIR24: 0.4 },
  confidence: {
    CMR: [0.55, 0.65],
    CWR: [0.5, 0.6],
    ADI: [2.1, 2.5],
    RIR24: [0.35, 0.45],
  },
  computedAt: '2026-03-09T00:00:00.000Z',
  ...overrides,
});

// ---------------------------------------------------------------------------
// KPI name constants
// ---------------------------------------------------------------------------

describe('KPI name constants', () => {
  it('exposes the four primary KPI names', () => {
    expect(PRIMARY_KPI_NAMES).toEqual(['CMR', 'CWR', 'ADI', 'RIR24']);
  });

  it('exposes the six guardrail KPI names', () => {
    expect(GUARDRAIL_KPI_NAMES).toEqual(['MCR', 'FSWG', 'DSS', 'SR60', 'RCR80', 'DBT']);
  });
});

// ---------------------------------------------------------------------------
// isStatisticallySignificant
// ---------------------------------------------------------------------------

describe('isStatisticallySignificant', () => {
  it('returns true when sample size meets default minimum (400)', () => {
    expect(isStatisticallySignificant(400)).toBe(true);
    expect(isStatisticallySignificant(500)).toBe(true);
    expect(isStatisticallySignificant(1000)).toBe(true);
  });

  it('returns false when sample size is below default minimum', () => {
    expect(isStatisticallySignificant(399)).toBe(false);
    expect(isStatisticallySignificant(0)).toBe(false);
    expect(isStatisticallySignificant(1)).toBe(false);
  });

  it('respects a custom minN parameter', () => {
    expect(isStatisticallySignificant(100, 100)).toBe(true);
    expect(isStatisticallySignificant(99, 100)).toBe(false);
    expect(isStatisticallySignificant(50, 30)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeKpiDiff
// ---------------------------------------------------------------------------

describe('computeKpiDiff', () => {
  it('computes absolute and relative diffs for matching metrics', () => {
    const a = makeSnapshot({ ruleVersion: '1.0.0', metrics: { CMR: 0.5, CWR: 0.6 } });
    const b = makeSnapshot({ ruleVersion: '1.1.0', metrics: { CMR: 0.6, CWR: 0.6 } });

    const diff = computeKpiDiff(a, b);

    expect(diff.ruleVersionA).toBe('1.0.0');
    expect(diff.ruleVersionB).toBe('1.1.0');
    expect(diff.gameId).toBe('prompt-injection-arena');
    expect(diff.sampleSizeA).toBe(500);
    expect(diff.sampleSizeB).toBe(500);

    const cmrDiff = diff.diffs.find((d) => d.metricName === 'CMR');
    expect(cmrDiff).toBeDefined();
    expect(cmrDiff?.valueA).toBeCloseTo(0.5);
    expect(cmrDiff?.valueB).toBeCloseTo(0.6);
    expect(cmrDiff?.absoluteDiff).toBeCloseTo(0.1);
    expect(cmrDiff?.relativeDiff).toBeCloseTo(0.2); // 0.1 / 0.5

    const cwrDiff = diff.diffs.find((d) => d.metricName === 'CWR');
    expect(cwrDiff?.absoluteDiff).toBeCloseTo(0);
  });

  it('marks diff as significant when both snapshots have sample size >= 400', () => {
    const a = makeSnapshot({ sampleSize: 400 });
    const b = makeSnapshot({ sampleSize: 500 });

    const diff = computeKpiDiff(a, b);
    diff.diffs.forEach((d) => expect(d.significant).toBe(true));
  });

  it('marks diff as not significant when either snapshot is below 400', () => {
    const a = makeSnapshot({ sampleSize: 399 });
    const b = makeSnapshot({ sampleSize: 500 });

    const diff = computeKpiDiff(a, b);
    diff.diffs.forEach((d) => expect(d.significant).toBe(false));
  });

  it('only includes metrics present in both snapshots', () => {
    const a = makeSnapshot({ metrics: { CMR: 0.5, CWR: 0.6, ADI: 1.8 } });
    const b = makeSnapshot({ metrics: { CMR: 0.55, ADI: 2.0 } }); // CWR missing in b

    const diff = computeKpiDiff(a, b);
    const names = diff.diffs.map((d) => d.metricName);

    expect(names).toContain('CMR');
    expect(names).toContain('ADI');
    expect(names).not.toContain('CWR');
  });

  it('handles zero baseValue without division errors (relativeDiff = 0)', () => {
    const a = makeSnapshot({ metrics: { CMR: 0 } });
    const b = makeSnapshot({ metrics: { CMR: 0.1 } });

    const diff = computeKpiDiff(a, b);
    const cmrDiff = diff.diffs.find((d) => d.metricName === 'CMR');

    expect(cmrDiff?.relativeDiff).toBe(0);
    expect(cmrDiff?.absoluteDiff).toBeCloseTo(0.1);
  });

  it('includes a computedAt ISO timestamp', () => {
    const diff = computeKpiDiff(makeSnapshot(), makeSnapshot({ ruleVersion: '2.0.0' }));
    expect(typeof diff.computedAt).toBe('string');
    expect(() => new Date(diff.computedAt)).not.toThrow();
  });

  it('produces an empty diffs array when there are no common metrics', () => {
    const a = makeSnapshot({ metrics: { CMR: 0.5 } });
    const b = makeSnapshot({ metrics: { CWR: 0.6 } });

    const diff = computeKpiDiff(a, b);
    expect(diff.diffs).toHaveLength(0);
  });
});
