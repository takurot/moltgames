/**
 * KPI API routes — PR-18b
 *
 * GET /v1/kpi/summary?gameId=&days=7&ruleVersion=
 *   Returns KpiSnapshot[] for the specified game over the given time window.
 *   NOTE: Currently returns stub in-memory data.
 *         Firestore integration (reading from the metrics collection) is
 *         intentionally deferred to the Firestore pipeline PR.
 *
 * GET /v1/kpi/diff?gameId=&ruleVersionA=&ruleVersionB=
 *   Returns a KpiDiff comparing two rule versions for a given game.
 *   NOTE: Same stub approach — real data will come from Firestore.
 */

import type { FastifyInstance } from 'fastify';

import { computeKpiDiff, type KpiSnapshot } from '@moltgames/domain';
import {
  KpiAggregator,
  type MatchSummary,
  type TurnEventSummary,
} from '../services/kpi-aggregator.js';
import { sendRestApiError } from '../api-error.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getQueryStringValue = (value: unknown): string | null => {
  if (typeof value === 'string' && value.length > 0) return value;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    typeof value[0] === 'string' &&
    value[0].length > 0
  ) {
    return value[0];
  }
  return null;
};

const parsePositiveDays = (raw: string | null): number | null => {
  if (raw === null) return 7; // default
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

// ---------------------------------------------------------------------------
// Stub data generator
// NOTE: Replace with Firestore reads once the metrics pipeline is in place.
// ---------------------------------------------------------------------------

const makeStubMatches = (count: number): MatchSummary[] =>
  Array.from({ length: count }, (_, i) => ({
    matchId: `stub-match-${i}`,
    gameId: 'stub',
    ruleVersion: '1.0.0',
    queueType: 'ranked',
    ratingBracket: '1400-1600',
    winnerId: i % 3 !== 0 ? 'agent-a' : null,
    winnerSeat: i % 2 === 0 ? 'first' : 'second',
    finalScores: { 'agent-a': 50 + (i % 10), 'agent-b': 50 - (i % 10) },
    durationMs: 90_000 + i * 1_000,
    createdAt: new Date(Date.now() - i * 3_600_000).toISOString(),
  }));

const makeStubTurnEvents = (): TurnEventSummary[] => {
  const actions = ['attack', 'defend', 'negotiate', 'flee'];
  return Array.from({ length: 40 }, (_, i) => ({
    matchId: `stub-match-${i % 10}`,
    actionType: actions[i % actions.length] ?? 'attack',
    seat: i % 2 === 0 ? 'first' : 'second',
    scoreDiffBefore: i % 5,
    scoreDiffAfter: (i % 5) + 1,
  }));
};

const agg = new KpiAggregator();

const buildStubSnapshot = (gameId: string, ruleVersion: string, days: number): KpiSnapshot => {
  const matches = makeStubMatches(Math.max(10, days * 5));
  const turnEvents = makeStubTurnEvents();

  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const period = `${from.toISOString().slice(0, 10)}/${now.toISOString().slice(0, 10)}`;

  return agg.aggregate({
    gameId,
    ruleVersion,
    queueType: 'ranked',
    ratingBracket: 'all',
    period,
    matches,
    turnEvents,
    returnEvents: [],
  });
};

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export const registerKpiRoutes = (app: FastifyInstance): void => {
  // GET /v1/kpi/summary
  app.get('/v1/kpi/summary', async (request, reply) => {
    const query = request.query as Record<string, unknown>;

    const gameId = getQueryStringValue(query.gameId);
    if (gameId === null) {
      return sendRestApiError(reply, 400, 'INVALID_REQUEST', 'gameId is required');
    }

    const daysRaw = getQueryStringValue(query.days);
    const days = parsePositiveDays(daysRaw);
    if (days === null) {
      return sendRestApiError(reply, 400, 'INVALID_REQUEST', 'days must be a positive integer');
    }

    const ruleVersion = getQueryStringValue(query.ruleVersion) ?? 'latest';

    // TODO(PR-18c): Replace stub with real Firestore reads from kpi_snapshots collection.
    const snapshot = buildStubSnapshot(gameId, ruleVersion, days);

    return reply.send({ status: 'ok', snapshots: [snapshot] });
  });

  // GET /v1/kpi/diff
  app.get('/v1/kpi/diff', async (request, reply) => {
    const query = request.query as Record<string, unknown>;

    const gameId = getQueryStringValue(query.gameId);
    if (gameId === null) {
      return sendRestApiError(reply, 400, 'INVALID_REQUEST', 'gameId is required');
    }

    const ruleVersionA = getQueryStringValue(query.ruleVersionA);
    if (ruleVersionA === null) {
      return sendRestApiError(reply, 400, 'INVALID_REQUEST', 'ruleVersionA is required');
    }

    const ruleVersionB = getQueryStringValue(query.ruleVersionB);
    if (ruleVersionB === null) {
      return sendRestApiError(reply, 400, 'INVALID_REQUEST', 'ruleVersionB is required');
    }

    // TODO(PR-18c): Replace stub with real Firestore reads.
    const snapshotA = buildStubSnapshot(gameId, ruleVersionA, 7);
    const snapshotB = buildStubSnapshot(gameId, ruleVersionB, 7);

    const diff = computeKpiDiff(snapshotA, snapshotB);

    return reply.send({ status: 'ok', diff });
  });
};
