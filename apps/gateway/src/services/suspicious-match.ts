import type { Redis } from 'ioredis';

const SUSPICIOUS_KEY_PREFIX = 'suspicious:match:';
const FLAG_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export type ReviewStatus = 'pending' | 'reviewed' | 'cleared';

export interface SuspiciousMatchFlag {
  matchId: string;
  flaggedAt: string; // ISO 8601
  reason: string;
  flaggedBy: 'system' | 'admin';
  reviewStatus: ReviewStatus;
  reviewedAt?: string;
  reviewNote?: string;
}

const buildKey = (matchId: string): string => `${SUSPICIOUS_KEY_PREFIX}${matchId}`;

export class SuspiciousMatchStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async flag(
    matchId: string,
    reason: string,
    flaggedBy: 'system' | 'admin' = 'admin',
  ): Promise<SuspiciousMatchFlag> {
    const flag: SuspiciousMatchFlag = {
      matchId,
      flaggedAt: new Date().toISOString(),
      reason,
      flaggedBy,
      reviewStatus: 'pending',
    };

    await this.#redis.set(buildKey(matchId), JSON.stringify(flag), 'EX', FLAG_TTL_SECONDS);
    return flag;
  }

  async get(matchId: string): Promise<SuspiciousMatchFlag | null> {
    const raw = await this.#redis.get(buildKey(matchId));
    if (raw === null) return null;
    return JSON.parse(raw) as SuspiciousMatchFlag;
  }

  async update(
    matchId: string,
    patch: Partial<Pick<SuspiciousMatchFlag, 'reviewStatus' | 'reviewedAt' | 'reviewNote'>>,
  ): Promise<SuspiciousMatchFlag | null> {
    const existing = await this.get(matchId);
    if (existing === null) return null;

    const updated: SuspiciousMatchFlag = { ...existing, ...patch };
    await this.#redis.set(buildKey(matchId), JSON.stringify(updated), 'EX', FLAG_TTL_SECONDS);
    return updated;
  }

  /** Scan Redis for all flagged match keys (uses SCAN for safety). */
  async listAll(): Promise<SuspiciousMatchFlag[]> {
    const flags: SuspiciousMatchFlag[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.#redis.scan(
        cursor,
        'MATCH',
        `${SUSPICIOUS_KEY_PREFIX}*`,
        'COUNT',
        100,
      );
      cursor = nextCursor;

      for (const key of keys) {
        const raw = await this.#redis.get(key);
        if (raw !== null) {
          flags.push(JSON.parse(raw) as SuspiciousMatchFlag);
        }
      }
    } while (cursor !== '0');

    return flags;
  }
}

// In-memory implementation for tests (no Redis dependency)
export class InMemorySuspiciousMatchStore {
  readonly #data = new Map<string, SuspiciousMatchFlag>();

  async flag(
    matchId: string,
    reason: string,
    flaggedBy: 'system' | 'admin' = 'admin',
  ): Promise<SuspiciousMatchFlag> {
    const flag: SuspiciousMatchFlag = {
      matchId,
      flaggedAt: new Date().toISOString(),
      reason,
      flaggedBy,
      reviewStatus: 'pending',
    };
    this.#data.set(matchId, flag);
    return flag;
  }

  async get(matchId: string): Promise<SuspiciousMatchFlag | null> {
    return this.#data.get(matchId) ?? null;
  }

  async update(
    matchId: string,
    patch: Partial<Pick<SuspiciousMatchFlag, 'reviewStatus' | 'reviewedAt' | 'reviewNote'>>,
  ): Promise<SuspiciousMatchFlag | null> {
    const existing = this.#data.get(matchId);
    if (existing === undefined) return null;

    const updated: SuspiciousMatchFlag = { ...existing, ...patch };
    this.#data.set(matchId, updated);
    return updated;
  }

  async listAll(): Promise<SuspiciousMatchFlag[]> {
    return [...this.#data.values()];
  }
}
