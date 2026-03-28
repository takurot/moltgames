import { randomInt, randomUUID } from 'node:crypto';

import { type Redis } from 'ioredis';

import type { Match } from '@moltgames/domain';

import type { MatchRepository } from '../match/repository.js';
import type { RatingRepository } from '../rating/repository.js';

const MATCH_QUEUE_KEY_PREFIX = 'moltgames:queue:';
const MATCH_QUEUE_ENTRY_KEY_PREFIX = 'moltgames:queue-entry:';
const MATCH_QUEUE_ACTIVE_KEY_PREFIX = 'moltgames:queue-active:';
const DEFAULT_MATCH_REGION = 'us-central1';
const DEFAULT_STARTING_ELO = 1500;
const INITIAL_RATING_WINDOW = 200;
const EXPANDED_RATING_WINDOW = 400;
const EXPANSION_THRESHOLD_SECONDS = 30;
const SECOND_EXPANSION_THRESHOLD_SECONDS = 60;

export interface QueueClock {
  now(): Date;
}

export const systemQueueClock: QueueClock = {
  now: () => new Date(),
};

export interface RequestedRatingRange {
  min: number;
  max: number;
}

export type MatchQueueEntryStatus = 'QUEUED' | 'MATCHED';

export interface MatchQueueStatus {
  status: MatchQueueEntryStatus;
  gameId: string;
  agentId: string;
  queuedAt: string;
  matchId?: string;
  matchedAt?: string;
}

interface MatchQueueEntry {
  entryId: string;
  uid: string;
  gameId: string;
  agentId: string;
  rating: number;
  queuedAt: string;
  queuedAtMs: number;
  status: MatchQueueEntryStatus;
  ratingRange?: RequestedRatingRange;
  matchId?: string;
  matchedAt?: string;
}

export interface QueueEngineClient {
  startMatch?(
    matchId: string,
    request: {
      gameId: string;
      seed: number;
    },
  ): Promise<void>;
  getMatchMeta(matchId: string): Promise<{ gameId: string; ruleVersion?: string | null } | null>;
}

export interface MatchQueueServiceOptions {
  redis: Redis;
  clock?: QueueClock;
  ratingRepository: RatingRepository;
  matchRepository: MatchRepository;
  engineClient: QueueEngineClient;
  region?: string;
}

export interface EnqueueMatchQueueInput {
  uid: string;
  gameId: string;
  agentId: string;
  ratingRange?: RequestedRatingRange;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const sortMatchesByMostRecent = (matches: readonly Match[]): Match[] =>
  [...matches].sort((left, right) => {
    const leftTimestamp = left.endedAt ?? left.startedAt ?? '';
    const rightTimestamp = right.endedAt ?? right.startedAt ?? '';

    if (leftTimestamp !== rightTimestamp) {
      return rightTimestamp.localeCompare(leftTimestamp);
    }

    return right.matchId.localeCompare(left.matchId);
  });

const isRequestedRatingRange = (value: unknown): value is RequestedRatingRange => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<RequestedRatingRange>;
  return (
    typeof candidate.min === 'number' &&
    Number.isFinite(candidate.min) &&
    typeof candidate.max === 'number' &&
    Number.isFinite(candidate.max) &&
    candidate.min <= candidate.max
  );
};

const isMatchQueueEntry = (value: unknown): value is MatchQueueEntry => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<MatchQueueEntry>;
  return (
    isNonEmptyString(candidate.entryId) &&
    isNonEmptyString(candidate.uid) &&
    isNonEmptyString(candidate.gameId) &&
    isNonEmptyString(candidate.agentId) &&
    typeof candidate.rating === 'number' &&
    Number.isFinite(candidate.rating) &&
    isNonEmptyString(candidate.queuedAt) &&
    typeof candidate.queuedAtMs === 'number' &&
    Number.isFinite(candidate.queuedAtMs) &&
    (candidate.status === 'QUEUED' || candidate.status === 'MATCHED') &&
    (candidate.ratingRange === undefined || isRequestedRatingRange(candidate.ratingRange)) &&
    (candidate.matchId === undefined || isNonEmptyString(candidate.matchId)) &&
    (candidate.matchedAt === undefined || isNonEmptyString(candidate.matchedAt))
  );
};

const toQueueStatus = (entry: MatchQueueEntry): MatchQueueStatus => ({
  status: entry.status,
  gameId: entry.gameId,
  agentId: entry.agentId,
  queuedAt: entry.queuedAt,
  ...(entry.matchId === undefined ? {} : { matchId: entry.matchId }),
  ...(entry.matchedAt === undefined ? {} : { matchedAt: entry.matchedAt }),
});

export const getExpandedQueueRatingWindow = (waitedSeconds: number): number => {
  if (waitedSeconds >= SECOND_EXPANSION_THRESHOLD_SECONDS) {
    return Number.POSITIVE_INFINITY;
  }

  if (waitedSeconds >= EXPANSION_THRESHOLD_SECONDS) {
    return EXPANDED_RATING_WINDOW;
  }

  return INITIAL_RATING_WINDOW;
};

