import { exec } from 'child_process';
import { Command } from 'commander';
import { saveCredentials, clearCredentials } from '../credentials.js';
import { HttpError } from '../http-client.js';
import { printError, printInfo, printJson } from '../output.js';
import type { DeviceAuthResponse, TokenResponse } from '../types.js';

/** Open the given URL in the system browser based on the current platform. */
function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;

  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (_err) => {
    // Ignore errors — browser opening is best-effort
  });
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST to the gateway and return parsed JSON, throwing HttpError on non-2xx responses. */
async function post<T>(baseUrl: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const init: RequestInit = {
    method: 'POST',
    headers,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, init);

  if (!response.ok) {
    let code = 'HTTP_ERROR';
    let message = `HTTP ${response.status}`;
    let retryable: boolean | undefined;

    try {
      const errorBody = (await response.json()) as {
        code?: string;
        message?: string;
        retryable?: boolean;
      };
      code = errorBody.code ?? code;
      message = errorBody.message ?? message;
      retryable = errorBody.retryable;
    } catch {
      // ignore JSON parse errors — use defaults
    }

    throw new HttpError(response.status, {
      code,
      message,
      ...(retryable !== undefined ? { retryable } : {}),
    });
  }

  return response.json() as Promise<T>;
}

export function createLoginCommand(): Command {
  return new Command('login')
    .description('Authenticate via Device Authorization Flow')
    .option('--url <url>', 'Gateway URL', 'http://localhost:8080')
    .option('--json', 'Output result as JSON')
    .action(async (options: { url: string; json?: boolean }) => {
      const { url, json } = options;

      try {
        // Step 1: Request a device code
        const deviceAuth = await post<DeviceAuthResponse>(url, '/v1/auth/device');

        // Step 2: Display the user code and verification URI
        printInfo(`\nTo authenticate, visit: ${deviceAuth.verification_uri}`);
        printInfo(`Enter code: ${deviceAuth.user_code}\n`);

        // Step 3: Attempt to open the browser
        openBrowser(deviceAuth.verification_uri);

        // Step 4: Poll for the token
        const intervalMs = deviceAuth.interval * 1000;

        while (true) {
          await sleep(intervalMs);

          let tokenResponse: TokenResponse;

          try {
            tokenResponse = await post<TokenResponse>(url, '/v1/auth/device/token', {
              device_code: deviceAuth.device_code,
            });
          } catch (err) {
            if (err instanceof HttpError) {
              if (err.statusCode === 428) {
                // AUTHORIZATION_PENDING — keep polling
                continue;
              }

              if (err.statusCode === 410) {
                // EXPIRED_TOKEN
                const errMessage = err.message || 'Device code has expired. Please try again.';
                if (json) {
                  printJson({ success: false, error: errMessage });
                } else {
                  printError(`Login failed: ${errMessage}`);
                }
                process.exit(1);
              }
            }

            // Unexpected error
            const errMessage = err instanceof Error ? err.message : String(err);
            if (json) {
              printJson({ success: false, error: errMessage });
            } else {
              printError(errMessage);
            }
            process.exit(1);
          }

          // Step 5: Save credentials
          const expiresAt = Date.now() + tokenResponse.expires_in * 1000;
          await saveCredentials({
            idToken: tokenResponse.id_token,
            refreshToken: tokenResponse.refresh_token,
            expiresAt,
          });

          if (json) {
            printJson({ success: true, message: 'Login successful' });
          } else {
            printInfo('Login successful');
          }

          return;
        }
      } catch (err) {
        // Rethrow process.exit errors (thrown by mocks in tests)
        if (err instanceof Error && err.message.startsWith('process.exit(')) {
          throw err;
        }

        const errMessage = err instanceof Error ? err.message : String(err);
        if (json) {
          printJson({ success: false, error: errMessage });
        } else {
          printError(errMessage);
        }
        process.exit(1);
      }
    });
}

export function createLogoutCommand(): Command {
  return new Command('logout')
    .description('Clear stored credentials')
    .option('--json', 'Output result as JSON')
    .action(async (options: { json?: boolean }) => {
      const { json } = options;

      try {
        await clearCredentials();

        if (json) {
          printJson({ success: true, message: 'Logged out' });
        } else {
          printInfo('Logged out');
        }
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        if (json) {
          printJson({ success: false, error: errMessage });
        } else {
          printError(errMessage);
        }
        process.exit(1);
      }
    });
}
