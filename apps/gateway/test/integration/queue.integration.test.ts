import { type FastifyInstance } from 'fastify';
import { type Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Match, Rating, Season } from '@moltgames/domain';
import { createApp, type GatewayEngineClient } from '../../src/app.js';
import {
  type FirebaseIdTokenVerifier,
  type VerifiedFirebaseIdToken,
} from '../../src/auth/firebase-auth.js';
import { InMemoryMatchRepository } from '../../src/match/repository.js';
import { InMemoryRatingRepository } from '../../src/rating/repository.js';

class MockVerifier implements FirebaseIdTokenVerifier {
  async verifyIdToken(idToken: string): Promise<VerifiedFirebaseIdToken> {
    switch (idToken) {
      case 'token-user-1':
        return {
          uid: 'user-1',
          providerId: 'google.com',
          customClaims: { roles: ['player'] },
        };
      case 'token-user-2':
        return {
          uid: 'user-2',
          providerId: 'google.com',
          customClaims: { roles: ['player'] },
        };
      default:
        throw new Error('Invalid token');
    }
  }
}

const activeSeason: Season = {
  seasonId: '2026-q1',
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2026-03-31T23:59:59.999Z',
  status: 'ACTIVE',
};

const saveRatings = async (
  repository: InMemoryRatingRepository,
  ratings: readonly Pick<Rating, 'uid' | 'elo'>[],
) => {
  await repository.saveSeason(activeSeason);
  await Promise.all(
    ratings.map((rating) =>
      repository.saveRating({
        uid: rating.uid,
        seasonId: activeSeason.seasonId,
        elo: rating.elo,
        matches: 10,
        winRate: 0.5,
      }),
    ),
  );
};

const createEngineClient = (): GatewayEngineClient => ({
  startMatch: vi.fn(async () => undefined),
  getTools: vi.fn(async () => []),
  callTool: vi.fn(async () => ({
    request_id: 'unused',
    status: 'ok' as const,
    result: {},
  })),
  getMatchMeta: vi.fn(async (matchId) => ({
    gameId: 'prompt-injection-arena',
    ruleVersion: matchId.startsWith('manual-') ? '2.0.0' : '1.0.0',
  })),
});

const makeMatch = (overrides: Partial<Match> = {}): Match => ({
  matchId: 'manual-1',
  gameId: 'prompt-injection-arena',
  status: 'FINISHED',
  participants: [
    { uid: 'user-1', agentId: 'agent-1', role: 'PLAYER' },
    { uid: 'user-2', agentId: 'agent-2', role: 'PLAYER' },
  ],
  startedAt: '2026-03-28T01:00:00.000Z',
  endedAt: '2026-03-28T01:10:00.000Z',
  ruleId: 'prompt-injection-arena',
  ruleVersion: '1.0.0',
  region: 'us-central1',
  ...overrides,
});