const effectiveRatingWindow = (entry: MatchQueueEntry, nowMs: number): number => {
  const waitedSeconds = Math.max(0, Math.floor((nowMs - entry.queuedAtMs) / 1000));
  return getExpandedQueueRatingWindow(waitedSeconds);
};

const isWithinRequestedRange = (entry: MatchQueueEntry, opponentRating: number): boolean => {
  if (entry.ratingRange === undefined) {
    return true;
  }

  return opponentRating >= entry.ratingRange.min && opponentRating <= entry.ratingRange.max;
};

const canEntriesMatch = (left: MatchQueueEntry, right: MatchQueueEntry, nowMs: number): boolean => {
  if (left.uid === right.uid) {
    return false;
  }

  const diff = Math.abs(left.rating - right.rating);
  return (
    diff <= effectiveRatingWindow(left, nowMs) &&
    diff <= effectiveRatingWindow(right, nowMs) &&
    isWithinRequestedRange(left, right.rating) &&
    isWithinRequestedRange(right, left.rating)
  );
};

export class MatchQueueService {
  readonly #redis: Redis;
  readonly #clock: QueueClock;
  readonly #ratingRepository: RatingRepository;
  readonly #matchRepository: MatchRepository;
  readonly #engineClient: QueueEngineClient;
  readonly #region: string;

  constructor(options: MatchQueueServiceOptions) {
    this.#redis = options.redis;
    this.#clock = options.clock ?? systemQueueClock;
    this.#ratingRepository = options.ratingRepository;
    this.#matchRepository = options.matchRepository;
    this.#engineClient = options.engineClient;
    this.#region = options.region ?? process.env.REGION ?? DEFAULT_MATCH_REGION;
  }

