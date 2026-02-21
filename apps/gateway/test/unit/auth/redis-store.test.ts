import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { RedisConnectTokenSessionStore } from '../../../src/auth/redis-store.js';
import { ConnectTokenSession, systemClock, CONNECT_TOKEN_SESSION_KEY_PREFIX, CONNECT_TOKEN_LOOKUP_KEY_PREFIX } from '../../../src/auth/connect-token.js';

describe('RedisConnectTokenSessionStore', () => {
  let redis: any;
  let store: RedisConnectTokenSessionStore;
  const clock = systemClock;

  beforeEach(() => {
    redis = new RedisMock();
    store = new RedisConnectTokenSessionStore(redis, clock);
  });

  const createSession = (override: Partial<ConnectTokenSession> = {}): ConnectTokenSession => {
    const now = Math.floor(Date.now() / 1000);
    const id = Math.random().toString(36).substring(7);
    return {
      tokenId: `test-token-id-${id}`,
      uid: 'test-uid',
      matchId: 'test-match-id',
      agentId: 'test-agent-id',
      issuedAt: now,
      expiresAt: now + 300,
      connectToken: `test-connect-token-${id}`,
      status: 'ISSUED',
      ...override,
    };
  };

  it('should save a session', async () => {
    const session = createSession();
    await store.save(session);

    const key = `${CONNECT_TOKEN_SESSION_KEY_PREFIX}${session.connectToken}`;
    const lookupKey = `${CONNECT_TOKEN_LOOKUP_KEY_PREFIX}${session.tokenId}`;

    const data = await redis.get(key);
    expect(JSON.parse(data)).toEqual(session);

    const lookupData = await redis.get(lookupKey);
    expect(lookupData).toEqual(session.connectToken);
  });

  it('should find by connect token', async () => {
    const session = createSession();
    await store.save(session);

    const found = await store.findByConnectToken(session.connectToken);
    expect(found).toEqual(session);
  });

  it('should return null if connect token not found', async () => {
    const found = await store.findByConnectToken('non-existent');
    expect(found).toBeNull();
  });

  it('should find by token id', async () => {
    const session = createSession();
    await store.save(session);

    const found = await store.findByTokenId(session.tokenId);
    expect(found).toEqual(session);
  });

  it('should return null if token id not found', async () => {
    const found = await store.findByTokenId('non-existent');
    expect(found).toBeNull();
  });

  it('should update session', async () => {
    const session = createSession();
    await store.save(session);

    const updatedSession: ConnectTokenSession = { ...session, status: 'USED' };
    await store.update(updatedSession);

    const found = await store.findByConnectToken(session.connectToken);
    expect(found).toEqual(updatedSession);
  });

  it('should throw error when updating non-existent session', async () => {
    const session = createSession();
    try {
      await store.update(session);
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.code).toBe('TOKEN_NOT_FOUND');
    }
  });
});
