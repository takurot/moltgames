import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConsoleJsonTraceLogger,
  sanitizeTraceValue,
  summarizeAndSanitizeTraceValue,
} from '../../../src/logging/trace-logger.js';

describe('sanitizeTraceValue', () => {
  it('masks tokens, api keys, secrets, and reasoning-like fields', () => {
    expect(
      sanitizeTraceValue({
        connect_token: 'connect-token-123',
        apiKey: 'sk-test-123456',
        secret: 'SECRET-apple-0',
        guess: 'banana',
        reasoning: 'internal chain of thought',
        nested: {
          authorization: 'Bearer sk-test-654321',
        },
      }),
    ).toEqual({
      connect_token: '[REDACTED_TOKEN]',
      apiKey: '[REDACTED_API_KEY]',
      secret: '[REDACTED_SECRET]',
      guess: '[REDACTED_SECRET]',
      reasoning: '[OMITTED_REASONING]',
      nested: {
        authorization: '[REDACTED_TOKEN]',
      },
    });
  });

  it('masks email addresses and phone numbers embedded in strings', () => {
    expect(
      sanitizeTraceValue('contact test@example.com or +1 (555) 123-4567 with sk-test-secret'),
    ).toBe('contact [REDACTED_TEXT] or [REDACTED_TEXT] with [REDACTED_API_KEY]');
  });

  it('redacts embedded secrets and api keys inside free-form text', () => {
    expect(
      sanitizeTraceValue({
        content: 'Use SECRET-apple-0 with sk-test-123456 and email test@example.com',
        note: 'Previous guess SECRET-banana-1 was rejected.',
      }),
    ).toEqual({
      content: 'Use [REDACTED_SECRET] with [REDACTED_API_KEY] and email [REDACTED_TEXT]',
      note: 'Previous guess [REDACTED_SECRET] was rejected.',
    });
  });
});

describe('summarizeAndSanitizeTraceValue', () => {
  it('preserves compact summaries while masking bench-style secret guesses', () => {
    expect(
      summarizeAndSanitizeTraceValue({
        guess: 'SECRET-benchmark-probe-42',
        result: {
          accepted: true,
          echoed: 'SECRET-benchmark-probe-42',
        },
      }),
    ).toEqual({
      guess: '[REDACTED_SECRET]',
      result: {
        accepted: true,
        echoed: '[REDACTED_SECRET]',
      },
    });
  });

  it('sanitizes api keys that remain after long-string truncation', () => {
    const longPrefix = 'x'.repeat(160);
    const result = summarizeAndSanitizeTraceValue(`${longPrefix} sk-test-key-abc`);

    expect(result).toEqual(`${longPrefix} [REDACTED_API_KEY]`);
  });

  it('uses _truncatedKeys metadata when summarizing large objects', () => {
    expect(
      summarizeAndSanitizeTraceValue({
        first: 1,
        second: 2,
        third: 3,
        fourth: 4,
        fifth: 5,
        sixth: 6,
        seventh: 7,
        eighth: 8,
        ninth: 9,
      }),
    ).toEqual({
      first: 1,
      second: 2,
      third: 3,
      fourth: 4,
      fifth: 5,
      sixth: 6,
      seventh: 7,
      eighth: 8,
      _truncatedKeys: 1,
    });
  });
});

describe('ConsoleJsonTraceLogger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a structured json log line with sanitized fields', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new ConsoleJsonTraceLogger({
      agentId: 'agent-1',
      provider: 'openai',
      model: 'gpt-4.1-mini',
    });

    logger.log({
      event: 'action.sent',
      requestId: 'req-1',
      sessionId: 'session-1',
      tool: 'check_secret',
      args: { guess: 'SECRET-apple-0' },
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(consoleSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      event: 'action.sent',
      agentId: 'agent-1',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      requestId: 'req-1',
      args: { guess: '[REDACTED_SECRET]' },
    });
  });
});
