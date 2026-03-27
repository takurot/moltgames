import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server.js';
import type { Action, GamePlugin } from '../../src/framework/types.js';

vi.mock('ioredis', () => import('ioredis-mock'));

const mockPlugin: GamePlugin<{ turn: number }> = {
  gameId: 'test-game',
  ruleVersion: '1.0.0',
  initialize: () => ({ turn: 1 }),
  getTurn: (state) => state.turn,
  consumeTurn: (state) => ({ ...state, turn: state.turn + 1 }),
  getAvailableTools: (state, agentId, phase) => [
    {
      name: 'test_tool',
      description: 'Test tool',
      version: '1.0.0',
      inputSchema: { type: 'object' },
    },
  ],
  validateAction: () => ({ valid: true }),
  applyAction: (state, _action: Action) => ({ state, result: { ok: true } }),
  checkTermination: () => null,
};

describe('Engine server /matches/:matchId/start', () => {
  let fastify: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const server = await createServer();
    server.engine.registerPlugin(mockPlugin);
    fastify = server.fastify;
    close = server.close;
  });

  afterEach(async () => {
    await close();
  });

  it('returns 400 when start body is missing required fields', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/matches/match-1/start',
      payload: { gameId: 'test-game' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when gameId is empty', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/matches/match-1/start',
      payload: { gameId: '', seed: 1 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('accepts valid start request', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/matches/match-1/start',
      payload: { gameId: 'test-game', seed: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('accepts custom role assignments for prompt-injection-arena start request', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/matches/match-3/start',
      payload: {
        gameId: 'prompt-injection-arena',
        seed: 1,
        attackerId: 'alpha-agent',
        defenderId: 'beta-agent',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    const attackerToolsResponse = await fastify.inject({
      method: 'GET',
      url: '/matches/match-3/tools',
      query: { agentId: 'alpha-agent' },
    });

    expect(attackerToolsResponse.statusCode).toBe(200);
    expect(attackerToolsResponse.json()).toEqual(
      expect.objectContaining({
        status: 'ok',
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'send_message' }),
        ]),
      }),
    );

    const defenderToolsResponse = await fastify.inject({
      method: 'GET',
      url: '/matches/match-3/tools',
      query: { agentId: 'beta-agent' },
    });

    expect(defenderToolsResponse.statusCode).toBe(200);
    expect(defenderToolsResponse.json()).toEqual(
      expect.objectContaining({
        status: 'ok',
        tools: [],
      }),
    );
  });

  it('returns available tools for an active match', async () => {
    const startResponse = await fastify.inject({
      method: 'POST',
      url: '/matches/match-2/start',
      payload: { gameId: 'test-game', seed: 1 },
    });
    expect(startResponse.statusCode).toBe(200);

    const toolsResponse = await fastify.inject({
      method: 'GET',
      url: '/matches/match-2/tools',
      query: { agentId: 'agent-1' },
    });

    expect(toolsResponse.statusCode).toBe(200);
    expect(toolsResponse.json()).toEqual({
      status: 'ok',
      tools: [
        {
          name: 'test_tool',
          description: 'Test tool',
          version: '1.0.0',
          inputSchema: { type: 'object' },
        },
      ],
    });
  });
});

describe('Engine server /healthz', () => {
  let fastify: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const server = await createServer();
    fastify = server.fastify;
    close = server.close;
  });

  afterEach(async () => {
    await close();
  });

  it('returns 200 with status ok when Redis is reachable', async () => {
    const response = await fastify.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 when Redis ping fails', async () => {
    const server2 = await createServer();
    vi.spyOn(server2.redisManager, 'ping').mockRejectedValueOnce(new Error('Redis unavailable'));
    const response = await server2.fastify.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(503);
    await server2.close();
  });
});
