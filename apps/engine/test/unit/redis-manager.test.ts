import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RedisManager } from '../../src/state/redis-manager.js';

vi.mock('ioredis', () => import('ioredis-mock'));

describe('RedisManager', () => {
  let redisManager: RedisManager;

  beforeEach(() => {
    redisManager = new RedisManager('redis://localhost:6379');
  });

  afterEach(async () => {
    // Clear redis data
    const client = (redisManager as any).client;
    await client.flushall();
    await redisManager.close();
  });

  it('should acquire turn lock', async () => {
    const locked = await redisManager.acquireTurnLock('match1', 10, 'owner-1');
    expect(locked).toBe(true);

    const lockedAgain = await redisManager.acquireTurnLock('match1', 10, 'owner-2');
    expect(lockedAgain).toBe(false);
  });

  it('should release turn lock only for owner', async () => {
    await redisManager.acquireTurnLock('match1', 10, 'owner-1');

    const releasedByOtherOwner = await redisManager.releaseTurnLock('match1', 'owner-2');
    expect(releasedByOtherOwner).toBe(false);

    const lockedWhileOwned = await redisManager.acquireTurnLock('match1', 10, 'owner-3');
    expect(lockedWhileOwned).toBe(false);

    const releasedByOwner = await redisManager.releaseTurnLock('match1', 'owner-1');
    expect(releasedByOwner).toBe(true);

    const locked = await redisManager.acquireTurnLock('match1', 10, 'owner-3');
    expect(locked).toBe(true);
  });

  it('should handle request processing idempotency', async () => {
    const matchId = 'match1';
    const requestId = 'req1';
    const response = { status: 'ok', result: { foo: 'bar' } };

    expect(await redisManager.checkRequestIdProcessed(matchId, requestId)).toBe(false);

    await redisManager.markRequestIdProcessed(matchId, requestId, response);

    expect(await redisManager.checkRequestIdProcessed(matchId, requestId)).toBe(true);

    const cached = await redisManager.getProcessedResponse(matchId, requestId);
    expect(cached).toEqual(response);
  });

  it('should use 10-minute default ttl for live state and idempotency cache', async () => {
    const matchId = 'match-ttl';
    const requestId = 'req-ttl';
    await redisManager.saveMatchState(matchId, { foo: 'bar' });
    await redisManager.saveMatchMeta(matchId, { gameId: 'test-game' });
    await redisManager.markRequestIdProcessed(matchId, requestId, { status: 'ok', result: {} });

    const client = (redisManager as any).client;
    const stateTtl = await client.ttl(`match:${matchId}:state`);
    const metaTtl = await client.ttl(`match:${matchId}:meta`);
    const requestTtl = await client.ttl(`match:${matchId}:request:${requestId}`);

    expect(stateTtl).toBeGreaterThan(0);
    expect(metaTtl).toBeGreaterThan(0);
    expect(requestTtl).toBeGreaterThan(0);
    expect(stateTtl).toBeLessThanOrEqual(600);
    expect(metaTtl).toBeLessThanOrEqual(600);
    expect(requestTtl).toBeLessThanOrEqual(600);
  });
});
