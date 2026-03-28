import { Command } from 'commander';
import WebSocket from 'ws';
import { printError, printInfo } from '../output.js';

/** Convert an http(s) URL to a ws(s) URL. */
export function httpToWs(url: string): string {
  if (url.startsWith('https://')) {
    return url.replace(/^https:\/\//, 'wss://');
  }
  if (url.startsWith('http://')) {
    return url.replace(/^http:\/\//, 'ws://');
  }
  return url;
}

/** Format a parsed event object for human-readable terminal output. */
function formatEvent(event: Record<string, unknown>): string {
  const type = String(event.type ?? 'unknown');

  if (type === 'turn_start') {
    return `[TURN ${event.turn ?? '?'}] actor=${event.actor ?? '?'}`;
  }

  if (type === 'tool_call') {
    return `[TOOL] ${event.tool ?? '?'}`;
  }

  if (type === 'match_end') {
    return `[MATCH END] winner=${event.winner ?? '?'} reason=${event.reason ?? '?'}`;
  }

  return `[${type.toUpperCase()}] ${JSON.stringify(event)}`;
}

export function createWatchCommand(): Command {
  return new Command('watch')
    .description('Watch a live match as a spectator')
    .argument('<matchId>', 'Match ID to watch')
    .option('--url <url>', 'Gateway base URL', 'http://localhost:8080')
    .option('--json', 'Output events as NDJSON to stdout')
    .action(
      async (matchId: string, options: { url: string; json?: boolean }): Promise<void> => {
        const { url, json } = options;

        const wsBase = httpToWs(url);
        const wsUrl = `${wsBase}/v1/ws/spectate?match_id=${encodeURIComponent(matchId)}`;

        printInfo(`Connecting to match ${matchId}...`);

        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(wsUrl, {
            headers: {
              'Sec-WebSocket-Protocol': 'moltgame-v1',
            },
          });

          ws.on('open', () => {
            printInfo(`Connected. Watching match ${matchId}.`);
          });

          ws.on('message', (data: Buffer | string) => {
            const text = typeof data === 'string' ? data : data.toString('utf-8');

            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(text) as Record<string, unknown>;
            } catch {
              printError(`Failed to parse message: ${text}`);
              return;
            }

            if (json) {
              process.stdout.write(JSON.stringify(parsed) + '\n');
            } else {
              printInfo(formatEvent(parsed));
            }

            // Close gracefully on match end
            if (parsed['type'] === 'match_end') {
              ws.close(1000, 'match ended');
            }
          });

          ws.on('close', () => {
            resolve();
          });

          ws.on('error', (err: Error) => {
            reject(err);
          });
        });
      },
    );
}
