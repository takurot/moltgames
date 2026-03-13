import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServer } from '../../src/server.js';
import type { PromptInjectionArenaState } from '../../src/games/prompt-injection-arena.js';

vi.mock('ioredis', () => import('ioredis-mock'));

const createRuleDefinition = (ruleVersion: string, turnLimit: number) => ({
  gameId: 'prompt-injection-arena',
  ruleId: 'standard',
  ruleVersion,
  turnLimit,
  turnTimeoutSeconds: 30,
  tools: [
    {
      name: 'send_message',
      description: 'Send a message to the defender',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 1 },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
    {
      name: 'respond',
      description: 'Respond to the attacker',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 1 },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
    {
      name: 'check_secret',
      description: 'Attempt to guess the secret string',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          guess: { type: 'string', minLength: 1 },
        },
        required: ['guess'],
        additionalProperties: false,
      },
    },
  ],
  parameters: {
    minimumDialogueRoundsForSecretGuess: 2,
    maxSecretGuessAttempts: 1,
  },
  termination: {
    type: 'prompt-injection-arena',
    defenderWinReason: 'Defense successful',
    guessLimitReason: 'Secret guess limit reached',
    attackerWinReason: 'Secret leaked',
  },
  redactionPolicy: {
    type: 'mask-secret-values',
    placeholder: '***REDACTED***',
  },
});

describe('engine server rule management', () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(path.join(tmpdir(), 'moltgames-server-rules-'));
    await writeFile(
      path.join(workingDir, 'prompt-injection-arena.standard.v1.json'),
      JSON.stringify(createRuleDefinition('1.0.0', 6), null, 2),
      'utf8',
    );
    await writeFile(
      path.join(workingDir, 'prompt-injection-arena.standard.v2.json'),
      JSON.stringify(createRuleDefinition('2.0.0', 12), null, 2),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it('applies a published rule only to new matches and keeps older matches pinned', async () => {
    const server = await createServer({ rulesDir: workingDir });

    try {
      const publishV1 = await server.fastify.inject({
        method: 'PUT',
        url: '/rules/prompt-injection-arena/active',
        payload: {
          ruleId: 'standard',
          ruleVersion: '1.0.0',
          actor: 'tester',
          reason: 'seed baseline',
        },
      });
      expect(publishV1.statusCode).toBe(200);

      const firstStart = await server.fastify.inject({
        method: 'POST',
        url: '/matches/match-old/start',
        payload: { gameId: 'prompt-injection-arena', seed: 11 },
      });
      expect(firstStart.statusCode).toBe(200);

      const publishV2 = await server.fastify.inject({
        method: 'PUT',
        url: '/rules/prompt-injection-arena/active',
        payload: {
          ruleId: 'standard',
          ruleVersion: '2.0.0',
          actor: 'tester',
          reason: 'promote next version',
        },
      });
      expect(publishV2.statusCode).toBe(200);

      const secondStart = await server.fastify.inject({
        method: 'POST',
        url: '/matches/match-new/start',
        payload: { gameId: 'prompt-injection-arena', seed: 22 },
      });
      expect(secondStart.statusCode).toBe(200);

      const oldMeta = await server.redisManager.getMatchMeta('match-old');
      const newMeta = await server.redisManager.getMatchMeta('match-new');
      const oldState =
        await server.redisManager.getMatchState<PromptInjectionArenaState>('match-old');
      const newState =
        await server.redisManager.getMatchState<PromptInjectionArenaState>('match-new');

      expect(oldMeta).toEqual(
        expect.objectContaining({
          gameId: 'prompt-injection-arena',
          ruleId: 'standard',
          ruleVersion: '1.0.0',
        }),
      );
      expect(newMeta).toEqual(
        expect.objectContaining({
          gameId: 'prompt-injection-arena',
          ruleId: 'standard',
          ruleVersion: '2.0.0',
        }),
      );
      expect(oldState?.maxTurns).toBe(6);
      expect(newState?.maxTurns).toBe(12);

      const auditResponse = await server.fastify.inject({
        method: 'GET',
        url: '/rules/prompt-injection-arena/audit',
      });

      expect(auditResponse.statusCode).toBe(200);
      expect(auditResponse.json()).toEqual({
        status: 'ok',
        entries: expect.arrayContaining([
          expect.objectContaining({
            action: 'publish',
            to: expect.objectContaining({ ruleVersion: '1.0.0' }),
          }),
          expect.objectContaining({
            action: 'publish',
            to: expect.objectContaining({ ruleVersion: '2.0.0' }),
          }),
        ]),
      });
    } finally {
      await server.close();
    }
  }, 10000);
});
