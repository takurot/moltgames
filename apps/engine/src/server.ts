import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Engine } from './framework/engine.js';
import { RedisManager } from './state/redis-manager.js';
import type { Action } from './framework/types.js';

export const createServer = async () => {
  const fastify = Fastify({
    logger: true,
  });

  await fastify.register(cors);

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const redisManager = new RedisManager(redisUrl);
  const engine = new Engine(redisManager);

  // TODO: Register game plugins here (PR-08, 09, 10)

  fastify.post<{ Params: { matchId: string }; Body: { gameId: string; seed: number } }>(
    '/matches/:matchId/start',
    {
      schema: {
        params: {
          type: 'object',
          required: ['matchId'],
          additionalProperties: false,
          properties: {
            matchId: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['gameId', 'seed'],
          additionalProperties: false,
          properties: {
            gameId: { type: 'string', minLength: 1 },
            seed: { type: 'integer' },
          },
        },
      },
    },
    async (request, reply) => {
      const { matchId } = request.params;
      const { gameId, seed } = request.body;

      try {
        await engine.startMatch(matchId, gameId, seed);
        return { status: 'ok' };
      } catch (error: unknown) {
        request.log.error(error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        reply.status(500).send({ status: 'error', message });
      }
    },
  );

  fastify.post<{ Params: { matchId: string }; Body: Action }>(
    '/matches/:matchId/action',
    {
      schema: {
        body: {
          type: 'object',
          required: ['tool', 'request_id', 'args'],
          properties: {
            tool: { type: 'string' },
            request_id: { type: 'string' },
            args: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      const { matchId } = request.params;
      const action = request.body;

      try {
        const result = await engine.processAction(matchId, action);
        return result;
      } catch (error: unknown) {
        request.log.error(error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        reply.status(500).send({ status: 'error', message });
      }
    },
  );

  fastify.get('/healthz', async () => {
    return { status: 'ok' };
  });

  const close = async () => {
    await redisManager.close();
    await fastify.close();
  };

  return { fastify, close, engine };
};
