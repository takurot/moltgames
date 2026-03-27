import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadRuleCatalog } from '@moltgames/rules';
import { Engine } from './framework/engine.js';
import { RedisManager } from './state/redis-manager.js';
import type { Action } from './framework/types.js';
import { PromptInjectionArena } from './games/prompt-injection-arena.js';
import { VectorGridWars } from './games/vector-grid-wars/index.js';
import { DilemmaPoker } from './games/dilemma-poker/index.js';
import { RuleRegistry } from './rules/registry.js';

export interface CreateServerOptions {
  rulesDir?: string;
}

export const createServer = async (options: CreateServerOptions = {}) => {
  const fastify = Fastify({
    logger: true,
  });

  await fastify.register(cors);

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const redisManager = new RedisManager(redisUrl);
  const ruleCatalog = await loadRuleCatalog(
    options.rulesDir === undefined ? {} : { definitionsDir: options.rulesDir },
  );
  const ruleRegistry = new RuleRegistry(redisManager, ruleCatalog);
  await ruleRegistry.initialize();
  const engine = new Engine(redisManager, ruleRegistry);

  // Register game plugins
  engine.registerPlugin(new PromptInjectionArena());
  engine.registerPlugin(new VectorGridWars());
  engine.registerPlugin(new DilemmaPoker());

  fastify.post<{
    Params: { matchId: string };
    Body: { gameId: string; seed: number; attackerId?: string; defenderId?: string };
  }>(
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
            attackerId: { type: 'string', minLength: 1 },
            defenderId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { matchId } = request.params;
      const { gameId, seed, attackerId, defenderId } = request.body;

      try {
        const roleAssignments =
          typeof attackerId === 'string' &&
          attackerId.length > 0 &&
          typeof defenderId === 'string' &&
          defenderId.length > 0
            ? { attackerId, defenderId }
            : undefined;

        if (roleAssignments === undefined) {
          await engine.startMatch(matchId, gameId, seed);
        } else {
          await engine.startMatch(matchId, gameId, seed, { roleAssignments });
        }
        return { status: 'ok' };
      } catch (error: unknown) {
        request.log.error(error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        reply.status(500).send({ status: 'error', message });
      }
    },
  );

  fastify.get('/rules/active', async () => {
    return {
      status: 'ok',
      rules: await ruleRegistry.listActiveRules(),
    };
  });

  fastify.get<{ Params: { gameId: string } }>(
    '/rules/:gameId/audit',
    {
      schema: {
        params: {
          type: 'object',
          required: ['gameId'],
          additionalProperties: false,
          properties: {
            gameId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        return {
          status: 'ok',
          entries: await ruleRegistry.listAuditEntries(request.params.gameId),
        };
      } catch (error: unknown) {
        request.log.error(error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        reply.status(500).send({ status: 'error', message });
      }
    },
  );

  fastify.put<{
    Params: { gameId: string };
    Body: { ruleId: string; ruleVersion: string; actor: string; reason?: string };
  }>(
    '/rules/:gameId/active',
    {
      schema: {
        params: {
          type: 'object',
          required: ['gameId'],
          additionalProperties: false,
          properties: {
            gameId: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['ruleId', 'ruleVersion', 'actor'],
          additionalProperties: false,
          properties: {
            ruleId: { type: 'string', minLength: 1 },
            ruleVersion: { type: 'string', minLength: 1 },
            actor: { type: 'string', minLength: 1 },
            reason: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const input = {
          gameId: request.params.gameId,
          ruleId: request.body.ruleId,
          ruleVersion: request.body.ruleVersion,
          actor: request.body.actor,
        } as const;

        const entry = await ruleRegistry.publishRule(
          request.body.reason === undefined ? input : { ...input, reason: request.body.reason },
        );
        return { status: 'ok', entry };
      } catch (error: unknown) {
        request.log.error(error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        reply.status(500).send({ status: 'error', message });
      }
    },
  );

  fastify.post<{
    Params: { gameId: string };
    Body: { actor: string; reason?: string; targetRuleId?: string; targetRuleVersion?: string };
  }>(
    '/rules/:gameId/rollback',
    {
      schema: {
        params: {
          type: 'object',
          required: ['gameId'],
          additionalProperties: false,
          properties: {
            gameId: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['actor'],
          additionalProperties: false,
          properties: {
            actor: { type: 'string', minLength: 1 },
            reason: { type: 'string' },
            targetRuleId: { type: 'string' },
            targetRuleVersion: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const baseInput = {
          gameId: request.params.gameId,
          actor: request.body.actor,
        } as const;

        const entry = await ruleRegistry.rollbackRule({
          ...baseInput,
          ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
          ...(request.body.targetRuleId === undefined
            ? {}
            : { targetRuleId: request.body.targetRuleId }),
          ...(request.body.targetRuleVersion === undefined
            ? {}
            : { targetRuleVersion: request.body.targetRuleVersion }),
        });
        return { status: 'ok', entry };
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

  fastify.get<{ Params: { matchId: string }; Querystring: { agentId: string } }>(
    '/matches/:matchId/tools',
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
        querystring: {
          type: 'object',
          required: ['agentId'],
          properties: {
            agentId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { matchId } = request.params;
      const { agentId } = request.query;

      try {
        const tools = await engine.getAvailableTools(matchId, agentId);
        return { status: 'ok', tools };
      } catch (error: unknown) {
        request.log.error(error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        reply.status(500).send({ status: 'error', message });
      }
    },
  );

  fastify.get<{ Params: { matchId: string } }>(
    '/matches/:matchId/meta',
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
      },
    },
    async (request, reply) => {
      const { matchId } = request.params;
      const meta = await redisManager.getMatchMeta(matchId);
      if (!meta || !meta.gameId) {
        reply.status(404).send({ status: 'error', message: `Match not found: ${matchId}` });
        return;
      }
      return { status: 'ok', gameId: meta.gameId, ruleVersion: meta.ruleVersion ?? null };
    },
  );

  fastify.get('/healthz', async (_request, reply) => {
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Redis ping timeout')), 1000),
      );
      await Promise.race([redisManager.ping(), timeoutPromise]);
      return { status: 'ok' };
    } catch {
      reply.status(503);
      return { status: 'error', message: 'Redis unavailable' };
    }
  });

  const close = async () => {
    await redisManager.close();
    await fastify.close();
  };

  return { fastify, close, engine, redisManager, ruleRegistry };
};
