import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ReviewStatus, SuspiciousMatchFlag } from '../services/suspicious-match.js';
import {
  InMemorySuspiciousMatchStore,
  SuspiciousMatchStore,
} from '../services/suspicious-match.js';
import type { Redis } from 'ioredis';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getBearerToken = (header: string | undefined): string | null => {
  if (typeof header !== 'string') return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') return null;
  return parts[1] ?? null;
};

const isSecretMatch = (actual: string, expected: string): boolean => {
  const a = Buffer.from(actual);
  const e = Buffer.from(expected);
  if (a.length !== e.length) return false;
  return timingSafeEqual(a, e);
};

const VALID_REVIEW_STATUSES: readonly ReviewStatus[] = ['reviewed', 'cleared'];

const isReviewStatus = (value: unknown): value is ReviewStatus =>
  VALID_REVIEW_STATUSES.includes(value as ReviewStatus);

// ---------------------------------------------------------------------------
// Store type (allows injection in tests)
// ---------------------------------------------------------------------------

export type SuspiciousMatchStoreInterface = {
  flag(
    matchId: string,
    reason: string,
    flaggedBy?: 'system' | 'admin',
  ): Promise<SuspiciousMatchFlag>;
  get(matchId: string): Promise<SuspiciousMatchFlag | null>;
  update(
    matchId: string,
    patch: Partial<Pick<SuspiciousMatchFlag, 'reviewStatus' | 'reviewedAt' | 'reviewNote'>>,
  ): Promise<SuspiciousMatchFlag | null>;
  listAll(): Promise<SuspiciousMatchFlag[]>;
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface AdminRoutesOptions {
  internalTaskAuthToken?: string;
  suspiciousMatchStore?: SuspiciousMatchStoreInterface;
  redis?: Redis;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  opts: AdminRoutesOptions,
): Promise<void> {
  const { internalTaskAuthToken } = opts;

  // Choose store: prefer injected, then Redis-backed (prod), then in-memory (test)
  const store: SuspiciousMatchStoreInterface =
    opts.suspiciousMatchStore ??
    (opts.redis !== undefined
      ? new SuspiciousMatchStore(opts.redis)
      : new InMemorySuspiciousMatchStore());

  // ---------------------------------------------------------------------------
  // Auth pre-handler
  // ---------------------------------------------------------------------------
  const requireAdminAuth = (request: FastifyRequest, reply: FastifyReply): void => {
    const authHeader =
      typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined;
    const token = getBearerToken(authHeader);

    if (internalTaskAuthToken === undefined) {
      reply.status(401).send({ status: 'error', message: 'Admin auth is not configured' });
      return;
    }

    if (token === null || !isSecretMatch(token, internalTaskAuthToken)) {
      reply.status(401).send({ status: 'error', message: 'Unauthorized' });
    }
  };

  // ---------------------------------------------------------------------------
  // POST /v1/admin/matches/:matchId/flag
  // ---------------------------------------------------------------------------
  app.post<{
    Params: { matchId: string };
    Body: { reason?: unknown };
  }>('/v1/admin/matches/:matchId/flag', async (request, reply) => {
    requireAdminAuth(request, reply);
    if (reply.sent) return;

    const { matchId } = request.params;
    const { reason } = request.body;

    if (typeof reason !== 'string' || reason.trim().length === 0) {
      reply.status(400).send({ status: 'error', message: '"reason" must be a non-empty string' });
      return;
    }

    const flag = await store.flag(matchId, reason.trim(), 'admin');
    return { status: 'ok', matchId, flag };
  });

  // ---------------------------------------------------------------------------
  // GET /v1/admin/matches/flagged
  // ---------------------------------------------------------------------------
  app.get('/v1/admin/matches/flagged', async (request, reply) => {
    requireAdminAuth(request, reply);
    if (reply.sent) return;

    const flags = await store.listAll();
    return { status: 'ok', flags };
  });

  // ---------------------------------------------------------------------------
  // POST /v1/admin/matches/:matchId/review
  // ---------------------------------------------------------------------------
  app.post<{
    Params: { matchId: string };
    Body: { status?: unknown; note?: unknown };
  }>('/v1/admin/matches/:matchId/review', async (request, reply) => {
    requireAdminAuth(request, reply);
    if (reply.sent) return;

    const { matchId } = request.params;
    const { status, note } = request.body;

    if (!isReviewStatus(status)) {
      reply.status(400).send({
        status: 'error',
        message: `"status" must be one of: ${VALID_REVIEW_STATUSES.join(', ')}`,
      });
      return;
    }

    if (note !== undefined && typeof note !== 'string') {
      reply.status(400).send({ status: 'error', message: '"note" must be a string if provided' });
      return;
    }

    const patch: Parameters<typeof store.update>[1] = {
      reviewStatus: status,
      reviewedAt: new Date().toISOString(),
    };
    if (typeof note === 'string') {
      patch.reviewNote = note;
    }

    const updated = await store.update(matchId, patch);

    if (updated === null) {
      reply.status(404).send({ status: 'error', message: `Match ${matchId} is not flagged` });
      return;
    }

    return { status: 'ok', matchId, flag: updated };
  });
}
