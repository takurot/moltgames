import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';

import type { Match, Rating, Season, MatchStatus } from '@moltgames/domain';
import { InMemoryMatchRepository, type MatchRepository } from '../../../src/match/repository.js';
import { InMemoryRatingRepository } from '../../../src/rating/repository.js';
import {
  getExpandedQueueRatingWindow,
  MatchQueueService,
  type QueueClock,
  QUEUE_ENTRY_TTL_SECONDS,
  MATCHED_ENTRY_TTL_SECONDS,
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
  beforeEach(async () => {
    // RedisMock instances share global in-memory state within the same process.
    // Flush before each test to prevent cross-test contamination.
    await (new RedisMock() as unknown as Redis).flushall();
  });

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

  it('sets TTL on queue entry Redis keys', async () => {
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

    // Check that active key has a TTL set (ioredis-mock returns -1 for no TTL)
    const activeTtl = await redis.ttl('moltgames:queue-active:user-1:prompt-injection-arena');
    expect(activeTtl).toBeGreaterThan(0);
    expect(activeTtl).toBeLessThanOrEqual(QUEUE_ENTRY_TTL_SECONDS);
  });

  it('sets TTL on matched entry Redis keys after matchmaking', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const clock = new FixedClock('2026-03-28T00:00:00.000Z');
    const ratingRepository = new InMemoryRatingRepository();
    await saveRatings(ratingRepository, [
      { uid: 'user-1', elo: 1500 },
      { uid: 'user-2', elo: 1500 },
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

    await service.enqueue({ uid: 'user-1', gameId: 'prompt-injection-arena', agentId: 'agent-1' });
    const result = await service.enqueue({
      uid: 'user-2',
      gameId: 'prompt-injection-arena',
      agentId: 'agent-2',
    });

    expect(result.status).toBe('MATCHED');

    // After matching, the active key for user-1 should still exist (pointing to the matched entry)
    const activeTtl = await redis.ttl('moltgames:queue-active:user-1:prompt-injection-arena');
    expect(activeTtl).toBeGreaterThan(0);
    expect(activeTtl).toBeLessThanOrEqual(MATCHED_ENTRY_TTL_SECONDS);
  });

  it('skips matchmaking when the queue lock is already held', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const clock = new FixedClock('2026-03-28T00:00:00.000Z');
    const ratingRepository = new InMemoryRatingRepository();
    await saveRatings(ratingRepository, [
      { uid: 'user-1', elo: 1500 },
      { uid: 'user-2', elo: 1500 },
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

    // Enqueue user-1 only (no match possible yet)
    await service.enqueue({ uid: 'user-1', gameId: 'prompt-injection-arena', agentId: 'agent-1' });

    // Manually add user-2 entry to Redis (bypassing enqueue) so we can control processQueue timing
    await redis.set(
      'moltgames:queue-active:user-2:prompt-injection-arena',
      'entry-user-2',
      'EX',
      86400,
    );
    const user2Entry = {
      entryId: 'entry-user-2',
      uid: 'user-2',
      gameId: 'prompt-injection-arena',
      agentId: 'agent-2',
      rating: 1500,
      queuedAt: '2026-03-28T00:00:00.000Z',
      queuedAtMs: new Date('2026-03-28T00:00:00.000Z').getTime(),
      status: 'QUEUED',
    };
    await redis.set('moltgames:queue-entry:entry-user-2', JSON.stringify(user2Entry), 'EX', 86400);
    await redis.rpush('moltgames:queue:prompt-injection-arena', 'entry-user-2');

    // Pre-acquire the lock — simulates another process running processQueue
    await redis.set('moltgames:queue-lock:prompt-injection-arena', '1', 'EX', 10, 'NX');

    // processQueue should return immediately without creating a match
    await service.processQueue('prompt-injection-arena');

    expect(engineClient.startMatch).not.toHaveBeenCalled();
    expect((await service.getStatus('user-1', 'prompt-injection-arena'))?.status).toBe('QUEUED');
  });

  it('propagates matchRepository.save failure so queue entries remain QUEUED', async () => {
    class FailingMatchRepository implements MatchRepository {
      async get(_matchId: string): Promise<Match | null> {
        return null;
      }
      async listByParticipant(_uid: string): Promise<Match[]> {
        return [];
      }
      async save(_match: Match): Promise<void> {
        throw new Error('Firestore unavailable');
      }
      async updateStatus(
        _matchId: string,
        _status: MatchStatus,
        _updates?: Partial<Pick<Match, 'startedAt' | 'endedAt'>>,
      ): Promise<void> {
        return;
      }
    }

    const redis = new RedisMock() as unknown as Redis;
    const clock = new FixedClock('2026-03-28T00:00:00.000Z');
    const ratingRepository = new InMemoryRatingRepository();
    const matchRepository = new FailingMatchRepository();
    const engineClient = createEngineClient();
    const service = new MatchQueueService({
      redis,
      clock,
      ratingRepository,
      matchRepository,
      engineClient,
    });

    // Seed both entries directly in Redis to avoid processQueue running during enqueue
    const now = clock.now();
    const nowMs = now.getTime();
    const gameId = 'prompt-injection-arena';
    const entry1 = {
      entryId: 'entry-1',
      uid: 'user-1',
      gameId,
      agentId: 'agent-1',
      rating: 1500,
      queuedAt: now.toISOString(),
      queuedAtMs: nowMs,
      status: 'QUEUED',
    };
    const entry2 = {
      entryId: 'entry-2',
      uid: 'user-2',
      gameId,
      agentId: 'agent-2',
      rating: 1500,
      queuedAt: now.toISOString(),
      queuedAtMs: nowMs,
      status: 'QUEUED',
    };
    const seedPipeline = redis.pipeline();
    seedPipeline.set(`moltgames:queue-entry:entry-1`, JSON.stringify(entry1), 'EX', 86400);
    seedPipeline.set(`moltgames:queue-active:user-1:${gameId}`, 'entry-1', 'EX', 86400);
    seedPipeline.set(`moltgames:queue-entry:entry-2`, JSON.stringify(entry2), 'EX', 86400);
    seedPipeline.set(`moltgames:queue-active:user-2:${gameId}`, 'entry-2', 'EX', 86400);
    seedPipeline.rpush(`moltgames:queue:${gameId}`, 'entry-1', 'entry-2');
    await seedPipeline.exec();

    // processQueue finds both entries, tries to create a match, but save fails
    await expect(service.processQueue(gameId)).rejects.toThrow('Firestore unavailable');

    // Entries must still be QUEUED, not MATCHED, so a retry can attempt matching again
    expect((await service.getStatus('user-1', gameId))?.status).toBe('QUEUED');
    expect((await service.getStatus('user-2', gameId))?.status).toBe('QUEUED');
  });
});
