import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createServer } from '../../src/server.js';
import type { Action, GamePlugin } from '../../src/framework/types.js';
import type { JsonValue } from '@moltgames/domain';

vi.mock('ioredis', () => import('ioredis-mock'));
vi.mock('@moltgames/mcp-protocol', () => ({
  DILEMMA_POKER_GET_STATUS_SCHEMA: { type: 'object', properties: {}, additionalProperties: false },
  DILEMMA_POKER_NEGOTIATE_SCHEMA: { type: 'object', properties: {}, additionalProperties: false },
  DILEMMA_POKER_COMMIT_ACTION_SCHEMA: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  BLUFF_DICE_GET_STATE_SCHEMA: { type: 'object', properties: {}, additionalProperties: false },
  BLUFF_DICE_PLACE_BET_SCHEMA: { type: 'object', properties: {}, additionalProperties: false },
  BLUFF_DICE_MAKE_BID_SCHEMA: { type: 'object', properties: {}, additionalProperties: false },
  BLUFF_DICE_CALL_BLUFF_SCHEMA: { type: 'object', properties: {}, additionalProperties: false },
  isMcpToolDefinition: () => true,
  isToolCallResponse: () => true,
  parseToolCallRequest: (value: unknown) => value,
}));
vi.mock('@moltgames/rules', () => ({
  loadRuleCatalog: vi.fn(async () => ({
    listGames: () => [],
    getLatestRule: () => undefined,
    getRule: () => undefined,
  })),
}));

interface IntegrationState {
  turn: number;
  total: number;
}

const integrationPlugin: GamePlugin<IntegrationState> = {
  gameId: 'integration-game',
  ruleVersion: '1.0.0',
  initialize: () => ({ turn: 1, total: 0 }),
  getTurn: (state) => state.turn,
  consumeTurn: (state) => ({ ...state, turn: state.turn + 1 }),
  getAvailableTools: () => [
    {
      name: 'increment',
      description: 'Increment the running total',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
        },
        required: ['amount'],
        additionalProperties: false,
      },
    },
  ],
  validateAction: (_state, action: Action) => {
    const amount = action.args.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      return { valid: false, error: 'amount must be a finite number' };
    }

    return { valid: true };
  },
  applyAction: (state, action: Action) => {
    const amount = action.args.amount as number;
    const nextState = {
      ...state,
      turn: state.turn + 1,
      total: state.total + amount,
    };

    return {
      state: nextState,
      result: { total: nextState.total, turn: nextState.turn } as JsonValue,
    };
  },
  checkTermination: () => null,
};

const createIntegrationServer = async () => {
  const server = await createServer();
  server.engine.registerPlugin(integrationPlugin);
  await server.fastify.ready();
  return server;
};

describe('Engine integration', () => {
  let server: Awaited<ReturnType<typeof createIntegrationServer>>;
  let fastify: FastifyInstance;

  beforeEach(async () => {
    server = await createIntegrationServer();
    fastify = server.fastify;
  });

  afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
  });

  it('processes a valid action and persists the updated state', async () => {
    const matchId = 'match-valid-action';

    const startResponse = await fastify.inject({
      method: 'POST',
      url: `/matches/${matchId}/start`,
      payload: { gameId: 'integration-game', seed: 1 },
    });

    expect(startResponse.statusCode).toBe(200);

    const actionResponse = await fastify.inject({
      method: 'POST',
      url: `/matches/${matchId}/action`,
      payload: {
        tool: 'increment',
        request_id: 'request-1',
        args: { amount: 3 },
        actor: 'agent-1',
      },
    });

    expect(actionResponse.statusCode).toBe(200);
    expect(actionResponse.json()).toMatchObject({
      request_id: 'request-1',
      status: 'ok',
      result: { total: 3, turn: 2 },
    });

    expect(await server.redisManager.getMatchState<IntegrationState>(matchId)).toEqual({
      turn: 2,
      total: 3,
    });
  });

  it('returns TURN_EXPIRED when the turn deadline has elapsed', async () => {
    const matchId = 'match-expired-turn';

    const startResponse = await fastify.inject({
      method: 'POST',
      url: `/matches/${matchId}/start`,
      payload: { gameId: 'integration-game', seed: 1 },
    });

    expect(startResponse.statusCode).toBe(200);

    const expiredTurnStartedAt = Date.now() - 31_000;
    const meta = await server.redisManager.getMatchMeta(matchId);
    expect(meta).not.toBeNull();
    await server.redisManager.saveMatchMeta(matchId, {
      ...meta,
      turnStartedAtMs: expiredTurnStartedAt.toString(),
    });

    const actionResponse = await fastify.inject({
      method: 'POST',
      url: `/matches/${matchId}/action`,
      payload: {
        tool: 'increment',
        request_id: 'request-2',
        args: { amount: 1 },
        actor: 'agent-1',
      },
    });

    expect(actionResponse.statusCode).toBe(200);
    expect(actionResponse.json()).toMatchObject({
      request_id: 'request-2',
      status: 'error',
      error: {
        code: 'TURN_EXPIRED',
        retryable: false,
      },
    });
    expect(await server.redisManager.getMatchState<IntegrationState>(matchId)).toEqual({
      turn: 1,
      total: 0,
    });
  });

  it('returns the cached response for duplicate request ids', async () => {
    const matchId = 'match-duplicate-request';

    const startResponse = await fastify.inject({
      method: 'POST',
      url: `/matches/${matchId}/start`,
      payload: { gameId: 'integration-game', seed: 1 },
    });

    expect(startResponse.statusCode).toBe(200);

    const payload = {
      tool: 'increment',
      request_id: 'request-3',
      args: { amount: 2 },
      actor: 'agent-1',
    };

    const firstResponse = await fastify.inject({
      method: 'POST',
      url: `/matches/${matchId}/action`,
      payload,
    });
    const secondResponse = await fastify.inject({
      method: 'POST',
      url: `/matches/${matchId}/action`,
      payload,
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(await server.redisManager.getMatchState<IntegrationState>(matchId)).toEqual({
      turn: 2,
      total: 2,
    });
  });

  it('rejects unknown game ids on match start', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/matches/match-unknown-game/start',
      payload: { gameId: 'missing-game', seed: 1 },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      status: 'error',
      message: 'Game plugin not found: missing-game',
    });
  });
});
