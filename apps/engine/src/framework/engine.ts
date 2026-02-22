import { randomUUID } from 'node:crypto';
import type { Action, GamePlugin, TerminationResult } from './types.js';
import type { RedisManager } from '../state/redis-manager.js';
import {
  isCommonErrorCode,
  isJsonValue,
  isNonEmptyString,
  isRecord,
  type CommonErrorCode,
  type JsonValue,
} from '@moltgames/domain';

const MAX_RETRIES = 1;
const DEFAULT_TURN_TIMEOUT_SECONDS = 30;
const LOCK_TTL_EXTRA_SECONDS = 5;

type ProcessActionOkResponse =
  | { request_id: string; status: 'ok'; result: JsonValue }
  | { request_id: string; status: 'ok'; result: JsonValue; termination: TerminationResult };

type ProcessActionErrorResponse = {
  request_id: string;
  status: 'error';
  error: { code: CommonErrorCode; message: string; retryable: boolean };
};

type ProcessActionResponse = ProcessActionOkResponse | ProcessActionErrorResponse;

const parsePositiveInt = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
};

const parseNonNegativeInt = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
};

const isTerminationResult = (value: unknown): value is TerminationResult => {
  if (!isRecord(value) || typeof value.ended !== 'boolean') {
    return false;
  }

  if ('winner' in value && value.winner !== undefined && typeof value.winner !== 'string') {
    return false;
  }

  if ('reason' in value && value.reason !== undefined && typeof value.reason !== 'string') {
    return false;
  }

  return true;
};

