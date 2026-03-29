import { computeKpiDiff, type KpiDiff, type KpiSnapshot } from '@moltgames/domain';

// ---------------------------------------------------------------------------
// Input types (pre-fetched from Firestore / Redis – no direct DB calls here)
// ---------------------------------------------------------------------------

export interface MatchSummary {
  readonly matchId: string;
  readonly gameId: string;
  readonly ruleVersion: string;
  readonly queueType: string;
  readonly ratingBracket: string;
  /** null means draw */
  readonly winnerId: string | null;
  readonly winnerSeat: 'first' | 'second' | null;
  /** agentId → numeric score */
  readonly finalScores: Readonly<Record<string, number>>;
  readonly durationMs: number;
  readonly createdAt: string;
}

export interface TurnEventSummary {
  readonly matchId: string;
  readonly actionType: string;
  readonly seat: 'first' | 'second';
  readonly scoreDiffBefore: number;
  readonly scoreDiffAfter: number;
}

export interface ReturnEvent {
  readonly uid: string;
  readonly previousMatchId: string;
  readonly returnedAt: string;
  readonly previousMatchAt: string;
}

export interface AggregateParams {
  readonly gameId: string;
  readonly ruleVersion: string;
  readonly queueType: string;
  readonly ratingBracket: string;
  /** ISO-8601 interval string, e.g. "2026-03-01/2026-03-08" */
  readonly period: string;
  readonly matches: readonly MatchSummary[];
  readonly turnEvents: readonly TurnEventSummary[];
  readonly returnEvents: readonly ReturnEvent[];
}

// ---------------------------------------------------------------------------
// Internal helpers (pure functions)
// ---------------------------------------------------------------------------

/** Returns the maximum absolute score across all participants. */
const maxScore = (scores: Readonly<Record<string, number>>): number => {
  const values = Object.values(scores);
  if (values.length === 0) return 0;
  return Math.max(...values.map((v) => Math.abs(v)));
};

/** Returns the absolute score difference between the top two participants. */
const scoreDiff = (scores: Readonly<Record<string, number>>): number => {
  const sorted = Object.values(scores).sort((a, b) => b - a);
  if (sorted.length < 2) return 0;
  return Math.abs((sorted[0] ?? 0) - (sorted[1] ?? 0));
};

/**
 * Wilson score 95 % confidence interval for a proportion.
 * Falls back to [p, p] when n is 0.
 */
const wilsonCI = (count: number, n: number): readonly [number, number] => {
  if (n === 0) return [0, 0];

  const p = count / n;
  const z = 1.96; // 95% confidence
  const center = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const denominator = 1 + (z * z) / n;

  const lo = Math.max(0, (center - spread) / denominator);
  const hi = Math.min(1, (center + spread) / denominator);

  return [lo, hi];
};

/** Shannon entropy (log base 2) of a frequency map. */
const shannonEntropy = (freqMap: Readonly<Record<string, number>>): number => {
  const total = Object.values(freqMap).reduce((s, v) => s + v, 0);
  if (total === 0) return 0;

  return Object.values(freqMap).reduce((entropy, count) => {
    if (count === 0) return entropy;
    const p = count / total;
    return entropy - p * Math.log2(p);
  }, 0);
};

/** Normalized Shannon entropy in the range [0, 1]. */
const normalizedEntropy = (freqMap: Readonly<Record<string, number>>): number => {
  const actionTypes = Object.keys(freqMap).length;
  if (actionTypes <= 1) return 0;
  return shannonEntropy(freqMap) / Math.log2(actionTypes);
};

const percentile = (sortedValues: readonly number[], fraction: number): number => {
  if (sortedValues.length === 0) return 0;

  const index = (sortedValues.length - 1) * fraction;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sortedValues[lowerIndex] ?? sortedValues[sortedValues.length - 1] ?? 0;
  const upper = sortedValues[upperIndex] ?? lower;

  if (lowerIndex === upperIndex) {
    return lower;
  }

  const weight = index - lowerIndex;
  return lower + (upper - lower) * weight;
};

const bootstrapCI = <T>(
  items: readonly T[],
  estimator: (sample: readonly T[]) => number,
  iterations = 500,
): readonly [number, number] => {
  if (items.length === 0) return [0, 0];

  const estimates = Array.from({ length: iterations }, () => {
    const sample = Array.from(
      { length: items.length },
      () => items[Math.floor(Math.random() * items.length)]!,
    );
    return estimator(sample);
  }).sort((a, b) => a - b);

  return [percentile(estimates, 0.025), percentile(estimates, 0.975)];
};

