import type { ActionPlanner, ActionPlannerContext, RunnerAction } from '../runner.js';
import type { LLMAdapter } from '../adapters/llm-adapter.js';
import { ToolCallGuard } from '../guard/tool-call-guard.js';

export interface LLMActionPlannerOptions {
  adapter: LLMAdapter;
  systemPrompt?: string;
  maxRetries?: number;
}

export class LLMActionPlanner implements ActionPlanner {
  private adapter: LLMAdapter;
  private systemPrompt?: string;
  private maxRetries: number;
  private guard: ToolCallGuard;
  // In a real application, you'd likely want to maintain history
  // For this isolated planner, we keep a very basic conversation thread
  private history: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];

  constructor(options: LLMActionPlannerOptions) {
    this.adapter = options.adapter;
    if (options.systemPrompt !== undefined) {
      this.systemPrompt = options.systemPrompt;
    }
    this.maxRetries = options.maxRetries ?? 3;
    this.guard = new ToolCallGuard();
  }

  async decide(context: ActionPlannerContext): Promise<RunnerAction | null> {
    const tools = context.tools;
    if (tools.length === 0) {
      return null;
    }

    let retryCount = 0;
    let lastError = '';

    while (retryCount <= this.maxRetries) {
      const messages = [...this.history];
      if (lastError) {
        messages.push({ role: 'user', content: lastError });
      } else {
        // Initial prompt for the turn if not a retry
        messages.push({
          role: 'user',
          content: 'It is your turn. Choose the best action from the available tools.',
        });
      }

      const adapterContext: Parameters<typeof this.adapter.generateAction>[0] = {
        messages: messages,
        tools: tools,
      };
      if (this.systemPrompt !== undefined) {
        adapterContext.systemPrompt = this.systemPrompt;
      }

      const llmAction = await this.adapter.generateAction(adapterContext);

      if (!llmAction) {
        // LLM failed to return a valid action/tool call
        lastError = 'You failed to call a tool. You MUST call one of the provided tools.';
        retryCount++;
        continue;
      }

      const validation = this.guard.validate({
        action: llmAction,
        tools,
      });
      if (!validation.ok) {
        lastError = validation.reason;
        retryCount++;
        continue;
      }

      // Valid action found
      return {
        tool: llmAction.tool,
        args: llmAction.args,
      };
    }

    console.warn(`LLMActionPlanner exhausted retries (${this.maxRetries}). Fallback to null.`);
    return null;
  }

  public addHistory(role: 'user' | 'assistant', content: string) {
    this.history.push({ role, content });
  }
}
