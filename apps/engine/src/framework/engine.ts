import type { GamePlugin, Action } from './types.js';
import type { RedisManager } from '../state/redis-manager.js';
import type { JsonValue, CommonErrorCode } from '@moltgames/domain';

export class Engine {
  private plugins = new Map<string, GamePlugin>();

  constructor(private redis: RedisManager) {}

  registerPlugin(plugin: GamePlugin) {
    this.plugins.set(plugin.gameId, plugin);
  }

  async startMatch(matchId: string, gameId: string, seed: number): Promise<void> {
    const plugin = this.plugins.get(gameId);
    if (!plugin) {
      throw new Error(`Game plugin not found: ${gameId}`);
    }

    const state = plugin.initialize(seed);
    const turn = plugin.getTurn(state);

    await this.redis.saveMatchState(matchId, state);
    await this.redis.saveMatchMeta(matchId, {
      gameId,
      turn: turn.toString(),
      retryCount: '0',
    });
  }

  async processAction(
    matchId: string,
    action: Action,
  ): Promise<
    | { status: 'ok'; result: JsonValue }
    | { status: 'error'; error: { code: CommonErrorCode; message: string; retryable: boolean } }
  > {
    // 1. Load Meta
    const meta = await this.redis.getMatchMeta(matchId);
    if (!meta) {
      return {
        status: 'error',
        error: {
          code: 'INVALID_REQUEST',
          message: `Match not found: ${matchId}`,
          retryable: true, // Maybe transient?
        },
      };
    }

    const gameId = meta.gameId;
    if (!gameId) {
      return {
        status: 'error',
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: `Match meta missing gameId: ${matchId}`,
          retryable: false,
        },
      };
    }

    const plugin = this.plugins.get(gameId);
    if (!plugin) {
      return {
        status: 'error',
        error: {
          code: 'SERVICE_UNAVAILABLE', // Or INTERNAL_ERROR but that's not in CommonErrorCode
          message: `Game plugin not found: ${gameId}`,
          retryable: false,
        },
      };
    }

    // 2. Load State
    const state = await this.redis.getMatchState(matchId);
    if (!state) {
      return {
        status: 'error',
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: `Match state not found: ${matchId}`,
          retryable: false,
        },
      };
    }

    // 3. Validate
    const validation = plugin.validateAction(state, action);
    if (!validation.valid) {
      const currentRetryCount = parseInt(meta.retryCount || '0', 10);
      const isRetryable = validation.retryable !== false && currentRetryCount < 1;

      if (isRetryable) {
        // Increment retry count
        await this.redis.saveMatchMeta(matchId, {
          ...meta,
          retryCount: (currentRetryCount + 1).toString(),
        });
      }

      return {
        status: 'error',
        error: {
          code: 'VALIDATION_ERROR',
          message: validation.error || 'Invalid action',
          retryable: isRetryable,
        },
      };
    }

    // 4. Apply Action
    const { state: newState, result } = plugin.applyAction(state, action);
    const newTurn = plugin.getTurn(newState);

    // 5. Check Termination (TODO: Handle termination result)
    // const termination = plugin.checkTermination(newState);

    // 6. Save State
    await this.redis.saveMatchState(matchId, newState);

    // Update meta
    const newMeta: Record<string, string | number> = {
      ...meta,
      turn: newTurn.toString(),
    };
    if (newTurn !== parseInt(meta.turn || '0', 10)) {
      newMeta.retryCount = '0';
    }
    await this.redis.saveMatchMeta(matchId, newMeta);

    return {
      status: 'ok',
      result,
    };
  }
}
