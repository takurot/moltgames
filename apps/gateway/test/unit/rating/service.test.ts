import type { Leaderboard } from '@moltgames/domain';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryRatingRepository } from '../../../src/rating/repository.js';
import { RatingService } from '../../../src/rating/service.js';
import type { LeaderboardCache } from '../../../src/rating/leaderboard-cache.js';

describe('rating service', () => {
  it('creates a quarter season and updates ratings plus leaderboard', async () => {
    const repository = new InMemoryRatingRepository();
    const service = new RatingService({ repository, kFactor: 32 });

    const result = await service.processMatchResult({
      matchId: 'match-1',
      participants: ['user-1', 'user-2'],
      winnerUid: 'user-1',
      endedAt: '2026-03-14T10:00:00.000Z',
    });

    expect(result.season.seasonId).toBe('2026-q1');
    expect(result.updatedRatings).toEqual([
      {
        uid: 'user-1',
        seasonId: '2026-q1',
        elo: 1516,
        matches: 1,
        winRate: 1,
      },
      {
        uid: 'user-2',
        seasonId: '2026-q1',
        elo: 1484,
        matches: 1,
        winRate: 0,
      },
    ]);

    const leaderboard = await repository.getLeaderboard('2026-q1');
    expect(leaderboard).toEqual({
      seasonId: '2026-q1',
      generatedAt: expect.any(String),
      entries: [
        {
          uid: 'user-1',
          rank: 1,
          elo: 1516,
          matches: 1,
          winRate: 1,
        },
        {
          uid: 'user-2',
          rank: 2,
          elo: 1484,
          matches: 1,
          winRate: 0,
        },
      ],
    });
  });

  it('archives the previous quarter when a new quarter becomes active', async () => {
    const repository = new InMemoryRatingRepository();
    const service = new RatingService({ repository });

    await service.ensureSeasonForDate('2026-03-31T10:00:00.000Z');
    const currentSeason = await service.ensureSeasonForDate('2026-04-01T00:00:00.000Z');

    expect(currentSeason.seasonId).toBe('2026-q2');
    expect(await repository.getSeason('2026-q1')).toMatchObject({
      seasonId: '2026-q1',
      status: 'ARCHIVED',
    });
    expect(await repository.getSeason('2026-q2')).toMatchObject({
      seasonId: '2026-q2',
      status: 'ACTIVE',
    });
  });

  it('keeps archived seasons archived when late match results arrive', async () => {
    const repository = new InMemoryRatingRepository();
    const service = new RatingService({ repository });

    await repository.saveSeason({
      seasonId: '2026-q1',
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-03-31T23:59:59.999Z',
      status: 'ARCHIVED',
    });
    await repository.saveSeason({
      seasonId: '2026-q2',
      startsAt: '2026-04-01T00:00:00.000Z',
      endsAt: '2026-06-30T23:59:59.999Z',
      status: 'ACTIVE',
    });

    const result = await service.processMatchResult({
      matchId: 'match-late-q1',
      participants: ['user-1', 'user-2'],
      winnerUid: 'user-2',
      endedAt: '2026-03-14T10:00:00.000Z',
    });

    expect(result.season).toMatchObject({
      seasonId: '2026-q1',
      status: 'ARCHIVED',
    });
    expect(await repository.getSeason('2026-q1')).toMatchObject({
      seasonId: '2026-q1',
      status: 'ARCHIVED',
    });
    expect(await repository.getSeason('2026-q2')).toMatchObject({
      seasonId: '2026-q2',
      status: 'ACTIVE',
    });
  });
});

describe('rating service with leaderboard cache', () => {
  it('populates the cache after processing a match result', async () => {
    const repository = new InMemoryRatingRepository();
    const cache: LeaderboardCache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      invalidate: vi.fn().mockResolvedValue(undefined),
    };
    const service = new RatingService({ repository, cache });

    const result = await service.processMatchResult({
      matchId: 'match-1',
      participants: ['user-1', 'user-2'],
      winnerUid: 'user-1',
      endedAt: '2026-03-14T10:00:00.000Z',
    });

    expect(cache.set).toHaveBeenCalledWith(result.leaderboard);
  });

  it('returns leaderboard from cache when available', async () => {
    const repository = new InMemoryRatingRepository();
    const cachedLeaderboard: Leaderboard = {
      seasonId: '2026-q1',
      generatedAt: '2026-03-14T09:00:00.000Z',
      entries: [{ uid: 'user-cached', rank: 1, elo: 2000, matches: 5, winRate: 0.8 }],
    };
    const cache: LeaderboardCache = {
      get: vi.fn().mockResolvedValue(cachedLeaderboard),
      set: vi.fn().mockResolvedValue(undefined),
      invalidate: vi.fn().mockResolvedValue(undefined),
    };
    const service = new RatingService({ repository, cache });

    const result = await service.getLeaderboard('2026-q1');

    expect(result).toEqual(cachedLeaderboard);
    expect(cache.get).toHaveBeenCalledWith('2026-q1');
  });

  it('falls back to repository when cache misses on getLeaderboard', async () => {
    const repository = new InMemoryRatingRepository();
    await repository.saveLeaderboard({
      seasonId: '2026-q1',
      generatedAt: '2026-03-14T10:00:00.000Z',
      entries: [{ uid: 'user-repo', rank: 1, elo: 1600, matches: 2, winRate: 1 }],
    });
    const cache: LeaderboardCache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      invalidate: vi.fn().mockResolvedValue(undefined),
    };
    const service = new RatingService({ repository, cache });

    const result = await service.getLeaderboard('2026-q1');

    expect(result?.entries[0].uid).toBe('user-repo');
  });
});
