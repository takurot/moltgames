import type { Leaderboard } from '@moltgames/domain';
import RedisMock from 'ioredis-mock';
import { type Redis } from 'ioredis';
import { describe, expect, it, beforeEach } from 'vitest';

import { RedisLeaderboardCache } from '../../../src/rating/leaderboard-cache.js';

const makeLeaderboard = (seasonId: string): Leaderboard => ({
  seasonId,
  generatedAt: '2026-03-14T10:00:00.000Z',
  entries: [
    { uid: 'user-1', rank: 1, elo: 1516, matches: 1, winRate: 1 },
    { uid: 'user-2', rank: 2, elo: 1484, matches: 1, winRate: 0 },
  ],
});

describe('RedisLeaderboardCache', () => {
  let redis: Redis;
  let cache: RedisLeaderboardCache;

  beforeEach(() => {
    redis = new RedisMock() as unknown as Redis;
    cache = new RedisLeaderboardCache(redis);
  });

  it('returns null on cache miss', async () => {
    const result = await cache.get('2026-q1');
    expect(result).toBeNull();
  });

  it('stores and retrieves a leaderboard', async () => {
    const leaderboard = makeLeaderboard('2026-q1');
    await cache.set(leaderboard);

    const result = await cache.get('2026-q1');
    expect(result).toEqual(leaderboard);
  });

  it('stores different seasons independently', async () => {
    const q1 = makeLeaderboard('2026-q1');
    const q2 = makeLeaderboard('2026-q2');
    await cache.set(q1);
    await cache.set(q2);

    expect(await cache.get('2026-q1')).toEqual(q1);
    expect(await cache.get('2026-q2')).toEqual(q2);
  });

  it('invalidates a cached leaderboard', async () => {
    const leaderboard = makeLeaderboard('2026-q1');
    await cache.set(leaderboard);
    await cache.invalidate('2026-q1');

    const result = await cache.get('2026-q1');
    expect(result).toBeNull();
  });

  it('sets TTL on cached leaderboard', async () => {
    const shortTtlCache = new RedisLeaderboardCache(redis, 1);
    const leaderboard = makeLeaderboard('2026-q1');
    await shortTtlCache.set(leaderboard);

    const ttl = await redis.ttl('leaderboard:2026-q1');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1);
  });

  it('returns null for invalid cached JSON', async () => {
    await redis.set('leaderboard:2026-q1', 'not-valid-json');
    const result = await cache.get('2026-q1');
    expect(result).toBeNull();
  });
});
