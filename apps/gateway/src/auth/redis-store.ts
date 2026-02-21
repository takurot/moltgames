import { type Redis } from 'ioredis';

import {
  type Clock,
  CONNECT_TOKEN_LOOKUP_KEY_PREFIX,
  CONNECT_TOKEN_SESSION_KEY_PREFIX,
  ConnectTokenError,
  type ConnectTokenSession,
  type ConnectTokenSessionStore,
  systemClock,
} from './connect-token.js';

const toUnixSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

export class RedisConnectTokenSessionStore implements ConnectTokenSessionStore {
  readonly #redis: Redis;
  readonly #clock: Clock;

  constructor(redis: Redis, clock: Clock = systemClock) {
    this.#redis = redis;
    this.#clock = clock;
  }

  async save(session: ConnectTokenSession): Promise<void> {
    const key = this.#buildSessionKey(session.connectToken);
    const lookupKey = this.#buildLookupKey(session.tokenId);
    const now = toUnixSeconds(this.#clock.now());
    const ttl = Math.max(0, session.expiresAt - now);

    if (ttl <= 0) {
      return;
    }

    const pipeline = this.#redis.pipeline();
    pipeline.set(key, JSON.stringify(session), 'EX', ttl);
    pipeline.set(lookupKey, session.connectToken, 'EX', ttl);
    await pipeline.exec();
  }

  async findByConnectToken(connectToken: string): Promise<ConnectTokenSession | null> {
    const key = this.#buildSessionKey(connectToken);
    const data = await this.#redis.get(key);

    if (!data) {
      return null;
    }

    try {
      return JSON.parse(data) as ConnectTokenSession;
    } catch {
      return null;
    }
  }

  async findByTokenId(tokenId: string): Promise<ConnectTokenSession | null> {
    const lookupKey = this.#buildLookupKey(tokenId);
    const connectToken = await this.#redis.get(lookupKey);

    if (!connectToken) {
      return null;
    }

    return this.findByConnectToken(connectToken);
  }

  async update(session: ConnectTokenSession): Promise<void> {
    const key = this.#buildSessionKey(session.connectToken);
    const exists = await this.#redis.exists(key);

    if (!exists) {
      throw new ConnectTokenError(
        'TOKEN_NOT_FOUND',
        `Connect token ${session.tokenId} was not found`,
      );
    }

    const now = toUnixSeconds(this.#clock.now());
    const ttl = Math.max(0, session.expiresAt - now);

    if (ttl <= 0) {
      const lookupKey = this.#buildLookupKey(session.tokenId);
      const pipeline = this.#redis.pipeline();
      pipeline.del(key);
      pipeline.del(lookupKey);
      await pipeline.exec();
      return;
    }

    const lookupKey = this.#buildLookupKey(session.tokenId);

    const pipeline = this.#redis.pipeline();
    pipeline.set(key, JSON.stringify(session), 'EX', ttl);
    pipeline.expire(lookupKey, ttl);
    await pipeline.exec();
  }

  #buildSessionKey(connectToken: string): string {
    return `${CONNECT_TOKEN_SESSION_KEY_PREFIX}${connectToken}`;
  }

  #buildLookupKey(tokenId: string): string {
    return `${CONNECT_TOKEN_LOOKUP_KEY_PREFIX}${tokenId}`;
  }
}
