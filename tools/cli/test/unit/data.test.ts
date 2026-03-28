import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import {
  createLeaderboardCommand,
  createHistoryCommand,
  createReplayCommand,
} from '../../src/commands/data.js';

// --- Mock credentials module ---
vi.mock('../../src/credentials.js', () => ({
  loadCredentials: vi.fn(),
  isTokenExpired: vi.fn(),
}));

import { loadCredentials, isTokenExpired } from '../../src/credentials.js';

const mockLoadCredentials = vi.mocked(loadCredentials);
const mockIsTokenExpired = vi.mocked(isTokenExpired);

// --- Capture output ---
let stdoutOutput: string[] = [];
let stderrOutput: string[] = [];
let consoleOutput: string[] = [];

beforeEach(() => {
  stdoutOutput = [];
  stderrOutput = [];
  consoleOutput = [];

  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutOutput.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrOutput.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(' '));
  });

  vi.restoreAllMocks();
  vi.resetAllMocks();

  // Re-spy after restoreAllMocks
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutOutput.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrOutput.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(' '));
  });
});

// Helper to run a command and capture process.exit
async function runCommand(cmd: Command, args: string[]): Promise<void> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error(`process.exit called with args: ${JSON.stringify(args)}`);
  });
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    exitSpy.mockRestore();
  }
}

async function runCommandExpectExit(cmd: Command, args: string[]): Promise<number> {
  let exitCode = -1;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
    exitCode = Number(code ?? 0);
    throw new Error('process.exit');
  });
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } catch {
    // expected
  } finally {
    exitSpy.mockRestore();
  }
  return exitCode;
}

// =========================================
// leaderboard command
// =========================================
describe('createLeaderboardCommand', () => {
  it('returns a Command instance', () => {
    const cmd = createLeaderboardCommand();
    expect(cmd).toBeInstanceOf(Command);
    expect(cmd.name()).toBe('leaderboard');
  });

  it('fetches leaderboard and prints table by default', async () => {
    const mockLeaderboard = {
      seasonId: 'season-1',
      entries: [
        { rank: 1, agentId: 'agent-a', uid: 'user-1', rating: 1500, wins: 10, losses: 2 },
        { rank: 2, agentId: 'agent-b', uid: 'user-2', rating: 1400, wins: 8, losses: 4 },
      ],
      updatedAt: '2024-01-01T00:00:00Z',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', leaderboard: mockLeaderboard }),
    });

    const cmd = createLeaderboardCommand();
    await runCommand(cmd, ['--season', 'season-1', '--url', 'http://localhost:8080']);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/leaderboards/season-1',
      expect.objectContaining({ method: 'GET' }),
    );
    const output = consoleOutput.join('\n');
    expect(output).toContain('rank');
    expect(output).toContain('agentId');
    expect(output).toContain('agent-a');
    expect(output).toContain('1500');
  });

  it('outputs JSON when --json flag is set', async () => {
    const mockLeaderboard = {
      seasonId: 'current',
      entries: [{ rank: 1, agentId: 'agent-x', uid: 'user-x', rating: 1600, wins: 5, losses: 1 }],
      updatedAt: '2024-01-01T00:00:00Z',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', leaderboard: mockLeaderboard }),
    });

    const cmd = createLeaderboardCommand();
    await runCommand(cmd, ['--json', '--url', 'http://localhost:8080']);

    const stdout = stdoutOutput.join('');
    const parsed = JSON.parse(stdout) as unknown;
    expect(parsed).toEqual(mockLeaderboard);
  });

  it('uses default season "current" and limit 10 when no options given', async () => {
    const mockLeaderboard = {
      seasonId: 'current',
      entries: [],
      updatedAt: '2024-01-01T00:00:00Z',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', leaderboard: mockLeaderboard }),
    });

    const cmd = createLeaderboardCommand();
    await runCommand(cmd, ['--url', 'http://localhost:8080']);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/leaderboards/current',
      expect.any(Object),
    );
  });

  it('exits with code 1 when leaderboard not found (404)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ code: 'NOT_FOUND', message: 'Leaderboard not found' }),
    });

    const cmd = createLeaderboardCommand();
    const exitCode = await runCommandExpectExit(cmd, [
      '--season',
      'nonexistent',
      '--url',
      'http://localhost:8080',
    ]);

    expect(exitCode).toBe(1);
    const stderr = stderrOutput.join('');
    expect(stderr).toContain('Error:');
  });

  it('exits with code 1 on network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

    const cmd = createLeaderboardCommand();
    const exitCode = await runCommandExpectExit(cmd, ['--url', 'http://localhost:8080']);

    expect(exitCode).toBe(1);
    const stderr = stderrOutput.join('');
    expect(stderr).toContain('Error:');
  });
});