// ---------------------------------------------------------------------------
// KpiAggregator
// ---------------------------------------------------------------------------

export class KpiAggregator {
  /**
   * Competitive Match Rate — fraction of matches decided by ≤10% score diff.
   */
  computeCMR(matches: readonly MatchSummary[]): number {
    if (matches.length === 0) return 0;

    const competitive = matches.filter((m) => {
      const max = maxScore(m.finalScores);
      if (max === 0) return false;
      const diff = scoreDiff(m.finalScores);
      return diff / max <= 0.1;
    });

    return competitive.length / matches.length;
  }

  /**
   * Comeback Win Rate — fraction of matches where the eventual winner was
   * trailing at some point before winning.
   */
  computeCWR(matches: readonly MatchSummary[], turnEvents: readonly TurnEventSummary[]): number {
    if (matches.length === 0) return 0;

    const eventsByMatch = new Map<string, TurnEventSummary[]>();
    for (const event of turnEvents) {
      const bucket = eventsByMatch.get(event.matchId) ?? [];
      bucket.push(event);
      eventsByMatch.set(event.matchId, bucket);
    }

    const comebackWins = matches.filter((match) => {
      if (match.winnerId === null || match.winnerSeat === null) return false;

      const events = eventsByMatch.get(match.matchId) ?? [];
      return events.some((event) => {
        const winnerPerspectiveScoreDiff =
          event.seat === match.winnerSeat ? event.scoreDiffBefore : -event.scoreDiffBefore;
        return winnerPerspectiveScoreDiff < 0;
      });
    });

    return comebackWins.length / matches.length;
  }

  /**
   * Action Diversity Index — normalized Shannon entropy of action types.
   */
  computeADI(turnEvents: readonly TurnEventSummary[]): number {
    if (turnEvents.length === 0) return 0;

    const freqMap: Record<string, number> = {};
    for (const event of turnEvents) {
      freqMap[event.actionType] = (freqMap[event.actionType] ?? 0) + 1;
    }

    return normalizedEntropy(freqMap);
  }

  /**
   * Return In 24h Rate — fraction of matches whose participants returned within 24 h.
   * Uses pre-fetched ReturnEvent records; denominator is the number of matches.
   */
  computeRIR24(matches: readonly MatchSummary[], returnEvents: readonly ReturnEvent[]): number {
    if (matches.length === 0) return 0;

    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    const knownMatchIds = new Set(matches.map((match) => match.matchId));

    const qualifyingMatchIds = new Set(
      returnEvents.flatMap((re) => {
        const prevMs = new Date(re.previousMatchAt).getTime();
        const retMs = new Date(re.returnedAt).getTime();
        const elapsedMs = retMs - prevMs;
        if (
          elapsedMs < 0 ||
          elapsedMs > twentyFourHoursMs ||
          !knownMatchIds.has(re.previousMatchId)
        ) {
          return [];
        }

        return [re.previousMatchId];
      }),
    );

    return qualifyingMatchIds.size / matches.length;
  }

  /**
   * Aggregate all KPI metrics into a single KpiSnapshot.
   * This is the main entry point; all data must be passed in — no I/O here.
   */
  aggregate(params: AggregateParams): KpiSnapshot {
    const { matches, turnEvents, returnEvents } = params;
    const n = matches.length;

    const cmr = this.computeCMR(matches);
    const cwr = this.computeCWR(matches, turnEvents);
    const adi = this.computeADI(turnEvents);
    const rir24 = this.computeRIR24(matches, returnEvents);

    // Count numerators for Wilson CI
    const cmrCount = Math.round(cmr * n);
    const cwrCount = Math.round(cwr * n);
    const rir24Count = Math.round(rir24 * n);

    const metrics: Record<string, number> = {
      CMR: cmr,
      CWR: cwr,
      ADI: adi,
      RIR24: rir24,
    };

    const confidence: Record<string, readonly [number, number]> = {
      CMR: wilsonCI(cmrCount, n),
      CWR: wilsonCI(cwrCount, n),
      ADI: bootstrapCI(turnEvents, (sample) => this.computeADI(sample)),
      RIR24: wilsonCI(rir24Count, n),
    };

    return {
      gameId: params.gameId,
      ruleVersion: params.ruleVersion,
      queueType: params.queueType,
      ratingBracket: params.ratingBracket,
      period: params.period,
      sampleSize: n,
      metrics,
      confidence,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Convenience wrapper: compute a KpiDiff between two pre-aggregated snapshots.
   */
  diff(a: KpiSnapshot, b: KpiSnapshot): KpiDiff {
    return computeKpiDiff(a, b);
  }
}