describe('queue and match listing integration', () => {
  let app: FastifyInstance;
  let matchRepository: InMemoryMatchRepository;
  let ratingRepository: InMemoryRatingRepository;

  beforeEach(async () => {
    matchRepository = new InMemoryMatchRepository();
    ratingRepository = new InMemoryRatingRepository();
    await saveRatings(ratingRepository, [
      { uid: 'user-1', elo: 1500 },
      { uid: 'user-2', elo: 1625 },
    ]);

    app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      engineClient: createEngineClient(),
      matchRepository,
      ratingRepository,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('matches two queued users and exposes queue status', async () => {
    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/matches/queue',
      headers: {
        authorization: 'Bearer token-user-1',
      },
      payload: {
        gameId: 'prompt-injection-arena',
        agentId: 'agent-1',
      },
    });

    expect(firstResponse.statusCode).toBe(202);
    expect(firstResponse.json()).toMatchObject({
      status: 'QUEUED',
    });

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/matches/queue',
      headers: {
        authorization: 'Bearer token-user-2',
      },
      payload: {
        gameId: 'prompt-injection-arena',
        agentId: 'agent-2',
      },
    });

    expect(secondResponse.statusCode).toBe(201);
    const secondBody = secondResponse.json<{ status: string; matchId?: string }>();
    expect(secondBody.status).toBe('MATCHED');
    expect(secondBody.matchId).toBeTypeOf('string');

    const statusResponse = await app.inject({
      method: 'GET',
      url: '/v1/matches/queue/status?gameId=prompt-injection-arena',
      headers: {
        authorization: 'Bearer token-user-1',
      },
    });

    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      status: 'MATCHED',
      matchId: secondBody.matchId,
    });
  });

  it('allows a queued user to leave before matching', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/matches/queue',
      headers: {
        authorization: 'Bearer token-user-1',
      },
      payload: {
        gameId: 'prompt-injection-arena',
        agentId: 'agent-1',
      },
    });

    const leaveResponse = await app.inject({
      method: 'DELETE',
      url: '/v1/matches/queue?gameId=prompt-injection-arena',
      headers: {
        authorization: 'Bearer token-user-1',
      },
    });

    expect(leaveResponse.statusCode).toBe(204);

    const statusResponse = await app.inject({
      method: 'GET',
      url: '/v1/matches/queue/status?gameId=prompt-injection-arena',
      headers: {
        authorization: 'Bearer token-user-1',
      },
    });

    expect(statusResponse.statusCode).toBe(404);
    expect(statusResponse.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Queue entry was not found',
        retryable: false,
      },
    });
  });

  it('lists matches for the authenticated user with cursor pagination', async () => {
    await matchRepository.save(
      makeMatch({
        matchId: 'manual-1',
        participants: [
          { uid: 'user-1', agentId: 'agent-1', role: 'PLAYER' },
          { uid: 'user-9', agentId: 'agent-x', role: 'PLAYER' },
        ],
        startedAt: '2026-03-28T03:00:00.000Z',
        endedAt: '2026-03-28T03:10:00.000Z',
      }),
    );
    await matchRepository.save(
      makeMatch({
        matchId: 'manual-2',
        participants: [
          { uid: 'user-1', agentId: 'agent-1', role: 'PLAYER' },
          { uid: 'user-8', agentId: 'agent-y', role: 'PLAYER' },
        ],
        startedAt: '2026-03-28T02:00:00.000Z',
        endedAt: '2026-03-28T02:10:00.000Z',
      }),
    );
    await matchRepository.save(
      makeMatch({
        matchId: 'manual-3',
        participants: [
          { uid: 'user-1', agentId: 'agent-1', role: 'PLAYER' },
          { uid: 'user-7', agentId: 'agent-z', role: 'PLAYER' },
        ],
        startedAt: '2026-03-28T01:00:00.000Z',
        endedAt: '2026-03-28T01:10:00.000Z',
      }),
    );

    const firstPage = await app.inject({
      method: 'GET',
      url: '/v1/matches?agentId=agent-1&limit=2',
      headers: {
        authorization: 'Bearer token-user-1',
      },
    });

    expect(firstPage.statusCode).toBe(200);
    const firstPageBody = firstPage.json<{
      items: Array<{ matchId: string }>;
      nextCursor: string | null;
    }>();
    expect(firstPageBody.items.map((match) => match.matchId)).toEqual(['manual-1', 'manual-2']);
    expect(firstPageBody.nextCursor).toBeTypeOf('string');

    const secondPage = await app.inject({
      method: 'GET',
      url: `/v1/matches?agentId=agent-1&limit=2&cursor=${encodeURIComponent(firstPageBody.nextCursor!)}`,
      headers: {
        authorization: 'Bearer token-user-1',
      },
    });

    expect(secondPage.statusCode).toBe(200);
    expect(
      secondPage.json<{
        items: Array<{ matchId: string }>;
        nextCursor: string | null;
      }>(),
    ).toMatchObject({
      items: [{ matchId: 'manual-3' }],
      nextCursor: null,
    });
  });

  it('returns a structured validation error for invalid match list queries', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/matches?limit=200',
      headers: {
        authorization: 'Bearer token-user-1',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'limit must be between 1 and 100',
        retryable: false,
      },
    });
  });
});
