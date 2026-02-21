import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EngineClient } from '../../../src/engine/client.js';

describe('EngineClient', () => {
  let client: EngineClient;
  let mockFetch: any;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    // Use smaller retry delay for tests
    client = new EngineClient({
      engineUrl: 'http://engine',
      retryAttempts: 2,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should execute post request successfully', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok' }),
    });

    const result = await client.post('/test', { data: 'test' });
    expect(result).toEqual({ status: 'ok' });
    expect(mockFetch).toHaveBeenCalledWith('http://engine/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'test' }),
    });
  });

  it('should retry on 5xx error', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) });

    const result = await client.post('/test', {});
    expect(result).toEqual({ status: 'ok' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should throw after max retries', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(client.post('/test', {})).rejects.toThrow('Engine error: 503');
    // Initial + 2 retries = 3 calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should throw on 4xx error without retry', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });

    await expect(client.post('/test', {})).rejects.toThrow('Engine error: 400');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should open circuit breaker after failures', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    // Each post call counts as 1 failure if all retries fail.
    // Threshold is 0.5, min 10 requests.

    for (let i = 0; i < 10; i++) {
      try {
        await client.post('/test', {});
      } catch {}
    }

    // Circuit should be open now.
    await expect(client.post('/test', {})).rejects.toThrow('Service Unavailable (Circuit Open)');
  });
});
