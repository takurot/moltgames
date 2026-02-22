import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Engine } from '../../../src/framework/engine.js';
import { RedisManager } from '../../../src/state/redis-manager.js';
import type {
  GamePlugin,
  Action,
  ValidationResult,
  ApplyActionResult,
} from '../../../src/framework/types.js';

// Mock RedisManager
vi.mock('../../../src/state/redis-manager.js', () => {
  const RedisMock = require('ioredis-mock').default;
  return {
    RedisManager: class {
      client: any;
      constructor(url: string) {
        this.client = new RedisMock();
      }
      async getMatchState(matchId: string) {
        const data = await this.client.get(`match:${matchId}:state`);
        return data ? JSON.parse(data) : null;
      }
      async saveMatchState(matchId: string, state: any) {
        await this.client.set(`match:${matchId}:state`, JSON.stringify(state));
      }
      async getMatchMeta(matchId: string) {
        const meta = await this.client.hgetall(`match:${matchId}:meta`);
        if (Object.keys(meta).length === 0) {
          return null;
        }
        return meta;
      }
      async saveMatchMeta(matchId: string, meta: any) {
        await this.client.hset(`match:${matchId}:meta`, meta);
      }
      async acquireTurnLock(matchId: string, ttlSeconds: number, ownerToken: string) {
        // Simple mock lock: check if key exists
        const key = `match:${matchId}:turn-lock`;
        const exists = await this.client.exists(key);
        if (exists) return false;
        await this.client.set(key, ownerToken);
        return true;
      }
      async releaseTurnLock(matchId: string, ownerToken: string) {
        const key = `match:${matchId}:turn-lock`;
        const lockOwner = await this.client.get(key);
        if (lockOwner !== ownerToken) {
          return false;
        }
        await this.client.del(key);
        return true;
      }
      async checkRequestIdProcessed(matchId: string, requestId: string) {
        const exists = await this.client.exists(`req:${matchId}:${requestId}`);
        return exists === 1;
      }
      async markRequestIdProcessed(matchId: string, requestId: string, response: any) {
        await this.client.set(`req:${matchId}:${requestId}`, JSON.stringify(response));
      }
      async getProcessedResponse(matchId: string, requestId: string) {
        const data = await this.client.get(`req:${matchId}:${requestId}`);
        return data ? JSON.parse(data) : null;
      }
    },
  };
});

// Mock Game Plugin
class MockGamePlugin implements GamePlugin<any> {
  gameId = 'test-game';
  ruleVersion = '1.0.0';
  turnTimeoutSeconds = 30;

  initialize(seed: number) {
    return { turn: 1, value: 0 };
  }
  getTurn(state: any) {
    return state.turn;
  }
  consumeTurn(state: any) {
    return { ...state, turn: state.turn + 1 };
  }
  getAvailableTools() {
    return [];
  }
  validateAction(state: any, action: Action): ValidationResult {
    if (action.tool === 'invalid') {
      return { valid: false, error: 'Invalid tool', retryable: false };
    }
    if (action.tool === 'retryable_error') {
      return { valid: false, error: 'Retry me', retryable: true };
    }
    return { valid: true };
  }
  applyAction(state: any, action: Action): ApplyActionResult<any> {
    const newState = { ...state, value: state.value + 1, turn: state.turn + 1 };
    return { state: newState, result: { success: true } };
  }
  checkTermination() {
    return null;
  }
}

