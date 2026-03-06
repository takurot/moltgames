import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleJsonTraceLogger, sanitizeTraceValue } from '../../../src/logging/trace-logger.js';

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
    ).toBe('[REDACTED_TEXT]');
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