const isProcessActionResponse = (value: unknown): value is ProcessActionResponse => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.request_id) ||
    (value.status !== 'ok' && value.status !== 'error')
  ) {
    return false;
  }

  if (value.status === 'ok') {
    if (!isJsonValue(value.result)) {
      return false;
    }

    if ('termination' in value) {
      return isTerminationResult(value.termination);
    }

    return true;
  }

  if (!isRecord(value.error)) {
    return false;
  }

  return (
    isCommonErrorCode(value.error.code) &&
    typeof value.error.message === 'string' &&
    typeof value.error.retryable === 'boolean'
  );
};

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
    const turnTimeoutSeconds = this.getTurnTimeoutSeconds(null, plugin);
    const turnStartedAtMs = Date.now().toString();

    await this.redis.saveMatchState(matchId, state);
    await this.redis.saveMatchMeta(matchId, {
      gameId,
      seed: seed.toString(),
      ruleVersion: plugin.ruleVersion,
      turn: turn.toString(),
      retryCount: '0',
      turnTimeoutSec: turnTimeoutSeconds.toString(),
      turnStartedAtMs,
    });
  }

  async processAction(matchId: string, action: Action): Promise<ProcessActionResponse> {
    // 0. Check Idempotency
    const isProcessed = await this.redis.checkRequestIdProcessed(matchId, action.request_id);
    if (isProcessed) {
      const cached = await this.redis.getProcessedResponse(matchId, action.request_id);
      if (isProcessActionResponse(cached)) {
        return cached;
      }
    }

    const lockOwnerToken = randomUUID();
    const lockTtlSeconds =
      this.getTurnTimeoutSeconds(await this.redis.getMatchMeta(matchId)) + LOCK_TTL_EXTRA_SECONDS;
    const locked = await this.redis.acquireTurnLock(matchId, lockTtlSeconds, lockOwnerToken);
    if (!locked) {
      return {
        request_id: action.request_id,
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
          request_id: action.request_id,
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
          request_id: action.request_id,
          status: 'error',
          error: {
            code: 'INTERNAL_ERROR' as CommonErrorCode,
            message: `Match state not found: ${matchId}`,
            retryable: false,
          },
        };
      }

      const gameId = meta.gameId;
      if (!gameId) {
        return {
          request_id: action.request_id,
          status: 'error',
          error: {
            code: 'INTERNAL_ERROR' as CommonErrorCode,
            message: `Match meta missing gameId: ${matchId}`,
            retryable: false,
          },
        };
      }

      const plugin = this.plugins.get(gameId);
      if (!plugin) {
        return {
          request_id: action.request_id,
          status: 'error',
          error: {
            code: 'INTERNAL_ERROR' as CommonErrorCode,
            message: `Game plugin not found: ${gameId}`,
            retryable: false,
          },
        };
      }

      const turnTimeoutSeconds = this.getTurnTimeoutSeconds(meta, plugin);
      if (this.isTurnExpired(meta, turnTimeoutSeconds)) {
        const response: ProcessActionErrorResponse = {
          request_id: action.request_id,
          status: 'error',
          error: {
            code: 'TURN_EXPIRED',
            message: `Turn exceeded ${turnTimeoutSeconds} seconds`,
            retryable: false,
          },
        };
        await this.redis.markRequestIdProcessed(
          matchId,
          action.request_id,
          this.toCacheResponse(response),
        );
        return response;
      }

      // 3. Validate
      const validation = plugin.validateAction(state, action);
      if (!validation.valid) {
        const currentRetryCount = parseNonNegativeInt(meta.retryCount) ?? 0;
        const isRetryable = validation.retryable !== false && currentRetryCount < MAX_RETRIES;

        if (isRetryable) {
          // Increment retry count
          await this.redis.saveMatchMeta(matchId, {
            ...meta,
            retryCount: (currentRetryCount + 1).toString(),
          });
        } else if (validation.retryable !== false) {
          // Second retryable failure consumes the turn.
          const currentTurn = parseNonNegativeInt(meta.turn) ?? 0;
          await this.redis.saveMatchMeta(matchId, {
            ...meta,
            turn: (currentTurn + 1).toString(),
            retryCount: '0',
            turnTimeoutSec: turnTimeoutSeconds.toString(),
            turnStartedAtMs: Date.now().toString(),
          });
        }

        const response = {
          request_id: action.request_id,
          status: 'error',
          error: {
            code: 'VALIDATION_ERROR',
            message: validation.error || 'Invalid action',
            retryable: isRetryable,
          },
        } as const;

        // Mark processed even for validation errors to ensure idempotency
        await this.redis.markRequestIdProcessed(matchId, action.request_id, response);

        return response;
      }

      // 4. Apply Action
      const { state: newState, result } = plugin.applyAction(state, action);
      const newTurn = plugin.getTurn(newState);
      const currentTurn = parseNonNegativeInt(meta.turn) ?? newTurn;

      // 5. Check Termination
      const termination = plugin.checkTermination(newState);

      // 6. Save State
      await this.redis.saveMatchState(matchId, newState);

      // Update meta
      const newMeta: Record<string, string | number> = {
        ...meta,
        turn: newTurn.toString(),
        retryCount: '0', // Reset on successful action
        turnTimeoutSec: turnTimeoutSeconds.toString(),
        turnStartedAtMs:
          newTurn === currentTurn
            ? (meta.turnStartedAtMs ?? Date.now().toString())
            : Date.now().toString(),
      };
      await this.redis.saveMatchMeta(matchId, newMeta);

      const response: ProcessActionOkResponse = termination
        ? { request_id: action.request_id, status: 'ok', result, termination }
        : { request_id: action.request_id, status: 'ok', result };

      await this.redis.markRequestIdProcessed(
        matchId,
        action.request_id,
        this.toCacheResponse(response),
      );

      return response;
    } finally {
      await this.redis.releaseTurnLock(matchId, lockOwnerToken);
    }
  }

  private getTurnTimeoutSeconds(meta: Record<string, string> | null, plugin?: GamePlugin): number {
    const timeoutFromMeta = parsePositiveInt(meta?.turnTimeoutSec);
    if (timeoutFromMeta !== null) {
      return timeoutFromMeta;
    }

    if (
      plugin?.turnTimeoutSeconds !== undefined &&
      Number.isInteger(plugin.turnTimeoutSeconds) &&
      plugin.turnTimeoutSeconds > 0
    ) {
      return plugin.turnTimeoutSeconds;
    }

    return DEFAULT_TURN_TIMEOUT_SECONDS;
  }

  private isTurnExpired(meta: Record<string, string>, timeoutSeconds: number): boolean {
    const turnStartedAtMs = parsePositiveInt(meta.turnStartedAtMs);
    if (turnStartedAtMs === null) {
      return false;
    }

    const elapsedMs = Date.now() - turnStartedAtMs;
    return elapsedMs > timeoutSeconds * 1000;
  }

  private toCacheResponse(response: ProcessActionResponse): JsonValue {
    if (response.status === 'error') {
      return {
        request_id: response.request_id,
        status: 'error',
        error: {
          code: response.error.code,
          message: response.error.message,
          retryable: response.error.retryable,
        },
      };
    }

    if ('termination' in response) {
      return {
        request_id: response.request_id,
        status: 'ok',
        result: response.result,
        termination: this.toCacheTermination(response.termination),
      };
    }

    return {
      request_id: response.request_id,
      status: 'ok',
      result: response.result,
    };
  }

  private toCacheTermination(termination: TerminationResult): JsonValue {
    const serialized: Record<string, JsonValue> = {
      ended: termination.ended,
    };

    if (termination.winner !== undefined) {
      serialized.winner = termination.winner;
    }

    if (termination.reason !== undefined) {
      serialized.reason = termination.reason;
    }

    return serialized;
  }
}
