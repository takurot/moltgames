import Redis from 'ioredis';

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

  async saveMatchState<S>(matchId: string, state: S, ttlSeconds: number = 600): Promise<void> {
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
    ttlSeconds: number = 600,
  ): Promise<void> {
    const key = `match:${matchId}:meta`;
    await this.client.hset(key, meta);
    await this.client.expire(key, ttlSeconds);
  }

  async acquireTurnLock(matchId: string, ttlSeconds: number): Promise<boolean> {
    const key = `match:${matchId}:turn-lock`;
    const result = await this.client.set(key, 'locked', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async releaseTurnLock(matchId: string): Promise<void> {
    await this.client.del(`match:${matchId}:turn-lock`);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
