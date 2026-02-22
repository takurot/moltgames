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
    const locked = await redisManager.acquireTurnLock('match1', 10);
    expect(locked).toBe(true);

    const lockedAgain = await redisManager.acquireTurnLock('match1', 10);
    expect(lockedAgain).toBe(false);
  });

  it('should release turn lock', async () => {
    await redisManager.acquireTurnLock('match1', 10);
    await redisManager.releaseTurnLock('match1');

    const locked = await redisManager.acquireTurnLock('match1', 10);
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
});
