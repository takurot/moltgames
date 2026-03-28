import { Command } from 'commander';
import type { Leaderboard, Match } from '../types.js';
import { loadCredentials, isTokenExpired } from '../credentials.js';
import { apiRequest, HttpError } from '../http-client.js';
import { printJson, printTable, printError, printInfo } from '../output.js';

function getErrorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

// =========================================
// leaderboard command
// =========================================

export function createLeaderboardCommand(): Command {
  const cmd = new Command('leaderboard');

  cmd
    .description('Show the leaderboard for a season')
    .option('--season <id>', 'Season ID', 'current')
    .option('--limit <n>', 'Max entries', '10')
    .option('--url <url>', 'Gateway URL', 'http://localhost:8080')
    .option('--json', 'Output as JSON')
    .action(async (options: { season: string; limit: string; url: string; json?: boolean }) => {
      const { season, url, json: jsonOutput } = options;
      const limit = parsePositiveInteger(options.limit, 'limit');

      printInfo(`Fetching leaderboard for season "${season}"...`);

      try {
        const response = await apiRequest<{ status: string; leaderboard: Leaderboard }>(
          url,
          `/v1/leaderboards/${season}`,
        );

        const leaderboard = {
          ...response.leaderboard,
          entries: response.leaderboard.entries.slice(0, limit),
        };

        if (jsonOutput) {
          printJson(leaderboard);
          return;
        }

        const rows = leaderboard.entries.map((entry) => ({
          rank: entry.rank,
          agentId: entry.agentId ?? '',
          uid: entry.uid,
          elo: entry.elo,
          matches: entry.matches,
          winRate: entry.winRate,
        }));

        printTable(rows as Array<Record<string, unknown>>, [
          'rank',
          'agentId',
          'uid',
          'elo',
          'matches',
          'winRate',
        ]);
      } catch (error: unknown) {
        printError(getErrorMessage(error));
        process.exit(1);
      }
    });

  return cmd;
}

// =========================================
// history command
// =========================================

export function createHistoryCommand(): Command {
  const cmd = new Command('history');

  cmd
    .description('Show your match history')
    .option('--limit <n>', 'Max results', '20')
    .option('--cursor <token>', 'Pagination cursor')
    .option('--agent <id>', 'Filter by agentId')
    .option('--url <url>', 'Gateway URL', 'http://localhost:8080')
    .option('--json', 'Output as JSON')
    .action(
      async (options: {
        limit: string;
        cursor?: string;
        agent?: string;
        url: string;
        json?: boolean;
      }) => {
        const { limit, cursor, agent, url, json: jsonOutput } = options;
        const limitValue = parsePositiveInteger(limit, 'limit');

        const creds = await loadCredentials();
        if (creds === null) {
          printError('Not logged in. Please run `moltgame login` first.');
          process.exit(1);
          return;
        }

        if (isTokenExpired(creds)) {
          printError('Session expired. Please run `moltgame login` to refresh.');
          process.exit(1);
          return;
        }

        const params = new URLSearchParams();
        params.set('limit', String(limitValue));
        if (cursor !== undefined) {
          params.set('cursor', cursor);
        }
        if (agent !== undefined) {
          params.set('agentId', agent);
        }

        printInfo('Fetching match history...');

        try {
          const response = await apiRequest<{ items: Match[]; nextCursor: string | null }>(
            url,
            `/v1/matches?${params.toString()}`,
            { token: creds.idToken },
          );

          const matches = response.items;
          const nextCursor = response.nextCursor;

          if (jsonOutput) {
            printJson({ matches, nextCursor });
          } else {
            const rows = matches.map((m) => ({
              matchId: m.matchId,
              gameId: m.gameId,
              status: m.status,
              startedAt: m.startedAt ?? '',
              endedAt: m.endedAt ?? '',
              participants: m.participants.map((p) => p.agentId).join(', '),
            }));

            printTable(rows as Array<Record<string, unknown>>, [
              'matchId',
              'gameId',
              'status',
              'startedAt',
              'endedAt',
              'participants',
            ]);
          }

          if (nextCursor !== null) {
            printInfo(`Next page cursor: ${nextCursor}`);
            printInfo(`  Use: --cursor ${nextCursor}`);
          }
        } catch (error: unknown) {
          const message =
            error instanceof HttpError
              ? error.message
              : error instanceof Error
                ? error.message
                : 'Unknown error';
          printError(message);
          process.exit(1);
        }
      },
    );

  return cmd;
}

// =========================================
// replay command
// =========================================

export function createReplayCommand(): Command {
  const cmd = new Command('replay');
  cmd.description('Manage match replays');

  const fetchCmd = new Command('fetch');
  fetchCmd
    .description('Get the signed download URL for a match replay')
    .argument('<matchId>', 'Match ID')
    .option('--url <url>', 'Gateway URL', 'http://localhost:8080')
    .option('--json', 'Output as JSON')
    .action(async (matchId: string, options: { url: string; json?: boolean }) => {
      const { url, json: jsonOutput } = options;

      printInfo(`Fetching replay URL for match "${matchId}"...`);

      try {
        const response = await apiRequest<{ status: string; url: string }>(
          url,
          `/v1/replays/${matchId}`,
        );

        const signedUrl = response.url;

        if (jsonOutput) {
          printJson({ url: signedUrl });
          return;
        }

        process.stdout.write(`${signedUrl}\n`);
        printInfo(`\nTo download the replay, run:`);
        printInfo(`  curl -L "${signedUrl}" -o replay-${matchId}.jsonl`);
        printInfo(`  # or: wget "${signedUrl}" -O replay-${matchId}.jsonl`);
      } catch (error: unknown) {
        printError(getErrorMessage(error));
        process.exit(1);
      }
    });

  cmd.addCommand(fetchCmd);
  return cmd;
}