// =========================================
// history command
// =========================================
describe('createHistoryCommand', () => {
  it('returns a Command instance', () => {
    const cmd = createHistoryCommand();
    expect(cmd).toBeInstanceOf(Command);
    expect(cmd.name()).toBe('history');
  });

  it('fetches match history with auth and prints table', async () => {
    const mockMatches = [
      {
        matchId: 'match-1',
        gameId: 'game-a',
        status: 'completed',
        createdAt: '2024-01-01T00:00:00Z',
        participants: [
          { uid: 'user-1', agentId: 'agent-a', role: 'player' },
          { uid: 'user-2', agentId: 'agent-b', role: 'player' },
        ],
      },
    ];

    mockLoadCredentials.mockResolvedValue({
      idToken: 'test-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
    });
    mockIsTokenExpired.mockReturnValue(false);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ matches: mockMatches }),
    });

    const cmd = createHistoryCommand();
    await runCommand(cmd, ['--url', 'http://localhost:8080']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/matches'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
    const output = consoleOutput.join('\n');
    expect(output).toContain('matchId');
    expect(output).toContain('match-1');
  });

  it('outputs JSON when --json flag is set', async () => {
    const mockMatches = [
      {
        matchId: 'match-2',
        gameId: 'game-b',
        status: 'active',
        createdAt: '2024-01-02T00:00:00Z',
        participants: [],
      },
    ];

    mockLoadCredentials.mockResolvedValue({
      idToken: 'test-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
    });
    mockIsTokenExpired.mockReturnValue(false);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ matches: mockMatches }),
    });

    const cmd = createHistoryCommand();
    await runCommand(cmd, ['--json', '--url', 'http://localhost:8080']);

    const stdout = stdoutOutput.join('');
    const parsed = JSON.parse(stdout) as unknown;
    expect(parsed).toEqual(mockMatches);
  });

  it('prints nextCursor hint to stderr when present', async () => {
    mockLoadCredentials.mockResolvedValue({
      idToken: 'test-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
    });
    mockIsTokenExpired.mockReturnValue(false);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ matches: [], nextCursor: 'cursor-abc' }),
    });

    const cmd = createHistoryCommand();
    await runCommand(cmd, ['--url', 'http://localhost:8080']);

    const stderr = stderrOutput.join('');
    expect(stderr).toContain('cursor-abc');
  });

  it('passes agentId filter when --agent is provided', async () => {
    mockLoadCredentials.mockResolvedValue({
      idToken: 'test-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
    });
    mockIsTokenExpired.mockReturnValue(false);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ matches: [] }),
    });

    const cmd = createHistoryCommand();
    await runCommand(cmd, ['--agent', 'my-agent', '--url', 'http://localhost:8080']);

    const fetchCall = vi.mocked(global.fetch).mock.calls[0];
    expect(fetchCall?.[0]).toContain('agentId=my-agent');
  });

  it('exits with code 1 when credentials are not available', async () => {
    mockLoadCredentials.mockResolvedValue(null);

    const cmd = createHistoryCommand();
    const exitCode = await runCommandExpectExit(cmd, ['--url', 'http://localhost:8080']);

    expect(exitCode).toBe(1);
    const stderr = stderrOutput.join('');
    expect(stderr).toContain('Error:');
  });

  it('exits with code 1 when token is expired', async () => {
    mockLoadCredentials.mockResolvedValue({
      idToken: 'expired-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 1000,
    });
    mockIsTokenExpired.mockReturnValue(true);

    const cmd = createHistoryCommand();
    const exitCode = await runCommandExpectExit(cmd, ['--url', 'http://localhost:8080']);

    expect(exitCode).toBe(1);
    const stderr = stderrOutput.join('');
    expect(stderr).toContain('Error:');
  });

  it('exits with code 1 on HTTP error', async () => {
    mockLoadCredentials.mockResolvedValue({
      idToken: 'test-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
    });
    mockIsTokenExpired.mockReturnValue(false);

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: 'UNAUTHORIZED', message: 'Unauthorized' }),
    });

    const cmd = createHistoryCommand();
    const exitCode = await runCommandExpectExit(cmd, ['--url', 'http://localhost:8080']);

    expect(exitCode).toBe(1);
  });

  it('passes limit query parameter', async () => {
    mockLoadCredentials.mockResolvedValue({
      idToken: 'test-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
    });
    mockIsTokenExpired.mockReturnValue(false);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ matches: [] }),
    });

    const cmd = createHistoryCommand();
    await runCommand(cmd, ['--limit', '5', '--url', 'http://localhost:8080']);

    const fetchCall = vi.mocked(global.fetch).mock.calls[0];
    expect(fetchCall?.[0]).toContain('limit=5');
  });
});

