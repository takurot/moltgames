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

export class OpenAIAdapter implements LLMAdapter {
    private client: OpenAI;
    private model: string;

    constructor(options: { apiKey?: string; model?: string } = {}) {
        const clientOptions: Record<string, unknown> = {};
        if (options.apiKey) {
            clientOptions.apiKey = options.apiKey;
        } else if (process.env.OPENAI_API_KEY) {
            clientOptions.apiKey = process.env.OPENAI_API_KEY;
        }

        this.client = new OpenAI(clientOptions);
        this.model = options.model || 'gpt-4-turbo'; // Default model
    }

    async generateAction(context: LLMAdapterContext): Promise<LLMToolCall | null> {
        const formattedTools: OpenAI.Chat.Completions.ChatCompletionTool[] = context.tools.map(
            (tool) => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema as Record<string, unknown>,
                },
            }),
        );

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

        if (context.systemPrompt) {
            messages.push({ role: 'system', content: context.systemPrompt });
        }

        messages.push(...context.messages);

        const createOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
            model: this.model,
            messages,
        };

        if (formattedTools.length > 0) {
            createOptions.tools = formattedTools;
            createOptions.tool_choice = 'auto';
        }

        const response = await this.client.chat.completions.create(createOptions);

        const choice = response.choices[0];
        if (!choice) {
            return null;
        }

        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
            const toolCall = choice.message.tool_calls[0];
            if (toolCall && toolCall.type === 'function' && toolCall.function) {
                try {
                    const args = JSON.parse(toolCall.function.arguments);
                    return {
                        tool: toolCall.function.name,
                        args,
                    };
                } catch (e) {
                    console.error('Failed to parse tool arguments from OpenAI', e);
                    return null;
                }
            }
        }

        return null;
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
