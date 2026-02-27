#!/usr/bin/env node

import { Command } from 'commander';
import { createPromptInjectionPlanner, Runner, type RunnerOptions } from './runner.js';

const program = new Command();

program.name('moltgame-runner').description('Moltgame autonomous agent runner').version('0.1.0');

interface RunCommandOptions {
  url: string;
  token?: string;
  sessionId?: string;
  reconnectInitialMs: string;
  reconnectMaxMs: string;
}

program
  .command('run')
  .description('Run autonomous agent loop using prompt injection fallback planner')
  .requiredOption('-u, --url <url>', 'Gateway WebSocket URL', 'ws://localhost:8080/v1/ws')
  .option('-t, --token <token>', 'Connect token')
  .option('-s, --session-id <sessionId>', 'Resume existing session')
  .option('--reconnect-initial-ms <ms>', 'Initial reconnect delay in milliseconds', '1000')
  .option('--reconnect-max-ms <ms>', 'Maximum reconnect delay in milliseconds', '8000')
  .action(async (options: RunCommandOptions) => {
    if (!options.token && !options.sessionId) {
      throw new Error('Either --token or --session-id must be provided');
    }

    const runnerOptions: RunnerOptions = {
      url: options.url,
      reconnectInitialDelayMs: Number.parseInt(options.reconnectInitialMs, 10),
      reconnectMaxDelayMs: Number.parseInt(options.reconnectMaxMs, 10),
      planner: createPromptInjectionPlanner(),
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
