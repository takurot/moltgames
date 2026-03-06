#!/usr/bin/env node

import { Command } from 'commander';
import {
  createPromptInjectionPlanner,
  Runner,
  type RunnerOptions,
  type ActionPlanner,
} from './runner.js';
import { LLMActionPlanner, type LLMActionPlannerOptions } from './planners/llm-planner.js';
import { OpenAIAdapter } from './adapters/llm-adapter.js';
import { ConsoleJsonTraceLogger } from './logging/trace-logger.js';

const program = new Command();

program.name('moltgame-runner').description('Moltgame autonomous agent runner').version('0.1.0');

interface RunCommandOptions {
  url: string;
  token?: string;
  sessionId?: string;
  reconnectInitialMs: string;
  reconnectMaxMs: string;
  responseRetryInitialMs: string;
  responseRetryMaxMs: string;
  llmProvider?: string;
  model?: string;
  systemPrompt?: string;
  agentId?: string;
  matchId?: string;
}

program
  .command('run')
  .description('Run autonomous agent loop using prompt injection fallback planner')
  .requiredOption('-u, --url <url>', 'Gateway WebSocket URL', 'ws://localhost:8080/v1/ws')
  .option('-t, --token <token>', 'Connect token')
  .option('-s, --session-id <sessionId>', 'Resume existing session')
  .option('--reconnect-initial-ms <ms>', 'Initial reconnect delay in milliseconds', '1000')
  .option('--reconnect-max-ms <ms>', 'Maximum reconnect delay in milliseconds', '8000')
  .option(
    '--response-retry-initial-ms <ms>',
    'Initial retry delay after retryable tool errors',
    '250',
  )
  .option('--response-retry-max-ms <ms>', 'Maximum retry delay after retryable tool errors', '2000')
  .option('--llm-provider <provider>', 'LLM Provider to use (e.g. "openai")')
  .option('--model <model>', 'Model name to use with the provider')
  .option('--system-prompt <prompt>', 'System prompt to initialize the agent with')
  .option('--agent-id <agentId>', 'Agent identifier for trace logs')
  .option('--match-id <matchId>', 'Match identifier for trace logs')
  .action(async (options: RunCommandOptions) => {
    if (!options.token && !options.sessionId) {
      throw new Error('Either --token or --session-id must be provided');
    }

    let planner: ActionPlanner;

    if (options.llmProvider === 'openai') {
      const adapterOptions: { model?: string } = {};
      if (options.model !== undefined) {
        adapterOptions.model = options.model;
      }
      const adapter = new OpenAIAdapter(adapterOptions);

      const plannerOptions: LLMActionPlannerOptions = { adapter };
      if (options.systemPrompt !== undefined) {
        plannerOptions.systemPrompt = options.systemPrompt;
      }
      planner = new LLMActionPlanner(plannerOptions);
    } else {
      planner = createPromptInjectionPlanner();
    }

    const runnerOptions: RunnerOptions = {
      url: options.url,
      reconnectInitialDelayMs: Number.parseInt(options.reconnectInitialMs, 10),
      reconnectMaxDelayMs: Number.parseInt(options.reconnectMaxMs, 10),
      responseRetryInitialDelayMs: Number.parseInt(options.responseRetryInitialMs, 10),
      responseRetryMaxDelayMs: Number.parseInt(options.responseRetryMaxMs, 10),
      traceLogger: new ConsoleJsonTraceLogger({
        agentId: options.agentId,
        matchId: options.matchId,
        provider: options.llmProvider,
        model: options.model,
      }),
      planner,
    };

    if (options.token !== undefined) {
      runnerOptions.token = options.token;
    }

    if (options.sessionId !== undefined) {
      runnerOptions.sessionId = options.sessionId;
    }

    const runner = new Runner(runnerOptions);

    runner.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('runner error:', message);
    });

    runner.on('match/ended', (message: unknown) => {
      console.log('match ended:', message);
    });

    await runner.connect();
    console.log('runner connected. press Ctrl+C to stop.');

    process.on('SIGINT', () => {
      runner.close();
      process.exit(0);
    });
  });

if (process.env.NODE_ENV !== 'test') {
  program.parse();
}

export { createPromptInjectionPlanner, Runner } from './runner.js';
