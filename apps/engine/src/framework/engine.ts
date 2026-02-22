import type { GamePlugin, Action } from './types.js';
import type { RedisManager } from '../state/redis-manager.js';
import type { JsonValue, CommonErrorCode } from '@moltgames/domain';

const MAX_RETRIES = 3;
const LOCK_TTL_SECONDS = 5;

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
    const locked = await this.redis.acquireTurnLock(matchId, LOCK_TTL_SECONDS);
    if (!locked) {
      return {
        status: 'error',
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Could not acquire turn lock, please retry',
          retryable: true,
        },
      };
    }

    try {
      // 1. Load Meta and State concurrently
      const [meta, state] = await Promise.all([
        this.redis.getMatchMeta(matchId),
        this.redis.getMatchState(matchId),
      ]);

      if (!meta) {
        return {
          status: 'error',
          error: {
            code: 'INVALID_REQUEST',
            message: `Match not found: ${matchId}`,
            retryable: true,
          },
        };
      }

      if (!state) {
        return {
          status: 'error',
          error: {
            code: 'INTERNAL_ERROR',
            message: `Match state not found: ${matchId}`,
            retryable: false,
          },
        };
      }

      const gameId = meta.gameId;
      if (!gameId) {
        return {
          status: 'error',
          error: {
            code: 'INTERNAL_ERROR',
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
            code: 'INTERNAL_ERROR',
            message: `Game plugin not found: ${gameId}`,
            retryable: false,
          },
        };
      }

      // 3. Validate
      const validation = plugin.validateAction(state, action);
      if (!validation.valid) {
        const currentRetryCount = parseInt(meta.retryCount || '0', 10);
        const isRetryable = validation.retryable !== false && currentRetryCount < MAX_RETRIES;

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
        retryCount: '0', // Reset on successful action
      };
      await this.redis.saveMatchMeta(matchId, newMeta);

      return {
        status: 'ok',
        result,
      };
    } finally {
      await this.redis.releaseTurnLock(matchId);
    }
  }
}
