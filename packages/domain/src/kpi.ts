/**
 * KPI type definitions for gameplay measurement (PR-18b).
 *
 * Primary KPIs:
 *   CMR  – Competitive Match Rate
 *   CWR  – Close Win Rate
 *   ADI  – Action Diversity Index
 *   RIR24 – Return In 24 h Rate
 *
 * Guardrail KPIs:
 *   MCR   – Match Completion Rate
 *   FSWG  – First-Start Win Gap
 *   DSS   – Draw / Stalemate Share
 *   SR60  – Session Retention 60 min
 *   RCR80 – Rule Compliance Rate 80 %
 *   DBT   – Decision Boundary Traversal
 */

// ---------------------------------------------------------------------------
// Metric name constants
// ---------------------------------------------------------------------------

export const PRIMARY_KPI_NAMES = ['CMR', 'CWR', 'ADI', 'RIR24'] as const;
export type PrimaryKpiName = (typeof PRIMARY_KPI_NAMES)[number];

export const GUARDRAIL_KPI_NAMES = ['MCR', 'TTFC', 'FSWG', 'DSS', 'SR60', 'RCR80', 'DBT'] as const;
export type GuardrailKpiName = (typeof GUARDRAIL_KPI_NAMES)[number];

export type KpiName = PrimaryKpiName | GuardrailKpiName;

// ---------------------------------------------------------------------------
// KpiSnapshot
// ---------------------------------------------------------------------------

/**
 * A point-in-time snapshot of computed KPI metrics for a given game /
 * rule version / queue-type / rating bracket / time period.
 */
export interface KpiSnapshot {
  readonly gameId: string;
  readonly ruleVersion: string;
  readonly queueType: string;
  readonly ratingBracket: string;
  /** ISO-8601 period identifier, e.g. "2026-03-01/2026-03-08" */
  readonly period: string;
  readonly sampleSize: number;
  /** Metric name → value (0–1 ratio or entropy score) */
  readonly metrics: Readonly<Record<string, number>>;
  /** Metric name → [lower, upper] 95 % confidence interval */
  readonly confidence: Readonly<Record<string, readonly [number, number]>>;
  readonly computedAt: string;
}

// ---------------------------------------------------------------------------
// KpiDiff
// ---------------------------------------------------------------------------

export interface KpiMetricDiff {
  readonly metricName: string;
  readonly valueA: number;
  readonly valueB: number;
  readonly absoluteDiff: number;
  readonly relativeDiff: number;
  /** Whether the difference is statistically significant */
  readonly significant: boolean;
}

export interface KpiDiff {
  readonly gameId: string;
  readonly ruleVersionA: string;
  readonly ruleVersionB: string;
  readonly sampleSizeA: number;
  readonly sampleSizeB: number;
  readonly diffs: readonly KpiMetricDiff[];
  readonly computedAt: string;
}

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

/**
 * Returns true when the sample size meets the minimum threshold for
 * statistical significance (default N ≥ 400 per SPEC §18b).
 */
export const isStatisticallySignificant = (sampleSize: number, minN = 400): boolean =>
  sampleSize >= minN;

/**
 * Computes a per-metric diff between two KpiSnapshots.
 * Only metrics present in *both* snapshots are included.
 */
export const computeKpiDiff = (a: KpiSnapshot, b: KpiSnapshot): KpiDiff => {
  const metricNames = Object.keys(a.metrics).filter((name) => name in b.metrics);

  const diffs: KpiMetricDiff[] = metricNames.map((name) => {
    const valueA = a.metrics[name] ?? 0;
    const valueB = b.metrics[name] ?? 0;
    const absoluteDiff = valueB - valueA;
    const relativeDiff = valueA === 0 ? 0 : absoluteDiff / valueA;

    return {
      metricName: name,
      valueA,
      valueB,
      absoluteDiff,
      relativeDiff,
      significant:
        isStatisticallySignificant(a.sampleSize) && isStatisticallySignificant(b.sampleSize),
    };
  });

  return {
    gameId: a.gameId,
    ruleVersionA: a.ruleVersion,
    ruleVersionB: b.ruleVersion,
    sampleSizeA: a.sampleSize,
    sampleSizeB: b.sampleSize,
    diffs,
    computedAt: new Date().toISOString(),
  };
};
