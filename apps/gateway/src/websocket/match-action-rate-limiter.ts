import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

const RATE_LIMIT_KEY_PREFIX = 'gateway:ws-action-rate-limit:';

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local member = ARGV[4]
local window_start = now - window_ms

redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

local current = redis.call('ZCARD', key)
if current >= max_requests then
  redis.call('PEXPIRE', key, window_ms)
  return 0
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window_ms)
return 1
`;

export interface MatchActionRateLimiter {
  allow(matchId: string): Promise<boolean>;
  clear(matchId: string): Promise<void>;
}

export class RedisMatchActionRateLimiter implements MatchActionRateLimiter {
  readonly #redis: Redis;
  readonly #windowMs: number;
  readonly #maxRequests: number;

  constructor(redis: Redis, windowMs: number, maxRequests: number) {
    this.#redis = redis;
    this.#windowMs = windowMs;
    this.#maxRequests = maxRequests;
  }

  async allow(matchId: string): Promise<boolean> {
    const key = this.#buildKey(matchId);
    const result = await this.#redis.eval(
      RATE_LIMIT_SCRIPT,
      1,
      key,
      Date.now(),
      this.#windowMs,
      this.#maxRequests,
      `${Date.now()}:${randomUUID()}`,
    );

    return Number(result) === 1;
  }

  async clear(matchId: string): Promise<void> {
    await this.#redis.del(this.#buildKey(matchId));
  }

  #buildKey(matchId: string): string {
    return `${RATE_LIMIT_KEY_PREFIX}${matchId}`;
  }
}
