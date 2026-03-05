import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPToolDefinition } from '@moltgames/mcp-protocol';
import { MockLLMAdapter, OpenAIAdapter } from '../../../src/adapters/llm-adapter.js';

const openAiMockState = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  createCalls: [] as unknown[],
  queuedResponses: [] as unknown[],
}));

vi.mock('openai', () => {
  class MockOpenAI {
    responses = {
      create: async (params: unknown) => {
        openAiMockState.createCalls.push(params);
        if (openAiMockState.queuedResponses.length === 0) {
          return { output: [] };
        }

        return openAiMockState.queuedResponses.shift();
      },
    };

    constructor(options: unknown) {
      openAiMockState.constructorOptions.push(options);
    }
  }

  return { default: MockOpenAI };
});

const TEST_TOOLS: MCPToolDefinition[] = [
  {
    name: 'send_message',
    description: 'Send a chat message',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
      },
      required: ['content'],
      additionalProperties: false,
    } as unknown as MCPToolDefinition['inputSchema'],
  },
];

describe('MockLLMAdapter', () => {
  it('returns queued responses in order and then null', async () => {
    const adapter = new MockLLMAdapter([
      { tool: 'send_message', args: { content: 'first' } },
      { tool: 'send_message', args: { content: 'second' } },
    ]);

    await expect(adapter.generateAction({ messages: [], tools: TEST_TOOLS })).resolves.toEqual({
      tool: 'send_message',
      args: { content: 'first' },
    });
    await expect(adapter.generateAction({ messages: [], tools: TEST_TOOLS })).resolves.toEqual({
      tool: 'send_message',
      args: { content: 'second' },
    });
    await expect(adapter.generateAction({ messages: [], tools: TEST_TOOLS })).resolves.toBeNull();

    expect(adapter.getCallCount()).toBe(2);
  });
});

describe('OpenAIAdapter', () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_MODEL;

  beforeEach(() => {
    openAiMockState.constructorOptions.length = 0;
    openAiMockState.createCalls.length = 0;
    openAiMockState.queuedResponses.length = 0;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }

    if (originalModel === undefined) {
      delete process.env.OPENAI_MODEL;
    } else {
      process.env.OPENAI_MODEL = originalModel;
    }
  });

  it('loads api key and model from environment variables', async () => {
    process.env.OPENAI_API_KEY = 'env-key';
    process.env.OPENAI_MODEL = 'gpt-env';

    const adapter = new OpenAIAdapter();
    openAiMockState.queuedResponses.push({ output: [] });

    await adapter.generateAction({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      tools: TEST_TOOLS,
    });

    expect(openAiMockState.constructorOptions).toEqual([{ apiKey: 'env-key' }]);
    expect(openAiMockState.createCalls).toHaveLength(1);
    expect(openAiMockState.createCalls[0]).toMatchObject({ model: 'gpt-env' });
  });

  it('returns the first function call from responses output', async () => {
    openAiMockState.queuedResponses.push({
      output: [
        {
          type: 'function_call',
          name: 'send_message',
          arguments: '{"content":"hello"}',
        },
      ],
    });

    const adapter = new OpenAIAdapter({ apiKey: 'test-key', model: 'gpt-test' });

    await expect(
      adapter.generateAction({
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hello' }],
        tools: TEST_TOOLS,
      }),
    ).resolves.toEqual({
      tool: 'send_message',
      args: { content: 'hello' },
    });

    expect(openAiMockState.createCalls[0]).toMatchObject({
      model: 'gpt-test',
      tool_choice: 'auto',
    });
  });

  it('returns null when function-call arguments are invalid json', async () => {
    openAiMockState.queuedResponses.push({
      output: [
        {
          type: 'function_call',
          name: 'send_message',
          arguments: '{bad-json}',
        },
      ],
    });

    const adapter = new OpenAIAdapter({ apiKey: 'test-key' });
    await expect(
      adapter.generateAction({
        messages: [{ role: 'user', content: 'hello' }],
        tools: TEST_TOOLS,
      }),
    ).resolves.toBeNull();
  });
});