  async enqueue(input: EnqueueMatchQueueInput): Promise<MatchQueueStatus> {
    this.#validateEnqueueInput(input);

    const existing = await this.getStatus(input.uid, input.gameId);
    if (existing !== null) {
      return existing;
    }

    const queuedAt = this.#clock.now();
    const rating = await this.#resolveRating(input.uid);
    const entry: MatchQueueEntry = {
      entryId: randomUUID(),
      uid: input.uid,
      gameId: input.gameId,
      agentId: input.agentId,
      rating,
      queuedAt: queuedAt.toISOString(),
      queuedAtMs: queuedAt.getTime(),
      status: 'QUEUED',
      ...(input.ratingRange === undefined ? {} : { ratingRange: { ...input.ratingRange } }),
    };

    const pipeline = this.#redis.pipeline();
    pipeline.set(this.#entryKey(entry.entryId), JSON.stringify(entry));
    pipeline.set(this.#activeKey(entry.uid, entry.gameId), entry.entryId);
    pipeline.rpush(this.#queueKey(entry.gameId), entry.entryId);
    await pipeline.exec();

    await this.processQueue(entry.gameId);

    const currentStatus = await this.getStatus(input.uid, input.gameId);
    if (currentStatus === null) {
      throw new Error('Queue entry was not persisted');
    }

    return currentStatus;
  }

  async leave(uid: string, gameId: string): Promise<void> {
    const entry = await this.#getActiveEntry(uid, gameId);
    if (entry === null) {
      return;
    }

    const pipeline = this.#redis.pipeline();
    pipeline.del(this.#activeKey(uid, gameId));
    pipeline.del(this.#entryKey(entry.entryId));
    pipeline.lrem(this.#queueKey(gameId), 0, entry.entryId);
    await pipeline.exec();
  }

  async getStatus(uid: string, gameId: string): Promise<MatchQueueStatus | null> {
    const entry = await this.#getActiveEntry(uid, gameId);
    return entry === null ? null : toQueueStatus(entry);
  }

  async processQueue(gameId: string): Promise<void> {
    const entries = await this.#listQueuedEntries(gameId);
    const matchedEntryIds = new Set<string>();
    const nowMs = this.#clock.now().getTime();

    for (let index = 0; index < entries.length; index += 1) {
      const current = entries[index];
      if (current === undefined || matchedEntryIds.has(current.entryId)) {
        continue;
      }

      let bestCandidate: MatchQueueEntry | null = null;
      let bestDiff = Number.POSITIVE_INFINITY;

      for (let candidateIndex = index + 1; candidateIndex < entries.length; candidateIndex += 1) {
        const candidate = entries[candidateIndex];
        if (candidate === undefined || matchedEntryIds.has(candidate.entryId)) {
          continue;
        }

        if (!canEntriesMatch(current, candidate, nowMs)) {
          continue;
        }

        const diff = Math.abs(current.rating - candidate.rating);
        if (
          bestCandidate === null ||
          diff < bestDiff ||
          (diff === bestDiff && candidate.queuedAtMs < bestCandidate.queuedAtMs)
        ) {
          bestCandidate = candidate;
          bestDiff = diff;
        }
      }

      if (bestCandidate === null) {
        continue;
      }

      await this.#createMatch(current, bestCandidate);
      matchedEntryIds.add(current.entryId);
      matchedEntryIds.add(bestCandidate.entryId);
    }
  }

  async #resolveRating(uid: string): Promise<number> {
    const activeSeasons = (await this.#ratingRepository.listSeasons()).filter(
      (season) => season.status === 'ACTIVE',
    );
    const activeSeason = activeSeasons.at(-1);

    if (activeSeason === undefined) {
      return DEFAULT_STARTING_ELO;
    }

    const rating = await this.#ratingRepository.getRating(activeSeason.seasonId, uid);
    return rating?.elo ?? DEFAULT_STARTING_ELO;
  }

  async #getActiveEntry(uid: string, gameId: string): Promise<MatchQueueEntry | null> {
    const entryId = await this.#redis.get(this.#activeKey(uid, gameId));
    if (!entryId) {
      return null;
    }

    return this.#getEntry(entryId);
  }

  async #getEntry(entryId: string): Promise<MatchQueueEntry | null> {
    const raw = await this.#redis.get(this.#entryKey(entryId));
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return isMatchQueueEntry(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async #listQueuedEntries(gameId: string): Promise<MatchQueueEntry[]> {
    const entryIds = await this.#redis.lrange(this.#queueKey(gameId), 0, -1);
    const entries = await Promise.all(entryIds.map((entryId) => this.#getEntry(entryId)));

    return entries
      .filter((entry): entry is MatchQueueEntry => entry !== null && entry.status === 'QUEUED')
      .sort((left, right) => {
        if (left.queuedAtMs !== right.queuedAtMs) {
          return left.queuedAtMs - right.queuedAtMs;
        }
        return left.entryId.localeCompare(right.entryId);
      });
  }

  async #createMatch(left: MatchQueueEntry, right: MatchQueueEntry): Promise<void> {
    if (typeof this.#engineClient.startMatch !== 'function') {
      throw new Error('Gateway engine client does not support starting matches');
    }

    const matchId = randomUUID();
    await this.#engineClient.startMatch(matchId, {
      gameId: left.gameId,
      seed: randomInt(1, 2_147_483_647),
    });

    const meta = await this.#engineClient.getMatchMeta(matchId);
    const matchedAt = this.#clock.now().toISOString();
    const participants = [
      { uid: left.uid, agentId: left.agentId, role: 'PLAYER' as const },
      { uid: right.uid, agentId: right.agentId, role: 'PLAYER' as const },
    ];

    await this.#matchRepository.save({
      matchId,
      gameId: left.gameId,
      status: 'CREATED',
      participants,
      ruleId: left.gameId,
      ruleVersion: meta?.ruleVersion ?? 'unknown',
      region: this.#region,
    });

    const leftMatched: MatchQueueEntry = {
      ...left,
      status: 'MATCHED',
      matchId,
      matchedAt,
    };
    const rightMatched: MatchQueueEntry = {
      ...right,
      status: 'MATCHED',
      matchId,
      matchedAt,
    };

    const pipeline = this.#redis.pipeline();
    pipeline.set(this.#entryKey(left.entryId), JSON.stringify(leftMatched));
    pipeline.set(this.#entryKey(right.entryId), JSON.stringify(rightMatched));
    pipeline.lrem(this.#queueKey(left.gameId), 0, left.entryId);
    pipeline.lrem(this.#queueKey(right.gameId), 0, right.entryId);
    await pipeline.exec();
  }

  #validateEnqueueInput(input: EnqueueMatchQueueInput): void {
    if (
      !isNonEmptyString(input.uid) ||
      !isNonEmptyString(input.gameId) ||
      !isNonEmptyString(input.agentId)
    ) {
      throw new Error('uid, gameId, and agentId are required');
    }

    if (input.ratingRange !== undefined && !isRequestedRatingRange(input.ratingRange)) {
      throw new Error('ratingRange must be an object with numeric min/max bounds');
    }
  }

  #queueKey(gameId: string): string {
    return `${MATCH_QUEUE_KEY_PREFIX}${gameId}`;
  }

  #entryKey(entryId: string): string {
    return `${MATCH_QUEUE_ENTRY_KEY_PREFIX}${entryId}`;
  }

  #activeKey(uid: string, gameId: string): string {
    return `${MATCH_QUEUE_ACTIVE_KEY_PREFIX}${uid}:${gameId}`;
  }
}

export const listMatchesPage = (
  matches: readonly Match[],
  limit: number,
  cursor: string | undefined,
): { items: Match[]; nextCursor: string | null } => {
  const offset = decodeMatchesCursor(cursor);
  const sortedMatches = sortMatchesByMostRecent(matches);
  const items = sortedMatches.slice(offset, offset + limit);
  const nextOffset = offset + items.length;

  return {
    items,
    nextCursor: nextOffset < sortedMatches.length ? encodeMatchesCursor(nextOffset) : null,
  };
};

export const encodeMatchesCursor = (offset: number): string =>
  Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');

export const decodeMatchesCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
    };
    if (
      typeof parsed.offset !== 'number' ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new Error('Invalid cursor');
    }
    return parsed.offset;
  } catch {
    throw new Error('Invalid cursor');
  }
};
