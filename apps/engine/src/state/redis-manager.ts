import Redis from 'ioredis';
import { JsonValue } from '@moltgames/domain';

const RELEASE_LOCK_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;
const LIVE_STATE_TTL_SECONDS = 600;

export class RedisManager {
  private client: Redis;

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl);
  }

  async getMatchState<S>(matchId: string): Promise<S | null> {
    const data = await this.client.get(`match:${matchId}:state`);
    if (!data) return null;
    return JSON.parse(data) as S;
  }

  async saveMatchState<S>(
    matchId: string,
    state: S,
    ttlSeconds: number = LIVE_STATE_TTL_SECONDS,
  ): Promise<void> {
    await this.client.setex(`match:${matchId}:state`, ttlSeconds, JSON.stringify(state));
  }

  async getMatchMeta(matchId: string): Promise<Record<string, string> | null> {
    const data = await this.client.hgetall(`match:${matchId}:meta`);
    if (!data || Object.keys(data).length === 0) return null;
    return data;
  }

  async saveMatchMeta(
    matchId: string,
    meta: Record<string, string | number>,
    ttlSeconds: number = LIVE_STATE_TTL_SECONDS,
  ): Promise<void> {
    const key = `match:${matchId}:meta`;
    await this.client.hset(key, meta);
    await this.client.expire(key, ttlSeconds);
  }

  async acquireTurnLock(matchId: string, ttlSeconds: number, ownerToken: string): Promise<boolean> {
    const key = `match:${matchId}:turn-lock`;
    const result = await this.client.set(key, ownerToken, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async releaseTurnLock(matchId: string, ownerToken: string): Promise<boolean> {
    const key = `match:${matchId}:turn-lock`;
    const released = await this.client.eval(RELEASE_LOCK_IF_OWNER_SCRIPT, 1, key, ownerToken);
    return Number(released) === 1;
  }

  async checkRequestIdProcessed(matchId: string, requestId: string): Promise<boolean> {
    const exists = await this.client.exists(`match:${matchId}:request:${requestId}`);
    return exists === 1;
  }

  async markRequestIdProcessed(
    matchId: string,
    requestId: string,
    response: JsonValue,
    ttlSeconds: number = LIVE_STATE_TTL_SECONDS,
  ): Promise<void> {
    const key = `match:${matchId}:request:${requestId}`;
    await this.client.setex(key, ttlSeconds, JSON.stringify(response));
  }

  async getProcessedResponse(matchId: string, requestId: string): Promise<JsonValue | null> {
    const data = await this.client.get(`match:${matchId}:request:${requestId}`);
    if (!data) return null;
    return JSON.parse(data) as JsonValue;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
