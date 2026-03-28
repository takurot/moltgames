import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

// Hoist module-level mocks so they're available before imports
const credentialsMock = vi.hoisted(() => ({
  saveCredentials: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  clearCredentials: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  loadCredentials: vi.fn(),
  isTokenExpired: vi.fn(),
}));

vi.mock('../../src/credentials.js', () => credentialsMock);

// Mock child_process exec for browser opening
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, cb: (err: Error | null) => void) => {
    cb(null);
  }),
}));

import { createLoginCommand, createLogoutCommand } from '../../src/commands/login.js';

// Helper to run a commander Command programmatically and capture exit calls
function runCommand(args: string[]): {
  exitCode: number | undefined;
  stdoutOutput: string;
  stderrOutput: string;
} {
  let exitCode: number | undefined;
  let stdoutOutput = '';
  let stderrOutput = '';

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutOutput += String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrOutput += String(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
    exitCode = typeof code === 'number' ? code : 0;
    throw new Error(`process.exit(${code})`);
  });

  return { exitCode, stdoutOutput, stderrOutput };
}

describe('createLoginCommand', () => {
  let fetchMock: MockInstance;
  let processExitMock: MockInstance;
  let stdoutMock: MockInstance;
  let stderrMock: MockInstance;
  let stdoutOutput: string;
  let stderrOutput: string;
  let capturedExitCode: number | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    stdoutOutput = '';
    stderrOutput = '';
    capturedExitCode = undefined;

    fetchMock = vi.spyOn(globalThis, 'fetch');
    processExitMock = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: number | string) => {
        capturedExitCode = typeof code === 'number' ? code : 0;
        throw new Error(`process.exit(${code})`);
      }) as unknown as MockInstance;

    stdoutMock = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += String(chunk);
      return true;
    });

    stderrMock = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += String(chunk);
      return true;
    });

    credentialsMock.saveCredentials.mockClear();
    credentialsMock.clearCredentials.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('completes successful login flow: device code issued, one pending poll, then success', async () => {
    const deviceAuthResponse = {
      device_code: 'dev-code-abc',
      user_code: 'USER-1234',
      verification_uri: 'https://moltgames.example.com/activate',
      expires_in: 300,
      interval: 1,
    };

    const tokenResponse = {
      id_token: 'id-token-xyz',
      refresh_token: 'refresh-token-xyz',
      expires_in: 3600,
      token_type: 'Bearer',
    };

    // First fetch call: POST /v1/auth/device
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => deviceAuthResponse,
    } as Response);

    // Second fetch call: POST /v1/auth/device/token → 428 AUTHORIZATION_PENDING
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 428,
      json: async () => ({
        code: 'AUTHORIZATION_PENDING',
        message: 'Authorization pending',
        retryable: true,
      }),
    } as Response);

    // Third fetch call: POST /v1/auth/device/token → 200 success
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => tokenResponse,
    } as Response);

    const cmd = createLoginCommand();

    // Run the action and advance timers to simulate polling interval
    const actionPromise = (async () => {
      try {
        await cmd.parseAsync(['node', 'moltgame', '--url', 'http://localhost:8080']);
      } catch (e) {
        // swallow process.exit throws
      }
    })();

    // Allow the first fetch (device code) and the first polling attempt to settle,
    // then advance time for the retry interval
    await vi.runAllTimersAsync();
    await actionPromise;

    // Verify device code was displayed to user
    expect(stderrOutput).toContain('USER-1234');
    expect(stderrOutput).toContain('https://moltgames.example.com/activate');

    // Verify credentials were saved
    expect(credentialsMock.saveCredentials).toHaveBeenCalledOnce();
    const savedCreds = credentialsMock.saveCredentials.mock.calls[0][0];
    expect(savedCreds.idToken).toBe('id-token-xyz');
    expect(savedCreds.refreshToken).toBe('refresh-token-xyz');
    expect(typeof savedCreds.expiresAt).toBe('number');
    expect(savedCreds.expiresAt).toBeGreaterThan(Date.now());

    // Verify success message
    expect(stderrOutput).toContain('Login successful');
  });

  it('outputs JSON on successful login with --json flag', async () => {
    const deviceAuthResponse = {
      device_code: 'dev-code-abc',
      user_code: 'USER-1234',
      verification_uri: 'https://moltgames.example.com/activate',
      expires_in: 300,
      interval: 1,
    };

    const tokenResponse = {
      id_token: 'id-token-xyz',
      refresh_token: 'refresh-token-xyz',
      expires_in: 3600,
      token_type: 'Bearer',
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => deviceAuthResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => tokenResponse,
      } as Response);

    const cmd = createLoginCommand();

    const actionPromise = (async () => {
      try {
        await cmd.parseAsync(['node', 'moltgame', '--url', 'http://localhost:8080', '--json']);
      } catch (e) {
        // swallow process.exit throws
      }
    })();

    await vi.runAllTimersAsync();
    await actionPromise;

    const parsed = JSON.parse(stdoutOutput) as { success: boolean; message: string };
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBe('Login successful');
  });

  it('fails with error when token expires during polling (410)', async () => {
    const deviceAuthResponse = {
      device_code: 'dev-code-abc',
      user_code: 'USER-1234',
      verification_uri: 'https://moltgames.example.com/activate',
      expires_in: 300,
      interval: 1,
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => deviceAuthResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 410,
        json: async () => ({
          code: 'EXPIRED_TOKEN',
          message: 'Device code expired',
        }),
      } as Response);

    const cmd = createLoginCommand();

    const actionPromise = (async () => {
      try {
        await cmd.parseAsync(['node', 'moltgame', '--url', 'http://localhost:8080']);
      } catch (e) {
        // swallow process.exit throws
      }
    })();

    await vi.runAllTimersAsync();
    await actionPromise;

    expect(capturedExitCode).toBe(1);
    expect(stderrOutput).toContain('expired');
    expect(credentialsMock.saveCredentials).not.toHaveBeenCalled();
  });

  it('outputs JSON error when token expires with --json flag', async () => {
    const deviceAuthResponse = {
      device_code: 'dev-code-abc',
      user_code: 'USER-1234',
      verification_uri: 'https://moltgames.example.com/activate',
      expires_in: 300,
      interval: 1,
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => deviceAuthResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 410,
        json: async () => ({
          code: 'EXPIRED_TOKEN',
          message: 'Device code expired',
        }),
      } as Response);

    const cmd = createLoginCommand();

    const actionPromise = (async () => {
      try {
        await cmd.parseAsync(['node', 'moltgame', '--url', 'http://localhost:8080', '--json']);
      } catch (e) {
        // swallow process.exit throws
      }
    })();

    await vi.runAllTimersAsync();
    await actionPromise;

    expect(capturedExitCode).toBe(1);
    const parsed = JSON.parse(stdoutOutput) as { success: boolean; error: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeTruthy();
  });

  it('fails with error on network error during device code request', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const cmd = createLoginCommand();

    try {
      await cmd.parseAsync(['node', 'moltgame', '--url', 'http://localhost:8080']);
    } catch (e) {
      // swallow process.exit throws
    }

    expect(capturedExitCode).toBe(1);
    expect(stderrOutput).toContain('Error');
    expect(credentialsMock.saveCredentials).not.toHaveBeenCalled();
  });

  it('fails with error on network error during polling', async () => {
    const deviceAuthResponse = {
      device_code: 'dev-code-abc',
      user_code: 'USER-1234',
      verification_uri: 'https://moltgames.example.com/activate',
      expires_in: 300,
      interval: 1,
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => deviceAuthResponse,
      } as Response)
      .mockRejectedValueOnce(new Error('Network error during polling'));

    const cmd = createLoginCommand();

    const actionPromise = (async () => {
      try {
        await cmd.parseAsync(['node', 'moltgame', '--url', 'http://localhost:8080']);
      } catch (e) {
        // swallow process.exit throws
      }
    })();

    await vi.runAllTimersAsync();
    await actionPromise;

    expect(capturedExitCode).toBe(1);
    expect(stderrOutput).toContain('Error');
    expect(credentialsMock.saveCredentials).not.toHaveBeenCalled();
  });
});

