import OpenAI from 'openai';
import type { MCPToolDefinition } from '@moltgames/mcp-protocol';

export interface LLMToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface LLMAdapterContext {
  systemPrompt?: string;
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
  tools: MCPToolDefinition[];
}

export interface LLMAdapter {
  generateAction(context: LLMAdapterContext): Promise<LLMToolCall | null>;
}

export interface OpenAIAdapterOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  maxOutputTokens?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseToolArguments = (value: unknown): Record<string, unknown> | null => {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

interface ResponseFunctionCall {
  name: string;
  arguments: unknown;
}

const extractFirstFunctionCall = (response: unknown): ResponseFunctionCall | null => {
  if (!isRecord(response) || !Array.isArray(response.output)) {
    return null;
  }

  for (const item of response.output) {
    if (!isRecord(item) || item.type !== 'function_call' || typeof item.name !== 'string') {
      continue;
    }

    return {
      name: item.name,
      arguments: item.arguments,
    };
  }

  return null;
};

export class OpenAIAdapter implements LLMAdapter {
  private client: OpenAI;
  private model: string;
  private maxOutputTokens: number | undefined;

  constructor(options: OpenAIAdapterOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {};

    if (apiKey) {
      clientOptions.apiKey = apiKey;
    }
    if (options.baseURL) {
      clientOptions.baseURL = options.baseURL;
    }

    this.client = new OpenAI(clientOptions);
    this.model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
    this.maxOutputTokens = options.maxOutputTokens;
  }

  async generateAction(context: LLMAdapterContext): Promise<LLMToolCall | null> {
    const formattedTools: OpenAI.Responses.Tool[] = context.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
      strict: false,
    }));

    const input: OpenAI.Responses.ResponseInput = [];

    if (context.systemPrompt) {
      input.push({
        role: 'system',
        content: context.systemPrompt,
      });
    }

    for (const message of context.messages) {
      input.push({
        role: message.role,
        content: message.content,
      });
    }

    const createOptions: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model: this.model,
      input,
    };

    if (formattedTools.length > 0) {
      createOptions.tools = formattedTools;
      createOptions.tool_choice = 'auto';
    }

    const maxOutputTokens = this.maxOutputTokens;
    if (
      typeof maxOutputTokens === 'number' &&
      Number.isInteger(maxOutputTokens) &&
      maxOutputTokens > 0
    ) {
      createOptions.max_output_tokens = maxOutputTokens;
    }

    const response = await this.client.responses.create(createOptions);
    const toolCall = extractFirstFunctionCall(response);
    if (!toolCall) {
      return null;
    }

    const args = parseToolArguments(toolCall.arguments);
    if (!args) {
      return null;
    }

    return {
      tool: toolCall.name,
      args,
    };
  }
}

export class MockLLMAdapter implements LLMAdapter {
  private mockResponses: LLMToolCall[];
  private callCount = 0;

  constructor(mockResponses: LLMToolCall[] = []) {
    this.mockResponses = mockResponses;
  }

  async generateAction(_context: LLMAdapterContext): Promise<LLMToolCall | null> {
    if (this.callCount < this.mockResponses.length) {
      const response = this.mockResponses[this.callCount++];
      return response === undefined ? null : response;
    }
    return null;
  }

  getCallCount(): number {
    return this.callCount;
  }
}
