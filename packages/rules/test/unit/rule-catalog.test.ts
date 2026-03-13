import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertRuleVersionCompatibility, loadRuleCatalog } from '../../src/index.js';

const writeRuleFile = async (
  dir: string,
  filename: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  await writeFile(path.join(dir, filename), JSON.stringify(payload, null, 2), 'utf8');
};

describe('rule catalog', () => {
  let workingDir: string | null = null;

  afterEach(async () => {
    if (workingDir !== null) {
      await rm(workingDir, { recursive: true, force: true });
      workingDir = null;
    }
  });

  it('loads validated JSON and YAML rule definitions from disk', async () => {
    workingDir = await mkdtemp(path.join(tmpdir(), 'moltgames-rules-'));

    await writeRuleFile(workingDir, 'prompt-injection-arena.standard.v1.json', {
      gameId: 'prompt-injection-arena',
      ruleId: 'standard',
      ruleVersion: '1.1.0',
      turnLimit: 10,
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
      },
      termination: {
        type: 'prompt-injection-arena',
        defenderWinReason: 'Defense successful',
      },
      redactionPolicy: {
        type: 'mask-secret-values',
        placeholder: '***REDACTED***',
      },
    });

    await writeFile(
      path.join(workingDir, 'prompt-injection-arena.standard.v2.yaml'),
      [
        'gameId: prompt-injection-arena',
        'ruleId: standard',
        'ruleVersion: 2.0.0',
        'turnLimit: 12',
        'turnTimeoutSeconds: 45',
        'tools:',
        '  - name: send_message',
        '    description: Send a message',
        '    version: 1.0.0',
        '    inputSchema:',
        '      type: object',
        '      properties:',
        '        content:',
        '          type: string',
        '          minLength: 1',
        '      required:',
        '        - content',
        '      additionalProperties: false',
        'parameters:',
        '  minimumDialogueRoundsForSecretGuess: 3',
        'termination:',
        '  type: prompt-injection-arena',
        '  defenderWinReason: Defense successful',
        'redactionPolicy:',
        '  type: mask-secret-values',
        '  placeholder: "***REDACTED***"',
        '',
      ].join('\n'),
      'utf8',
    );

    const catalog = await loadRuleCatalog({ definitionsDir: workingDir });

    const definitions = catalog.listRules('prompt-injection-arena');
    expect(definitions).toHaveLength(2);
    expect(catalog.getLatestRule('prompt-injection-arena')?.ruleVersion).toBe('2.0.0');
  });

  it('requires a major version bump for breaking contract changes', () => {
    const previous = {
      gameId: 'prompt-injection-arena',
      ruleId: 'standard',
      ruleVersion: '1.1.0',
      turnLimit: 10,
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
      parameters: {},
      termination: {
        type: 'prompt-injection-arena',
      },
      redactionPolicy: {
        type: 'mask-secret-values',
        placeholder: '***REDACTED***',
      },
    };

    const breakingMinor = {
      ...previous,
      ruleVersion: '1.2.0',
      tools: [
        {
          name: 'send_message',
          description: 'Send a message',
          version: '1.0.0',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string', minLength: 10 },
            },
            required: ['content'],
            additionalProperties: false,
          },
        },
      ],
    };

    expect(() => assertRuleVersionCompatibility(previous, breakingMinor)).toThrow(/major version/i);

    const breakingMajor = {
      ...breakingMinor,
      ruleVersion: '2.0.0',
    };

    expect(() => assertRuleVersionCompatibility(previous, breakingMajor)).not.toThrow();
  });
});
