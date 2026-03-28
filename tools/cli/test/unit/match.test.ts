import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type { Credentials } from '../../src/types.js';

// Hoisted mock state for controlling test behavior
const mockState = vi.hoisted(() => ({
  credentials: null as Credentials | null,
  fetchResponses: [] as Array<{ ok: boolean; status: number; json: unknown }>,
  exitCode: null as number | null,
  stdoutOutput: [] as string[],
  stderrOutput: [] as string[],
}));

vi.mock('../../src/credentials.js', () => ({
  loadCredentials: vi.fn(async () => mockState.credentials),
}));

vi.mock('../../src/output.js', () => ({
  printJson: vi.fn((data: unknown) => {
    mockState.stdoutOutput.push(JSON.stringify(data, null, 2));
  }),
  printTable: vi.fn(),
  printError: vi.fn((msg: string) => {
    mockState.stderrOutput.push(`Error: ${msg}`);
  }),
  printInfo: vi.fn((msg: string) => {
    mockState.stderrOutput.push(msg);
  }),
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock process.exit to prevent actual exit
const mockExit = vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
  mockState.exitCode = typeof code === 'number' ? code : 0;
  throw new Error(`process.exit(${code})`);
});

import { createMatchCommand, createQueueCommand } from '../../src/commands/match.js';

const makeCredentials = (): Credentials => ({
  idToken: 'test-id-token',
  refreshToken: 'test-refresh-token',
  expiresAt: Date.now() + 3_600_000,
});

const makeFetchResponse = (status: number, body: unknown): Response => {
  const jsonFn = vi.fn().mockResolvedValue(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : String(status),
    json: jsonFn,
  } as unknown as Response;
};

const runCommand = async (command: Command, args: string[]): Promise<void> => {
  try {
    await command.parseAsync(['node', 'moltgame', ...args]);
  } catch (err: unknown) {
    // Swallow process.exit errors only
    if (err instanceof Error && err.message.startsWith('process.exit(')) {
      return;
    }
    throw err;
  }
};

describe('createMatchCommand', () => {
  beforeEach(() => {
    mockState.credentials = null;
    mockState.exitCode = null;
    mockState.stdoutOutput = [];
    mockState.stderrOutput = [];
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('match start subcommand', () => {
    it('displays connect token on success', async () => {
      mockState.credentials = makeCredentials();
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse(201, {
          tokenId: 'token-id-123',
          connectToken: 'abc.def',
          issuedAt: 1000,
          expiresAt: 1300,
        }),
      );

      const cmd = createMatchCommand();
      await runCommand(cmd, ['start', '--match', 'match-123', '--agent', 'agent-456']);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:8080/v1/tokens');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        matchId: 'match-123',
        agentId: 'agent-456',
      });
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer test-id-token',
      });

      const infoOutput = mockState.stderrOutput.join('\n');
      expect(infoOutput).toContain('abc.def');
      expect(mockState.exitCode).toBeNull();
    });

    it('outputs JSON when --json flag is used', async () => {
      mockState.credentials = makeCredentials();
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse(201, {
          tokenId: 'token-id-123',
          connectToken: 'abc.def',
          issuedAt: 1000,
          expiresAt: 1300,
        }),
      );

      const cmd = createMatchCommand();
      await runCommand(cmd, ['start', '--match', 'match-123', '--agent', 'agent-456', '--json']);

      expect(mockState.stdoutOutput.length).toBeGreaterThan(0);
      const parsed = JSON.parse(mockState.stdoutOutput[0]) as { connectToken: string };
      expect(parsed.connectToken).toBe('abc.def');
    });

    it('exits with code 1 when credentials are not found', async () => {
      mockState.credentials = null;

      const cmd = createMatchCommand();
      await runCommand(cmd, ['start', '--match', 'match-123', '--agent', 'agent-456']);

      expect(mockState.exitCode).toBe(1);
      const errOutput = mockState.stderrOutput.join('\n');
      expect(errOutput).toMatch(/not logged in|credentials|login/i);
    });

    it('exits with code 1 on API error', async () => {
      mockState.credentials = makeCredentials();
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse(401, { code: 'UNAUTHORIZED', message: 'Invalid token' }),
      );

      const cmd = createMatchCommand();
      await runCommand(cmd, ['start', '--match', 'match-123', '--agent', 'agent-456']);

      expect(mockState.exitCode).toBe(1);
      const errOutput = mockState.stderrOutput.join('\n');
      expect(errOutput).toMatch(/unauthorized|invalid token/i);
    });

    it('uses custom --url when provided', async () => {
      mockState.credentials = makeCredentials();
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse(201, {
          tokenId: 'tid',
          connectToken: 'x.y',
          issuedAt: 1000,
          expiresAt: 1300,
        }),
      );

      const cmd = createMatchCommand();
      await runCommand(cmd, [
        'start',
        '--match',
        'match-123',
        '--agent',
        'agent-456',
        '--url',
        'http://gateway.example.com:9090',
      ]);

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://gateway.example.com:9090/v1/tokens');
    });
  });

  describe('match status subcommand', () => {
    it('displays match info on success', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse(200, {
          status: 'ok',
          match: {
            matchId: 'match-abc',
            gameId: 'game-1',
            status: 'IN_PROGRESS',
            participants: [
              { uid: 'user-1', agentId: 'agent-1', role: 'player' },
              { uid: 'user-2', agentId: 'agent-2', role: 'player' },
            ],
            createdAt: '2024-01-01T00:00:00Z',
          },
        }),
      );

      const cmd = createMatchCommand();
      await runCommand(cmd, ['status', 'match-abc']);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:8080/v1/matches/match-abc');
      expect(mockState.exitCode).toBeNull();
      const infoOutput = mockState.stderrOutput.join('\n');
      expect(infoOutput).toContain('match-abc');
    });

    it('outputs JSON when --json flag is used', async () => {
      const matchData = {
        matchId: 'match-abc',
        gameId: 'game-1',
        status: 'IN_PROGRESS',
        participants: [],
        createdAt: '2024-01-01T00:00:00Z',
      };
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse(200, { status: 'ok', match: matchData }),
      );

      const cmd = createMatchCommand();
      await runCommand(cmd, ['status', 'match-abc', '--json']);

      expect(mockState.stdoutOutput.length).toBeGreaterThan(0);
      const parsed = JSON.parse(mockState.stdoutOutput[0]) as { matchId: string };
      expect(parsed.matchId).toBe('match-abc');
    });

    it('exits with code 1 when match not found', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse(404, { status: 'error', message: 'Match not found' }),
      );

      const cmd = createMatchCommand();
      await runCommand(cmd, ['status', 'nonexistent-match']);

      expect(mockState.exitCode).toBe(1);
      const errOutput = mockState.stderrOutput.join('\n');
      expect(errOutput).toMatch(/not found|404/i);
    });
  });
});