describe('createLogoutCommand', () => {
  let processExitMock: MockInstance;
  let stdoutOutput: string;
  let stderrOutput: string;
  let capturedExitCode: number | undefined;

  beforeEach(() => {
    stdoutOutput = '';
    stderrOutput = '';
    capturedExitCode = undefined;

    processExitMock = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: number | string) => {
        capturedExitCode = typeof code === 'number' ? code : 0;
        throw new Error(`process.exit(${code})`);
      }) as unknown as MockInstance;

    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += String(chunk);
      return true;
    });

    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += String(chunk);
      return true;
    });

    credentialsMock.clearCredentials.mockClear();
    credentialsMock.clearCredentials.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears credentials and prints "Logged out" message', async () => {
    const cmd = createLogoutCommand();

    try {
      await cmd.parseAsync(['node', 'moltgame']);
    } catch (e) {
      // swallow process.exit throws
    }

    expect(credentialsMock.clearCredentials).toHaveBeenCalledOnce();
    expect(stderrOutput).toContain('Logged out');
    expect(capturedExitCode).toBeUndefined();
  });

  it('outputs JSON when --json flag is passed', async () => {
    const cmd = createLogoutCommand();

    try {
      await cmd.parseAsync(['node', 'moltgame', '--json']);
    } catch (e) {
      // swallow process.exit throws
    }

    expect(credentialsMock.clearCredentials).toHaveBeenCalledOnce();

    const parsed = JSON.parse(stdoutOutput) as { success: boolean; message: string };
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBe('Logged out');
  });

  it('exits with code 1 and prints error if clearCredentials throws', async () => {
    credentialsMock.clearCredentials.mockRejectedValueOnce(new Error('Permission denied'));

    const cmd = createLogoutCommand();

    try {
      await cmd.parseAsync(['node', 'moltgame']);
    } catch (e) {
      // swallow process.exit throws
    }

    expect(capturedExitCode).toBe(1);
    expect(stderrOutput).toContain('Error');
  });
});
