import { describe, expect, it } from 'vitest';
import { LLMActionPlanner } from '../../../src/planners/llm-planner.js';
import { MockLLMAdapter } from '../../../src/adapters/llm-adapter.js';
import type { MCPToolDefinition } from '@moltgames/mcp-protocol';
import type { ActionPlannerContext } from '../../../src/runner.js';

describe('LLMActionPlanner', () => {
  const mockTools: MCPToolDefinition[] = [
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
      } as any,
    },
    {
      name: 'check_secret',
      description: 'Check secret',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          guess: { type: 'string' },
        },
        required: ['guess'],
      } as any,
    },
  ];

  const mockContext: ActionPlannerContext = {
    sessionId: 'test-session',
    tools: mockTools,
  };

  it('should return a valid action when LLM returns correct tool and args', async () => {
    const adapter = new MockLLMAdapter([
      { tool: 'send_message', args: { content: 'hello world' } },
    ]);
    const planner = new LLMActionPlanner({ adapter });

    const action = await planner.decide(mockContext);

    expect(action).toEqual({
      tool: 'send_message',
      args: { content: 'hello world' },
    });
    expect(adapter.getCallCount()).toBe(1);
  });

  it('should retry when LLM returns an invalid tool name', async () => {
    const adapter = new MockLLMAdapter([
      { tool: 'invalid_tool', args: {} }, // 1st try: invalid tool
      { tool: 'send_message', args: { content: 'hello' } }, // 2nd try: valid
    ]);
    const planner = new LLMActionPlanner({ adapter });

    const action = await planner.decide(mockContext);

    expect(action).toEqual({
      tool: 'send_message',
      args: { content: 'hello' },
    });
    expect(adapter.getCallCount()).toBe(2);
  });

  it('should retry when LLM returns invalid arguments that violate JSON schema', async () => {
    const adapter = new MockLLMAdapter([
      { tool: 'send_message', args: { wrong_arg: 'hello' } }, // 1st try: missing content
      { tool: 'send_message', args: { content: 123 } }, // 2nd try: content is number, not string
      { tool: 'send_message', args: { content: 'valid message' } }, // 3rd try: valid
    ]);
    // default maxRetries is 3
    const planner = new LLMActionPlanner({ adapter });

    const action = await planner.decide(mockContext);

    expect(action).toEqual({
      tool: 'send_message',
      args: { content: 'valid message' },
    });
    expect(adapter.getCallCount()).toBe(3);
  });

  it('should return null when max retries are exhausted', async () => {
    const adapter = new MockLLMAdapter([
      { tool: 'send_message', args: { wrong_arg: 'hello' } },
      { tool: 'send_message', args: { wrong_arg: 'hello' } },
    ]);
    const planner = new LLMActionPlanner({ adapter, maxRetries: 1 });

    const action = await planner.decide(mockContext);

    expect(action).toBeNull();
    expect(adapter.getCallCount()).toBe(2); // Initial + 1 retry
  });

  it('should return null if LLM constantly returns null (no tool called)', async () => {
    const adapter = new MockLLMAdapter([]); // Adapter returning null
    const planner = new LLMActionPlanner({ adapter, maxRetries: 1 });

    const action = await planner.decide(mockContext);
    expect(action).toBeNull();
  });
});