describe('createQueueCommand', () => {
  beforeEach(() => {
    mockState.credentials = null;
    mockState.exitCode = null;
    mockState.stdoutOutput = [];
    mockState.stderrOutput = [];
    mockFetch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('enters queue, polls, and displays matchId when matched', async () => {
    mockState.credentials = makeCredentials();

    // POST /v1/matches/queue - enqueue response
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(202, { status: 'QUEUED', gameId: 'game-1', agentId: 'agent-1', queuedAt: '2024-01-01T00:00:00Z' }),
    );
    // GET /v1/matches/queue/status - waiting
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(200, { status: 'QUEUED', gameId: 'game-1', agentId: 'agent-1', queuedAt: '2024-01-01T00:00:00Z' }),
    );
    // GET /v1/matches/queue/status - matched
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(200, {
        status: 'MATCHED',
        gameId: 'game-1',
        agentId: 'agent-1',
        queuedAt: '2024-01-01T00:00:00Z',
        matchId: 'match-xyz',
        matchedAt: '2024-01-01T00:00:10Z',
      }),
    );

    const cmd = createQueueCommand();
    const parsePromise = runCommand(cmd, ['--game', 'game-1', '--agent', 'agent-1']);

    // Advance timer to trigger polling
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    await parsePromise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [enqueueUrl, enqueueInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(enqueueUrl).toBe('http://localhost:8080/v1/matches/queue');
    expect(enqueueInit.method).toBe('POST');
    expect(JSON.parse(enqueueInit.body as string)).toMatchObject({
      gameId: 'game-1',
      agentId: 'agent-1',
    });

    const infoOutput = mockState.stderrOutput.join('\n');
    expect(infoOutput).toContain('match-xyz');
    expect(mockState.exitCode).toBeNull();
  });

  it('outputs JSON when --json flag is used and matched', async () => {
    mockState.credentials = makeCredentials();

    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(202, { status: 'QUEUED', gameId: 'game-1', agentId: 'agent-1', queuedAt: '2024-01-01T00:00:00Z' }),
    );
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(200, {
        status: 'MATCHED',
        gameId: 'game-1',
        agentId: 'agent-1',
        queuedAt: '2024-01-01T00:00:00Z',
        matchId: 'match-xyz',
        matchedAt: '2024-01-01T00:00:10Z',
      }),
    );

    const cmd = createQueueCommand();
    const parsePromise = runCommand(cmd, ['--game', 'game-1', '--json']);

    await vi.advanceTimersByTimeAsync(3000);
    await parsePromise;

    expect(mockState.stdoutOutput.length).toBeGreaterThan(0);
    const parsed = JSON.parse(mockState.stdoutOutput[0]) as { matchId: string };
    expect(parsed.matchId).toBe('match-xyz');
  });

  it('exits with code 1 when credentials are not found', async () => {
    mockState.credentials = null;

    const cmd = createQueueCommand();
    await runCommand(cmd, ['--game', 'game-1']);

    expect(mockState.exitCode).toBe(1);
    const errOutput = mockState.stderrOutput.join('\n');
    expect(errOutput).toMatch(/not logged in|credentials|login/i);
  });

  it('exits with code 1 on enqueue API error', async () => {
    mockState.credentials = makeCredentials();
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(429, { code: 'RATE_LIMITED', message: 'Queue rate limit exceeded' }),
    );

    const cmd = createQueueCommand();
    await runCommand(cmd, ['--game', 'game-1']);

    expect(mockState.exitCode).toBe(1);
    const errOutput = mockState.stderrOutput.join('\n');
    expect(errOutput).toMatch(/rate.limit|queue/i);
  });
});
