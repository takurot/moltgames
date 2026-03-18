import type { Redis } from 'ioredis';

import type { Leaderboard } from '@moltgames/domain';

const DEFAULT_TTL_SECONDS = 600; // 10 minutes

const cacheKey = (seasonId: string): string => `leaderboard:${seasonId}`;

export interface LeaderboardCache {
  get(seasonId: string): Promise<Leaderboard | null>;
  set(leaderboard: Leaderboard): Promise<void>;
  invalidate(seasonId: string): Promise<void>;
}

export class RedisLeaderboardCache implements LeaderboardCache {
  constructor(
    private redis: Redis,
    private ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  async get(seasonId: string): Promise<Leaderboard | null> {
    const data = await this.redis.get(cacheKey(seasonId));
    if (data === null) {
      return null;
    }
    try {
      return JSON.parse(data) as Leaderboard;
    } catch {
      return null;
    }
  }

  async set(leaderboard: Leaderboard): Promise<void> {
    await this.redis.setex(
      cacheKey(leaderboard.seasonId),
      this.ttlSeconds,
      JSON.stringify(leaderboard),
    );
  }

  async invalidate(seasonId: string): Promise<void> {
    await this.redis.del(cacheKey(seasonId));
  }
}
