import { describe, expect, it } from 'vitest';

import { maskSensitiveQueryParamsInUrl } from '../../src/logger.js';

describe('maskSensitiveQueryParamsInUrl', () => {
  it('masks connect_token while preserving other query params', () => {
    const url = '/v1/ws?connect_token=token-123&foo=bar';
    expect(maskSensitiveQueryParamsInUrl(url)).toBe('/v1/ws?foo=bar&connect_token=REDACTED');
  });

  it('masks both connect_token and session_id', () => {
    const url = '/v1/ws?session_id=session-1&connect_token=token-1';
    const masked = maskSensitiveQueryParamsInUrl(url);
    expect(masked).toContain('session_id=REDACTED');
    expect(masked).toContain('connect_token=REDACTED');
  });

  it('returns unchanged url when sensitive query params are absent', () => {
    const url = '/v1/ws?foo=bar';
    expect(maskSensitiveQueryParamsInUrl(url)).toBe(url);
  });

  it('supports absolute urls', () => {
    const url = 'https://example.com/v1/ws?connect_token=token-123';
    expect(maskSensitiveQueryParamsInUrl(url)).toBe(
      'https://example.com/v1/ws?connect_token=REDACTED',
    );
  });
});
