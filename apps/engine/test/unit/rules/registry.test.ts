import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadRuleCatalog } from '@moltgames/rules';

import { RuleRegistry } from '../../../src/rules/registry.js';
import { RedisManager } from '../../../src/state/redis-manager.js';

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
      description: 'Send a message',
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
  ],
  parameters: {
    minimumDialogueRoundsForSecretGuess: 2,
    maxSecretGuessAttempts: 1,
  },
  termination: {
    type: 'prompt-injection-arena',
  },
  redactionPolicy: {
    type: 'mask-secret-values',
    placeholder: '***REDACTED***',
  },
});

describe('RuleRegistry', () => {
  let workingDir: string;
  let redisManager: RedisManager;

  beforeEach(async () => {
    workingDir = await mkdtemp(path.join(tmpdir(), 'moltgames-engine-rules-'));
    await writeFile(
      path.join(workingDir, 'prompt-injection-arena.standard.v1.json'),
      JSON.stringify(createRuleDefinition('1.0.0', 10), null, 2),
      'utf8',
    );
    await writeFile(
      path.join(workingDir, 'prompt-injection-arena.standard.v2.json'),
      JSON.stringify(createRuleDefinition('2.0.0', 14), null, 2),
      'utf8',
    );

    redisManager = new RedisManager('redis://localhost:6379');
  });

  afterEach(async () => {
    await redisManager.close();
    await rm(workingDir, { recursive: true, force: true });
  });

  it('publishes a rule, records audit history, and rolls back to the previous snapshot', async () => {
    const catalog = await loadRuleCatalog({ definitionsDir: workingDir });
    const registry = new RuleRegistry(redisManager, catalog);

    await registry.initialize();

    await registry.publishRule({
      gameId: 'prompt-injection-arena',
      ruleId: 'standard',
      ruleVersion: '1.0.0',
      actor: 'tester',
      reason: 'pin stable baseline',
    });

    expect(
      (await registry.getActiveRuleDefinition('prompt-injection-arena'))?.ruleVersion,
    ).toBe('1.0.0');

    await registry.publishRule({
      gameId: 'prompt-injection-arena',
      ruleId: 'standard',
      ruleVersion: '2.0.0',
      actor: 'tester',
      reason: 'promote updated rule pack',
    });

    expect(
      (await registry.getActiveRuleDefinition('prompt-injection-arena'))?.ruleVersion,
    ).toBe('2.0.0');

    const auditBeforeRollback = await registry.listAuditEntries('prompt-injection-arena');
    expect(auditBeforeRollback).toHaveLength(2);
    expect(auditBeforeRollback[0]?.action).toBe('publish');
    expect(auditBeforeRollback[1]?.action).toBe('publish');

    await registry.rollbackRule({
      gameId: 'prompt-injection-arena',
      actor: 'tester',
      reason: 'restore stable baseline',
    });

    expect(
      (await registry.getActiveRuleDefinition('prompt-injection-arena'))?.ruleVersion,
    ).toBe('1.0.0');

    const auditAfterRollback = await registry.listAuditEntries('prompt-injection-arena');
    expect(auditAfterRollback).toHaveLength(3);
    expect(auditAfterRollback[2]?.action).toBe('rollback');
    expect(auditAfterRollback[2]?.to.ruleVersion).toBe('1.0.0');
  });
});
