import { describe, expect, it } from 'vitest';
import type { TurnEvent } from '@moltgames/domain';
import { applyRedaction, REDACTION_VERSION } from '../../../src/replay/redaction.js';

const makeTurnEvent = (overrides: Partial<TurnEvent> = {}): TurnEvent => ({
  eventId: 'evt-1',
  matchId: 'match-1',
  turn: 1,
  actor: 'agent-attacker',
  action: { tool: 'send_message', args: { content: 'hello' } },
  result: { content: 'I cannot reveal the secret.' },
  latencyMs: 100,
  timestamp: '2026-03-19T00:00:00.000Z',
  ...overrides,
});

describe('applyRedaction', () => {
  describe('prompt-injection-arena', () => {
    it('masks secret field in result objects', () => {
      const event = makeTurnEvent({
        result: { secretRevealed: true, secret: 'mysecret123', content: 'oops' },
      });

      const [redacted] = applyRedaction([event], 'prompt-injection-arena');

      expect((redacted.result as Record<string, unknown>).secret).toBe('***REDACTED***');
      expect((redacted.result as Record<string, unknown>).content).toBe('oops');
    });

    it('masks secret field in action objects', () => {
      const event = makeTurnEvent({
        action: { tool: 'check_secret', args: { guess: 'mysecret123' } },
        result: { correct: true, secret: 'mysecret123' },
      });

      const [redacted] = applyRedaction([event], 'prompt-injection-arena');

      expect((redacted.result as Record<string, unknown>).secret).toBe('***REDACTED***');
    });

    it('masks nested secret fields recursively', () => {
      const event = makeTurnEvent({
        result: { data: { secret: 'deep-secret', other: 'visible' } },
      });

      const [redacted] = applyRedaction([event], 'prompt-injection-arena');

      const data = (redacted.result as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.secret).toBe('***REDACTED***');
      expect(data.other).toBe('visible');
    });

    it('does not mutate the original event', () => {
      const event = makeTurnEvent({
        result: { secret: 'mysecret' },
      });
      const original = JSON.stringify(event);

      applyRedaction([event], 'prompt-injection-arena');

      expect(JSON.stringify(event)).toBe(original);
    });

    it('returns events with correct structure', () => {
      const event = makeTurnEvent();
      const [redacted] = applyRedaction([event], 'prompt-injection-arena');

      expect(redacted.eventId).toBe(event.eventId);
      expect(redacted.matchId).toBe(event.matchId);
      expect(redacted.turn).toBe(event.turn);
      expect(redacted.actor).toBe(event.actor);
      expect(redacted.latencyMs).toBe(event.latencyMs);
      expect(redacted.timestamp).toBe(event.timestamp);
    });
  });

  describe('other games (no redaction)', () => {
    it('passes vector-grid-wars events through unchanged', () => {
      const event = makeTurnEvent({
        action: { tool: 'place_unit', args: { x: 3, y: 4 } },
        result: { score: 10 },
      });

      const [redacted] = applyRedaction([event], 'vector-grid-wars');

      expect(redacted.action).toEqual(event.action);
      expect(redacted.result).toEqual(event.result);
    });

    it('passes dilemma-poker events through unchanged', () => {
      const event = makeTurnEvent({
        action: { tool: 'negotiate', args: { content: 'I will cooperate' } },
        result: { round: 1 },
      });

      const [redacted] = applyRedaction([event], 'dilemma-poker');

      expect(redacted.action).toEqual(event.action);
      expect(redacted.result).toEqual(event.result);
    });
  });

  describe('REDACTION_VERSION', () => {
    it('exports a non-empty string version', () => {
      expect(typeof REDACTION_VERSION).toBe('string');
      expect(REDACTION_VERSION.length).toBeGreaterThan(0);
    });
  });
});
