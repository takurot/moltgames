import { Command } from 'commander';
import { loadCredentials } from '../credentials.js';
import { apiRequest, HttpError } from '../http-client.js';
import { printJson, printError, printInfo } from '../output.js';
import type { Match } from '../types.js';

const DEFAULT_URL = 'http://localhost:8080';

interface IssueConnectTokenResult {
  tokenId: string;
  connectToken: string;
  issuedAt: number;
  expiresAt: number;
}

interface MatchStatusResponse {
  status: 'ok' | 'error';
  match: Match;
}

interface MatchQueueStatus {
  status: string;
  gameId: string;
  agentId: string;
  queuedAt: string;
  matchId?: string;
  matchedAt?: string;
}

/**
 * Creates the `moltgame match` command with `start` and `status` subcommands.
 */
export function createMatchCommand(): Command {
  const matchCmd = new Command('match').description('Manage matches');

  matchCmd
    .command('start')
    .description('Issue a connect token for an existing match')
    .requiredOption('--match <matchId>', 'Match ID')
    .requiredOption('--agent <agentId>', 'Agent ID')
    .option('--url <url>', 'Gateway URL', DEFAULT_URL)
    .option('--json', 'Output as JSON')
    .action(async (options: { match: string; agent: string; url: string; json?: boolean }) => {
      const creds = await loadCredentials();
      if (creds === null) {
        printError('Not logged in. Run `moltgame login` first.');
        process.exit(1);
      }

      try {
        const result = await apiRequest<IssueConnectTokenResult>(options.url, '/v1/tokens', {
          method: 'POST',
          body: { matchId: options.match, agentId: options.agent },
          token: creds.idToken,
        });

        if (options.json) {
          printJson({ connectToken: result.connectToken, tokenId: result.tokenId });
        } else {
          printInfo(`Connect token: ${result.connectToken}`);
          printInfo(`Token ID:      ${result.tokenId}`);
          printInfo(`Expires at:    ${new Date(result.expiresAt * 1000).toISOString()}`);
        }
      } catch (err: unknown) {
        if (err instanceof HttpError) {
          printError(`${err.apiError.code}: ${err.message}`);
        } else if (err instanceof Error) {
          printError(err.message);
        } else {
          printError('An unexpected error occurred');
        }
        process.exit(1);
      }
    });

  matchCmd
    .command('status <matchId>')
    .description('Get the status of a match')
    .option('--url <url>', 'Gateway URL', DEFAULT_URL)
    .option('--json', 'Output as JSON')
    .action(async (matchId: string, options: { url: string; json?: boolean }) => {
      try {
        const response = await apiRequest<MatchStatusResponse>(
          options.url,
          `/v1/matches/${matchId}`,
        );

        if (options.json) {
          printJson(response.match);
        } else {
          const { match } = response;
          printInfo(`Match ID:     ${match.matchId}`);
          printInfo(`Game ID:      ${match.gameId}`);
          printInfo(`Status:       ${match.status}`);
          printInfo(`Rule:         ${match.ruleId}@${match.ruleVersion}`);
          printInfo(`Region:       ${match.region}`);
          if (match.startedAt !== undefined) {
            printInfo(`Started at:   ${match.startedAt}`);
          }
          if (match.endedAt !== undefined) {
            printInfo(`Ended at:     ${match.endedAt}`);
          }
          if (match.participants.length > 0) {
            printInfo('Participants:');
            for (const p of match.participants) {
              printInfo(`  - uid=${p.uid}  agentId=${p.agentId}  role=${p.role}`);
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof HttpError) {
          if (err.statusCode === 404) {
            printError(`Match not found: ${matchId}`);
          } else {
            printError(`${err.apiError.code}: ${err.message}`);
          }
        } else if (err instanceof Error) {
          printError(err.message);
        } else {
          printError('An unexpected error occurred');
        }
        process.exit(1);
      }
    });

  return matchCmd;
}

/**
 * Creates the `moltgame queue` command.
 * Joins the matchmaking queue and polls until matched or the user cancels.
 */
export function createQueueCommand(): Command {
  const queueCmd = new Command('queue')
    .description('Join the matchmaking queue and wait for a match')
    .requiredOption('--game <gameId>', 'Game ID')
    .requiredOption('--agent <id>', 'Agent ID')
    .option('--url <url>', 'Gateway URL', DEFAULT_URL)
    .option('--json', 'Output as JSON');

  queueCmd.action(async (options: { game: string; agent: string; url: string; json?: boolean }) => {
    const creds = await loadCredentials();
    if (creds === null) {
      printError('Not logged in. Run `moltgame login` first.');
      process.exit(1);
    }

    // Register SIGINT handler to leave queue on Ctrl+C
    let leaving = false;
    const handleSignal = async (): Promise<void> => {
      if (leaving) return;
      leaving = true;
      printInfo('Leaving queue...');
      try {
        await apiRequest<void>(
          options.url,
          `/v1/matches/queue?gameId=${encodeURIComponent(options.game)}`,
          { method: 'DELETE', token: creds.idToken },
        );
      } catch {
        // Best-effort cleanup
      }
      process.exit(0);
    };
    const sigintListener = (): void => {
      void handleSignal();
    };
    process.once('SIGINT', sigintListener);

    try {
      // Enqueue
      const enqueueBody = { gameId: options.game, agentId: options.agent };

      await apiRequest<MatchQueueStatus>(options.url, '/v1/matches/queue', {
        method: 'POST',
        body: enqueueBody,
        token: creds.idToken,
      });

      printInfo(`Joined queue for game "${options.game}". Waiting for a match...`);

      // Poll until matched
      const matched = await pollQueueStatus(options.url, options.game, creds.idToken);

      if (options.json) {
        printJson({ matchId: matched.matchId, matchedAt: matched.matchedAt });
      } else {
        printInfo(`Matched! Match ID: ${matched.matchId}`);
        if (matched.matchedAt !== undefined) {
          printInfo(`Matched at: ${matched.matchedAt}`);
        }
      }
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        printError(`${err.apiError.code}: ${err.message}`);
      } else if (err instanceof Error) {
        printError(err.message);
      } else {
        printError('An unexpected error occurred');
      }
      process.exit(1);
    } finally {
      process.off('SIGINT', sigintListener);
    }
  });

  return queueCmd;
}

async function pollQueueStatus(
  baseUrl: string,
  gameId: string,
  token: string,
): Promise<MatchQueueStatus & { matchId: string }> {
  const POLL_INTERVAL_MS = 3000;

  return new Promise((resolve, reject) => {
    const poll = async (): Promise<void> => {
      try {
        const status = await apiRequest<MatchQueueStatus>(
          baseUrl,
          `/v1/matches/queue/status?gameId=${encodeURIComponent(gameId)}`,
          { token },
        );

        if (status.status === 'MATCHED' && status.matchId !== undefined) {
          resolve(status as MatchQueueStatus & { matchId: string });
        } else {
          setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      } catch (err: unknown) {
        reject(err);
      }
    };

    setTimeout(() => void poll(), POLL_INTERVAL_MS);
  });
}
