import type { Leaderboard, LeaderboardEntry, Rating, Season } from '@moltgames/domain';

import { calculateEloRatings } from './elo.js';
import type { LeaderboardCache } from './leaderboard-cache.js';
import type { RatingRepository } from './repository.js';

const DEFAULT_ELO = 1500;
const DEFAULT_K_FACTOR = 32;

export interface MatchResultJob {
  matchId: string;
  participants: string[];
  winnerUid?: string | null;
  endedAt: string;
}

export interface RatingServiceOptions {
  repository: RatingRepository;
  kFactor?: number;
  cache?: LeaderboardCache;
}

const createSeasonId = (year: number, quarter: number): string => `${year}-q${quarter}`;

const getQuarter = (monthIndex: number): number => Math.floor(monthIndex / 3) + 1;

const getQuarterBounds = (date: Date): Omit<Season, 'status'> => {
  const year = date.getUTCFullYear();
  const quarter = getQuarter(date.getUTCMonth());
  const quarterStartMonth = (quarter - 1) * 3;

  const startsAt = new Date(Date.UTC(year, quarterStartMonth, 1, 0, 0, 0, 0));
  const endsAt = new Date(Date.UTC(year, quarterStartMonth + 3, 0, 23, 59, 59, 999));

  return {
    seasonId: createSeasonId(year, quarter),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
};

const createDefaultRating = (seasonId: string, uid: string): Rating => ({
  uid,
  seasonId,
  elo: DEFAULT_ELO,
  matches: 0,
  winRate: 0,
});

const countWins = (rating: Rating): number => Math.round(rating.winRate * rating.matches);

const scoreForParticipant = (winnerUid: string | null | undefined, uid: string): number => {
  if (winnerUid === null || winnerUid === undefined) {
    return 0.5;
  }
  return winnerUid === uid ? 1 : 0;
};

const buildLeaderboard = (seasonId: string, ratings: readonly Rating[]): Leaderboard => {
  const entries: LeaderboardEntry[] = ratings.map((rating, index) => ({
    uid: rating.uid,
    rank: index + 1,
    elo: rating.elo,
    matches: rating.matches,
    winRate: rating.winRate,
  }));

  return {
    seasonId,
    generatedAt: new Date().toISOString(),
    entries,
  };
};

export class RatingService {
  private repository: RatingRepository;
  private kFactor: number;
  private cache: LeaderboardCache | undefined;

  constructor(options: RatingServiceOptions) {
    this.repository = options.repository;
    this.kFactor = options.kFactor ?? DEFAULT_K_FACTOR;
    this.cache = options.cache;
  }

  private async archiveOtherActiveSeasons(activeSeasonId: string): Promise<void> {
    const seasons = await this.repository.listSeasons();
    for (const season of seasons) {
      if (season.status === 'ACTIVE' && season.seasonId !== activeSeasonId) {
        await this.repository.saveSeason({ ...season, status: 'ARCHIVED' });
      }
    }
  }

  async ensureSeasonForDate(endedAt: string): Promise<Season> {
    const date = new Date(endedAt);
    if (Number.isNaN(date.getTime())) {
      throw new Error('endedAt must be a valid ISO timestamp');
    }

    const bounds = getQuarterBounds(date);
    const existing = await this.repository.getSeason(bounds.seasonId);
    if (existing !== null) {
      if (existing.status === 'SCHEDULED') {
        await this.archiveOtherActiveSeasons(bounds.seasonId);
        const nextSeason: Season = { ...existing, status: 'ACTIVE' };
        await this.repository.saveSeason(nextSeason);
        return nextSeason;
      }

      return existing;
    }

    await this.archiveOtherActiveSeasons(bounds.seasonId);

    const season: Season = {
      ...bounds,
      status: 'ACTIVE',
    };
    await this.repository.saveSeason(season);
    return season;
  }

  async processMatchResult(job: MatchResultJob) {
    const participants = Array.from(new Set(job.participants));
    if (participants.length !== 2) {
      throw new Error('Exactly two unique participants are required');
    }

    if (
      job.winnerUid !== undefined &&
      job.winnerUid !== null &&
      !participants.includes(job.winnerUid)
    ) {
      throw new Error('winnerUid must belong to match participants');
    }

    const season = await this.ensureSeasonForDate(job.endedAt);
    const [playerAUid, playerBUid] = participants as [string, string];

    const [currentA, currentB] = await Promise.all([
      this.repository.getRating(season.seasonId, playerAUid),
      this.repository.getRating(season.seasonId, playerBUid),
    ]);

    const playerA = currentA ?? createDefaultRating(season.seasonId, playerAUid);
    const playerB = currentB ?? createDefaultRating(season.seasonId, playerBUid);

    const scoreA = scoreForParticipant(job.winnerUid, playerAUid);
    const scoreB = scoreForParticipant(job.winnerUid, playerBUid);
    const nextElo = calculateEloRatings({
      playerA: { rating: playerA.elo, score: scoreA },
      playerB: { rating: playerB.elo, score: scoreB },
      kFactor: this.kFactor,
    });

    const updatedRatings: Rating[] = [
      {
        uid: playerA.uid,
        seasonId: season.seasonId,
        elo: nextElo.playerA,
        matches: playerA.matches + 1,
        winRate: (countWins(playerA) + (scoreA === 1 ? 1 : 0)) / (playerA.matches + 1),
      },
      {
        uid: playerB.uid,
        seasonId: season.seasonId,
        elo: nextElo.playerB,
        matches: playerB.matches + 1,
        winRate: (countWins(playerB) + (scoreB === 1 ? 1 : 0)) / (playerB.matches + 1),
      },
    ].sort((left, right) => left.uid.localeCompare(right.uid));

    await Promise.all(updatedRatings.map((rating) => this.repository.saveRating(rating)));

    const allRatings = await this.repository.listRatingsForSeason(season.seasonId);
    const leaderboard = buildLeaderboard(season.seasonId, allRatings);
    await this.repository.saveLeaderboard(leaderboard);
    if (this.cache) {
      try {
        await this.cache.set(leaderboard);
      } catch {
        // Cache is best-effort; Firestore remains the source of truth
      }
    }

    return {
      season,
      leaderboard,
      updatedRatings,
    };
  }

  getRating(seasonId: string, uid: string): Promise<Rating | null> {
    return this.repository.getRating(seasonId, uid);
  }

  async getLeaderboard(seasonId: string): Promise<Leaderboard | null> {
    const cached = await this.cache?.get(seasonId);
    if (cached !== undefined && cached !== null) {
      return cached;
    }
    const leaderboard = await this.repository.getLeaderboard(seasonId);
    if (leaderboard !== null && this.cache) {
      await this.cache.set(leaderboard).catch(() => {
        // Cache population is best-effort
      });
    }
    return leaderboard;
  }
}
