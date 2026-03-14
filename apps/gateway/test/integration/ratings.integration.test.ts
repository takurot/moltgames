import { type FastifyInstance } from 'fastify';
import { type Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { InMemoryRatingRepository } from '../../src/rating/repository.js';

describe('ratings api integration', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      ratingRepository: new InMemoryRatingRepository(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('processes a match result and exposes ratings endpoints', async () => {
    const processResponse = await app.inject({
      method: 'POST',
      url: '/internal/tasks/ratings/match-finished',
      payload: {
        matchId: 'match-1',
        participants: ['user-1', 'user-2'],
        winnerUid: 'user-1',
        endedAt: '2026-03-14T10:00:00.000Z',
      },
    });

    expect(processResponse.statusCode).toBe(200);
    expect(processResponse.json()).toMatchObject({
      status: 'ok',
      seasonId: '2026-q1',
    });

    const ratingResponse = await app.inject({
      method: 'GET',
      url: '/v1/ratings/2026-q1/user-1',
    });

    expect(ratingResponse.statusCode).toBe(200);
    expect(ratingResponse.json()).toEqual({
      status: 'ok',
      rating: {
        uid: 'user-1',
        seasonId: '2026-q1',
        elo: 1516,
        matches: 1,
        winRate: 1,
      },
    });

    const leaderboardResponse = await app.inject({
      method: 'GET',
      url: '/v1/leaderboards/2026-q1',
    });

    expect(leaderboardResponse.statusCode).toBe(200);
    expect(leaderboardResponse.json()).toMatchObject({
      status: 'ok',
      leaderboard: {
        seasonId: '2026-q1',
        entries: [
          { uid: 'user-1', rank: 1, elo: 1516 },
          { uid: 'user-2', rank: 2, elo: 1484 },
        ],
      },
    });
  });
});
