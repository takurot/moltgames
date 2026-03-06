import { describe, expect, it } from 'vitest';
import type { MCPToolDefinition } from '@moltgames/mcp-protocol';
import { ToolCallGuard } from '../../../src/guard/tool-call-guard.js';

const TEST_TOOLS: MCPToolDefinition[] = [
  {
    name: 'send_message',
    description: 'Send a message',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_secret',
    description: 'Guess the secret',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        guess: { type: 'string' },
      },
      required: ['guess'],
      additionalProperties: false,
    },
  },
];

describe('ToolCallGuard', () => {
  const guard = new ToolCallGuard();

  it('accepts actions that target an allowed tool with schema-valid args', () => {
    const result = guard.validate({
      action: {
        tool: 'send_message',
        args: { content: 'hello' },
      },
      tools: TEST_TOOLS,
    });

    expect(result).toEqual({
      ok: true,
      tool: TEST_TOOLS[0],
    });
  });

  it('rejects tools that are not present in tools/list', () => {
    const result = guard.validate({
      action: {
        tool: 'move_unit',
        args: { x: 1, y: 2 },
      },
      tools: TEST_TOOLS,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('move_unit');
    expect(result.reason).toContain('send_message');
    expect(result.reason).toContain('check_secret');
  });

  it('rejects args that do not satisfy the selected tool schema', () => {
    const result = guard.validate({
      action: {
        tool: 'send_message',
        args: {
          content: 123,
          extra: true,
        },
      },
      tools: TEST_TOOLS,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('send_message');
    expect(result.reason).toContain('content');
  });

  it('rebuilds the validator when the schema changes for the same tool version', () => {
    const originalTool: MCPToolDefinition = {
      name: 'send_message',
      description: 'Send a message',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
        },
        required: ['content'],
        additionalProperties: false,
      },
    };
    const changedTool: MCPToolDefinition = {
      name: 'send_message',
      description: 'Send a message',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          payload: { type: 'string' },
        },
        required: ['payload'],
        additionalProperties: false,
      },
    };

    expect(
      guard.validate({
        action: {
          tool: 'send_message',
          args: { content: 'hello' },
        },
        tools: [originalTool],
      }),
    ).toMatchObject({ ok: true });

    const result = guard.validate({
      action: {
        tool: 'send_message',
        args: { content: 'hello' },
      },
      tools: [changedTool],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('payload');
  });
});