// =========================================
// replay command
// =========================================
describe('createReplayCommand', () => {
  it('returns a Command instance with fetch subcommand', () => {
    const cmd = createReplayCommand();
    expect(cmd).toBeInstanceOf(Command);
    expect(cmd.name()).toBe('replay');
    const sub = cmd.commands.find((c) => c.name() === 'fetch');
    expect(sub).toBeDefined();
  });

  it('prints signed URL to stdout on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', url: 'https://storage.example.com/replay-123.jsonl' }),
    });

    const cmd = createReplayCommand();
    await runCommand(cmd, ['fetch', 'match-123', '--url', 'http://localhost:8080']);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/replays/match-123',
      expect.objectContaining({ method: 'GET' }),
    );
    const stdout = stdoutOutput.join('');
    expect(stdout).toContain('https://storage.example.com/replay-123.jsonl');
  });

  it('outputs JSON with url field when --json flag is set', async () => {
    const signedUrl = 'https://storage.example.com/replay-456.jsonl';

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', url: signedUrl }),
    });

    const cmd = createReplayCommand();
    await runCommand(cmd, ['fetch', 'match-456', '--json', '--url', 'http://localhost:8080']);

    const stdout = stdoutOutput.join('');
    const parsed = JSON.parse(stdout) as unknown;
    expect(parsed).toEqual({ url: signedUrl });
  });

  it('prints download hint to stderr on success without --json', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        url: 'https://storage.example.com/replay-789.jsonl',
      }),
    });

    const cmd = createReplayCommand();
    await runCommand(cmd, ['fetch', 'match-789', '--url', 'http://localhost:8080']);

    const stderr = stderrOutput.join('');
    expect(stderr).toMatch(/curl|wget|download/i);
  });

  it('exits with code 1 when replay not found (404)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ code: 'NOT_FOUND', message: 'Replay not found' }),
    });

    const cmd = createReplayCommand();
    const exitCode = await runCommandExpectExit(cmd, [
      'fetch',
      'nonexistent-match',
      '--url',
      'http://localhost:8080',
    ]);

    expect(exitCode).toBe(1);
    const stderr = stderrOutput.join('');
    expect(stderr).toContain('Error:');
  });

  it('exits with code 1 on network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

    const cmd = createReplayCommand();
    const exitCode = await runCommandExpectExit(cmd, [
      'fetch',
      'match-err',
      '--url',
      'http://localhost:8080',
    ]);

    expect(exitCode).toBe(1);
    const stderr = stderrOutput.join('');
    expect(stderr).toContain('Error:');
  });
});
