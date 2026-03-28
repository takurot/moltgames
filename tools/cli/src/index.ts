#!/usr/bin/env node
import { Command } from 'commander';
import { Client } from './client.js';
import { createLoginCommand, createLogoutCommand } from './commands/login.js';
import { createMatchCommand, createQueueCommand } from './commands/match.js';
import { createWatchCommand } from './commands/watch.js';
import {
  createLeaderboardCommand,
  createHistoryCommand,
  createReplayCommand,
} from './commands/data.js';

const program = new Command();

program
  .name('moltgame')
  .description('Moltgame CLI — manage auth, matches, and agents from the terminal')
  .version('0.2.0');

// Legacy connect command (kept for backwards compatibility)
program
  .command('connect')
  .description('Connect to a match using a connect token')
  .requiredOption('-t, --token <token>', 'Connect token')
  .option('-u, --url <url>', 'Gateway WebSocket URL', 'ws://localhost:8080/v1/ws')
  .action(async (options) => {
    const client = new Client({
      url: options.url,
      token: options.token,
    });

    try {
      await client.connect();
      console.log('Client connected and running. Press Ctrl+C to disconnect.');

      // Keep alive
      process.on('SIGINT', () => {
        console.log('Disconnecting...');
        client.close();
        process.exit(0);
      });
    } catch (error: unknown) {
      console.error('Failed to connect:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Auth commands
program.addCommand(createLoginCommand());
program.addCommand(createLogoutCommand());

// Match commands
program.addCommand(createMatchCommand());
program.addCommand(createQueueCommand());

// Watch command
program.addCommand(createWatchCommand());

// Data commands
program.addCommand(createLeaderboardCommand());
program.addCommand(createHistoryCommand());
program.addCommand(createReplayCommand());

if (process.env.NODE_ENV !== 'test') {
  program.parse();
}
