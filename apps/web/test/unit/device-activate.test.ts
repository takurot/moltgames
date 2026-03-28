import { describe, it, expect, vi, beforeEach } from 'vitest';
import { activateDevice } from '@/lib/device-activate';

describe('activateDevice', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success when gateway responds 204', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 204 }));

    const result = await activateDevice({
      userCode: 'ABCD-1234',
      idToken: 'test-id-token',
      refreshToken: 'test-refresh-token',
      expiresIn: 3600,
      gatewayUrl: 'http://localhost:8080',
    });

    expect(result.success).toBe(true);
  });

  it('sends POST to /v1/auth/device/activate with correct headers and body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal('fetch', mockFetch);

    await activateDevice({
      userCode: 'ABCD-1234',
      idToken: 'test-id-token',
      refreshToken: 'test-refresh-token',
      expiresIn: 3600,
      gatewayUrl: 'http://localhost:8080',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/v1/auth/device/activate');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-id-token');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      userCode: 'ABCD-1234',
      refreshToken: 'test-refresh-token',
      expiresIn: 3600,
    });
  });

  it('returns NOT_FOUND error on 404 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 404,
        json: async () => ({ code: 'NOT_FOUND', message: 'Session not found', retryable: false }),
      }),
    );

    const result = await activateDevice({
      userCode: 'XXXX-9999',
      idToken: 'token',
      refreshToken: 'refresh',
      expiresIn: 3600,
      gatewayUrl: 'http://localhost:8080',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.retryable).toBe(false);
    }
  });

  it('returns EXPIRED_TOKEN error on 410 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 410,
        json: async () => ({ code: 'EXPIRED_TOKEN', message: 'Expired', retryable: false }),
      }),
    );

    const result = await activateDevice({
      userCode: 'ABCD-1234',
      idToken: 'token',
      refreshToken: 'refresh',
      expiresIn: 3600,
      gatewayUrl: 'http://localhost:8080',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('EXPIRED_TOKEN');
    }
  });

  it('returns retryable error when gateway responds 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 503,
        json: async () => ({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service unavailable',
          retryable: true,
        }),
      }),
    );

    const result = await activateDevice({
      userCode: 'ABCD-1234',
      idToken: 'token',
      refreshToken: 'refresh',
      expiresIn: 3600,
      gatewayUrl: 'http://localhost:8080',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.retryable).toBe(true);
    }
  });

  it('returns ALREADY_CONSUMED error on 400 AUTHORIZATION_ALREADY_CONSUMED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 400,
        json: async () => ({
          code: 'AUTHORIZATION_ALREADY_CONSUMED',
          message: 'Already consumed',
          retryable: false,
        }),
      }),
    );

    const result = await activateDevice({
      userCode: 'ABCD-1234',
      idToken: 'token',
      refreshToken: 'refresh',
      expiresIn: 3600,
      gatewayUrl: 'http://localhost:8080',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('AUTHORIZATION_ALREADY_CONSUMED');
    }
  });
});
