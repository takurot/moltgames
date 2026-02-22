#!/usr/bin/env node
import { Command } from 'commander';
import { Client } from './client.js';

const program = new Command();

program
  .name('moltgame-client')
  .description('Moltgame Agent CLI Client')
  .version('0.1.0');

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
    } catch (error: any) {
      console.error('Failed to connect:', error.message);
      process.exit(1);
    }
  });

program.parse();