describe('Engine', () => {
  let engine: Engine;
  let redisManager: RedisManager;

  beforeEach(() => {
    redisManager = new RedisManager('redis://localhost:6379');
    engine = new Engine(redisManager);
    engine.registerPlugin(new MockGamePlugin());
  });

  it('should start a match', async () => {
    const matchId = 'match-1';
    await engine.startMatch(matchId, 'test-game', 123);

    const state = await redisManager.getMatchState(matchId);
    expect(state).toEqual({ turn: 1, value: 0 });

    const meta = await redisManager.getMatchMeta(matchId);
    expect(meta).toEqual(
      expect.objectContaining({
        gameId: 'test-game',
        seed: '123',
        turn: '1',
        retryCount: '0',
        turnTimeoutSec: '30',
      }),
    );
    expect(Number(meta?.turnStartedAtMs)).toBeGreaterThan(0);
  });

  it('should process a valid action', async () => {
    const matchId = 'match-2';
    await engine.startMatch(matchId, 'test-game', 123);

    const action: Action = { tool: 'move', request_id: 'req1', args: {} };
    const result = await engine.processAction(matchId, action);

    expect(result).toMatchObject({ status: 'ok', request_id: 'req1' });
    if (result.status === 'ok') {
      expect(result.result).toEqual({ success: true });
    }

    const state = await redisManager.getMatchState(matchId);
    expect(state).toEqual({ turn: 2, value: 1 });

    const meta = await redisManager.getMatchMeta(matchId);
    expect(meta).toEqual(expect.objectContaining({ turn: '2', retryCount: '0' }));
  });

  it('should handle retryable validation error', async () => {
    const matchId = 'match-3';
    await engine.startMatch(matchId, 'test-game', 123);

    const action: Action = { tool: 'retryable_error', request_id: 'req2', args: {} };
    const result = await engine.processAction(matchId, action);

    expect(result).toMatchObject({ status: 'error', request_id: 'req2' });
    if (result.status === 'error') {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.retryable).toBe(true);
    }

    const meta = await redisManager.getMatchMeta(matchId);
    expect(meta).toEqual(expect.objectContaining({ retryCount: '1' }));
  });

  it('should retry validation error only once per turn', async () => {
    const matchId = 'match-4';
    await engine.startMatch(matchId, 'test-game', 123);

    const firstResult = await engine.processAction(matchId, {
      tool: 'retryable_error',
      request_id: 'req3-1',
      args: {},
    });
    expect(firstResult.status).toBe('error');
    if (firstResult.status === 'error') {
      expect(firstResult.error.code).toBe('VALIDATION_ERROR');
      expect(firstResult.error.retryable).toBe(true);
    }

    let meta = await redisManager.getMatchMeta(matchId);
    expect(meta).toEqual(expect.objectContaining({ retryCount: '1' }));

    const metaBeforeSecondFailure = await redisManager.getMatchMeta(matchId);
    const secondResult = await engine.processAction(matchId, {
      tool: 'retryable_error',
      request_id: 'req3-2',
      args: {},
    });
    expect(secondResult).toMatchObject({ status: 'error', request_id: 'req3-2' });
    if (secondResult.status === 'error') {
      expect(secondResult.error.code).toBe('VALIDATION_ERROR');
      expect(secondResult.error.retryable).toBe(false);
    }
    meta = await redisManager.getMatchMeta(matchId);
    expect(meta).toEqual(expect.objectContaining({ turn: '2', retryCount: '0' }));
    expect(Number(meta?.turnStartedAtMs)).toBeGreaterThanOrEqual(
      Number(metaBeforeSecondFailure?.turnStartedAtMs ?? '0'),
    );

    const thirdResult = await engine.processAction(matchId, {
      tool: 'move',
      request_id: 'req3-3',
      args: {},
    });
    expect(thirdResult).toMatchObject({ status: 'ok', request_id: 'req3-3' });

    const stateAfterConsumeThenMove = await redisManager.getMatchState<{ turn: number }>(matchId);
    expect(stateAfterConsumeThenMove).toEqual(expect.objectContaining({ turn: 3 }));
    meta = await redisManager.getMatchMeta(matchId);
    expect(meta).toEqual(expect.objectContaining({ turn: '3', retryCount: '0' }));
  });

  it('should fail immediately on non-retryable error', async () => {
    const matchId = 'match-5';
    await engine.startMatch(matchId, 'test-game', 123);

    const action: Action = { tool: 'invalid', request_id: 'req4', args: {} };
    const result = await engine.processAction(matchId, action);

    expect(result).toMatchObject({ status: 'error', request_id: 'req4' });
    if (result.status === 'error') {
      expect(result.error.retryable).toBe(false);
    }

    const meta = await redisManager.getMatchMeta(matchId);
    expect(meta).toEqual(expect.objectContaining({ retryCount: '0' }));
  });

  it('should fail if turn lock cannot be acquired', async () => {
    const matchId = 'match-6';
    await engine.startMatch(matchId, 'test-game', 123);

    // Manually acquire lock to simulate concurrency
    await redisManager.acquireTurnLock(matchId, 10, 'manual-owner');

    const action: Action = { tool: 'move', request_id: 'req5', args: {} };
    const result = await engine.processAction(matchId, action);

    expect(result).toMatchObject({ status: 'error', request_id: 'req5' });
    if (result.status === 'error') {
      expect(result.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(result.error.message).toContain('lock');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('should enforce turn timeout', async () => {
    const matchId = 'match-7';
    await engine.startMatch(matchId, 'test-game', 123);

    const meta = await redisManager.getMatchMeta(matchId);
    expect(meta).not.toBeNull();
    if (!meta) {
      throw new Error('missing match meta');
    }
    await redisManager.saveMatchMeta(matchId, {
      ...meta,
      turnStartedAtMs: (Date.now() - 31_000).toString(),
    });

    const action: Action = { tool: 'move', request_id: 'req-timeout', args: {} };
    const result = await engine.processAction(matchId, action);

    expect(result).toMatchObject({ status: 'error', request_id: 'req-timeout' });
    if (result.status === 'error') {
      expect(result.error.code).toBe('TURN_EXPIRED');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('should return cached idempotent response with request_id', async () => {
    const matchId = 'match-8';
    await engine.startMatch(matchId, 'test-game', 123);

    const action: Action = { tool: 'move', request_id: 'req-cache', args: {} };
    const first = await engine.processAction(matchId, action);
    const second = await engine.processAction(matchId, action);

    expect(first).toMatchObject({ request_id: 'req-cache' });
    expect(second).toEqual(first);
  });
});
