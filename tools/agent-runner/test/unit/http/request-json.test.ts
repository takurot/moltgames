import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRetryDelayMs, requestJsonWithRetry } from '../../../src/http/request-json.js';

describe('parseRetryDelayMs', () => {
  it('prefers Retry-After header seconds for 429 responses', () => {
    const headers = new Headers({ 'retry-after': '3' });

    expect(parseRetryDelayMs(429, headers, null, 0)).toBe(3000);
  });

  it('falls back to exponential backoff when Retry-After is unavailable', () => {
    expect(parseRetryDelayMs(503, new Headers(), null, 0)).toBe(1000);
    expect(parseRetryDelayMs(503, new Headers(), null, 3)).toBe(8000);
  });
});

describe('requestJsonWithRetry', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('retries 429 responses and eventually returns the parsed json payload', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'retry in 1 seconds' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ connectToken: 'token-123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    globalThis.fetch = fetchMock;

    const requestPromise = requestJsonWithRetry({
      url: 'http://localhost:8080/v1/tokens',
      method: 'POST',
      body: { matchId: 'match-1', agentId: 'agent-1' },
      maxRetries: 1,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await expect(requestPromise).resolves.toEqual({
      status: 200,
      data: { connectToken: 'token-123' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
