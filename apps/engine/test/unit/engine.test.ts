import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Engine } from '../../src/framework/engine.js';
import { RedisManager } from '../../src/state/redis-manager.js';
import type { GamePlugin, Action } from '../../src/framework/types.js';

vi.mock('../../src/state/redis-manager.js');

describe('Engine', () => {
  let engine: Engine;
  let redisManager: RedisManager;
  let mockPlugin: GamePlugin;

  beforeEach(() => {
    redisManager = new RedisManager('redis://localhost');
    engine = new Engine(redisManager);

    mockPlugin = {
      gameId: 'test-game',
      ruleVersion: '1.0.0',
      initialize: vi.fn().mockReturnValue({ turn: 0 }),
      getTurn: vi.fn().mockReturnValue(0),
      getAvailableTools: vi.fn().mockReturnValue([]),
      validateAction: vi.fn().mockReturnValue({ valid: true }),
      applyAction: vi.fn().mockReturnValue({ state: { turn: 1 }, result: { success: true } }),
      checkTermination: vi.fn().mockReturnValue(null),
    };
    engine.registerPlugin(mockPlugin);
  });

  it('should start match and save rule version', async () => {
    await engine.startMatch('match1', 'test-game', 123);

    expect(redisManager.saveMatchState).toHaveBeenCalledWith('match1', { turn: 0 });
    expect(redisManager.saveMatchMeta).toHaveBeenCalledWith('match1', expect.objectContaining({
      gameId: 'test-game',
      ruleVersion: '1.0.0'
    }));
  });

  it('should handle idempotency in processAction', async () => {
    // Setup mocks
    (redisManager.acquireTurnLock as any).mockResolvedValue(true);
    (redisManager.getMatchMeta as any).mockResolvedValue({ gameId: 'test-game' });
    (redisManager.getMatchState as any).mockResolvedValue({ turn: 0 });
    // Mock checkRequestIdProcessed to return true (already processed)
    (redisManager.checkRequestIdProcessed as any).mockResolvedValue(true);
    const cachedResponse = { status: 'ok', result: { cached: true } };
    (redisManager.getProcessedResponse as any).mockResolvedValue(cachedResponse);

    const action: Action = { tool: 'move', request_id: 'req1', args: {} };
    const result = await engine.processAction('match1', action);

    expect(result).toEqual(cachedResponse);
    // Should NOT apply action
    expect(mockPlugin.applyAction).not.toHaveBeenCalled();
  });

  it('should process new action and save for idempotency', async () => {
     // Setup mocks
    (redisManager.acquireTurnLock as any).mockResolvedValue(true);
    (redisManager.getMatchMeta as any).mockResolvedValue({ gameId: 'test-game' });
    (redisManager.getMatchState as any).mockResolvedValue({ turn: 0 });
    (redisManager.checkRequestIdProcessed as any).mockResolvedValue(false);

    const action: Action = { tool: 'move', request_id: 'req2', args: {} };
    const result = await engine.processAction('match1', action);

    expect(result).toEqual({ status: 'ok', result: { success: true } });
    expect(mockPlugin.applyAction).toHaveBeenCalled();
    // Should save processed request
    expect(redisManager.markRequestIdProcessed).toHaveBeenCalledWith('match1', 'req2', expect.any(Object));
  });

  it('should handle termination', async () => {
    // Mock termination
    (mockPlugin.checkTermination as any).mockReturnValue({ ended: true, winner: 'agent1', reason: 'win' });

    (redisManager.acquireTurnLock as any).mockResolvedValue(true);
    (redisManager.getMatchMeta as any).mockResolvedValue({ gameId: 'test-game' });
    (redisManager.getMatchState as any).mockResolvedValue({ turn: 0 });
    (redisManager.checkRequestIdProcessed as any).mockResolvedValue(false);

    const action: Action = { tool: 'move', request_id: 'req3', args: {} };
    const result = await engine.processAction('match1', action);

    expect(result).toEqual({
        status: 'ok',
        result: { success: true },
        termination: { ended: true, winner: 'agent1', reason: 'win' }
    });
  });
});
