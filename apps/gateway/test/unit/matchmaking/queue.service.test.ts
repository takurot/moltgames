import { describe, expect, it, vi } from 'vitest';
import { type Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';

import type { Match, Rating, Season } from '@moltgames/domain';
import { InMemoryMatchRepository } from '../../../src/match/repository.js';
import { InMemoryRatingRepository } from '../../../src/rating/repository.js';
import {
  getExpandedQueueRatingWindow,
  MatchQueueService,
  type QueueClock,
} from '../../../src/matchmaking/queue-service.js';
import type { GatewayEngineClient } from '../../../src/app.js';

class FixedClock implements QueueClock {
  #epochMs: number;

  constructor(iso8601: string) {
    this.#epochMs = new Date(iso8601).getTime();
  }

  now(): Date {
    return new Date(this.#epochMs);
  }

  advanceSeconds(seconds: number): void {
    this.#epochMs += seconds * 1000;
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
  getMatchMeta: vi.fn(async () => ({
    gameId: 'prompt-injection-arena',
    ruleVersion: '1.0.0',
  })),
});

describe('match queue service', () => {
  it('matches opponents within the default 200 elo window', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const clock = new FixedClock('2026-03-28T00:00:00.000Z');
    const ratingRepository = new InMemoryRatingRepository();
    await saveRatings(ratingRepository, [
      { uid: 'user-1', elo: 1500 },
      { uid: 'user-2', elo: 1640 },
    ]);

    const matchRepository = new InMemoryMatchRepository();
    const engineClient = createEngineClient();
    const service = new MatchQueueService({
      redis,
      clock,
      ratingRepository,
      matchRepository,
      engineClient,
    });

    await service.enqueue({
      uid: 'user-1',
      gameId: 'prompt-injection-arena',
      agentId: 'agent-1',
    });
    const secondResult = await service.enqueue({
      uid: 'user-2',
      gameId: 'prompt-injection-arena',
      agentId: 'agent-2',
    });

    expect(secondResult.status).toBe('MATCHED');
    expect(secondResult.matchId).toBeTypeOf('string');
    expect(engineClient.startMatch).toHaveBeenCalledTimes(1);

    const savedMatch = await matchRepository.get(secondResult.matchId!);
    expect(savedMatch).toMatchObject<Partial<Match>>({
      matchId: secondResult.matchId,
      gameId: 'prompt-injection-arena',
      status: 'CREATED',
    });
  });

  it('expands the elo window from 200 to 400 and then to unlimited as wait time increases', () => {
    expect(getExpandedQueueRatingWindow(0)).toBe(200);
    expect(getExpandedQueueRatingWindow(29)).toBe(200);
    expect(getExpandedQueueRatingWindow(30)).toBe(400);
    expect(getExpandedQueueRatingWindow(59)).toBe(400);
    expect(getExpandedQueueRatingWindow(60)).toBe(Number.POSITIVE_INFINITY);
  });

  it('supports leaving the queue before a match is found', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const clock = new FixedClock('2026-03-28T00:00:00.000Z');
    const ratingRepository = new InMemoryRatingRepository();
    const matchRepository = new InMemoryMatchRepository();
    const engineClient = createEngineClient();
    const service = new MatchQueueService({
      redis,
      clock,
      ratingRepository,
      matchRepository,
      engineClient,
    });

    await service.enqueue({
      uid: 'user-1',
      gameId: 'prompt-injection-arena',
      agentId: 'agent-1',
    });

    await service.leave('user-1', 'prompt-injection-arena');

    expect(await service.getStatus('user-1', 'prompt-injection-arena')).toBeNull();
  });
});
