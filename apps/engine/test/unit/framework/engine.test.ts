import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Engine } from '../../../src/framework/engine.js';
import { RedisManager } from '../../../src/state/redis-manager.js';
import type {
  GamePlugin,
  Action,
  ValidationResult,
  TerminationResult,
  ApplyActionResult,
} from '../../../src/framework/types.js';
import Redis from 'ioredis-mock';
import type { JsonValue } from '@moltgames/domain';

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
        return this.client.hgetall(`match:${matchId}:meta`);
      }
      async saveMatchMeta(matchId: string, meta: any) {
        await this.client.hset(`match:${matchId}:meta`, meta);
      }
    },
  };
});

// Mock Game Plugin
class MockGamePlugin implements GamePlugin<any> {
  gameId = 'test-game';
  ruleVersion = '1.0.0';

  initialize(seed: number) {
    return { turn: 1, value: 0 };
  }
  getTurn(state: any) {
    return state.turn;
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
        turn: '1',
        retryCount: '0',
      }),
    );
  });

  it('should process a valid action', async () => {
    const matchId = 'match-2';
    await engine.startMatch(matchId, 'test-game', 123);

    const action: Action = { tool: 'move', args: {} };
    const result = await engine.processAction(matchId, action);

    expect(result.status).toBe('ok');
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

    const action: Action = { tool: 'retryable_error', args: {} };
    const result = await engine.processAction(matchId, action);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.retryable).toBe(true);
    }

    const meta = await redisManager.getMatchMeta(matchId);
    expect(meta).toEqual(expect.objectContaining({ retryCount: '1' }));
  });

  it('should fail on second retryable error', async () => {
    const matchId = 'match-4';
    await engine.startMatch(matchId, 'test-game', 123);

    const action: Action = { tool: 'retryable_error', args: {} };

    // First attempt
    await engine.processAction(matchId, action);

    // Second attempt
    const result = await engine.processAction(matchId, action);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('should fail immediately on non-retryable error', async () => {
    const matchId = 'match-5';
    await engine.startMatch(matchId, 'test-game', 123);

    const action: Action = { tool: 'invalid', args: {} };
    const result = await engine.processAction(matchId, action);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.retryable).toBe(false);
    }

    const meta = await redisManager.getMatchMeta(matchId);
    expect(meta).toEqual(expect.objectContaining({ retryCount: '0' }));
  });
});
