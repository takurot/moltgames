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
  actionLatencyMs: 100,
  timestamp: '2026-03-19T00:00:00.000Z',
  actionType: 'send_message',
  seat: 'first',
  ruleVersion: '1.1.0',
  phase: 'dialogue',
  scoreDiffBefore: 0,
  scoreDiffAfter: 0,
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

    it('masks secret values embedded in strings', () => {
      const event = makeTurnEvent({
        action: { tool: 'check_secret', args: { guess: 'SECRET-apple-7' } },
        result: { content: 'The leaked secret is SECRET-apple-7' },
      });

      const [redacted] = applyRedaction([event], 'prompt-injection-arena');

      expect(redacted.action).toEqual({
        tool: 'check_secret',
        args: { guess: '***REDACTED***' },
      });
      expect(redacted.result).toEqual({
        content: 'The leaked secret is ***REDACTED***',
      });
    });

    it('masks negative-seed secret values embedded in strings', () => {
      const event = makeTurnEvent({
        result: { content: 'SECRET-banana--5 should never appear' },
      });

      const [redacted] = applyRedaction([event], 'prompt-injection-arena');

      expect(redacted.result).toEqual({ content: '***REDACTED*** should never appear' });
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
      expect(redacted.actionLatencyMs).toBe(event.actionLatencyMs);
      expect(redacted.timestamp).toBe(event.timestamp);
    });

    it('adds isHiddenInfoRedacted=true for prompt-injection-arena', () => {
      const event = makeTurnEvent();
      const [redacted] = applyRedaction([event], 'prompt-injection-arena');

      expect(redacted.isHiddenInfoRedacted).toBe(true);
      expect(redacted.redactionVersion).toBe(REDACTION_VERSION);
      expect(typeof redacted.eventHash).toBe('string');
      expect(redacted.eventHash.length).toBe(64); // SHA-256 hex
    });

    it('produces a deterministic eventHash for the same input', () => {
      const event = makeTurnEvent();
      const [r1] = applyRedaction([event], 'prompt-injection-arena');
      const [r2] = applyRedaction([event], 'prompt-injection-arena');

      expect(r1.eventHash).toBe(r2.eventHash);
    });

    it('produces the same eventHash for semantically identical nested JSON with different key order', () => {
      const [left] = applyRedaction(
        [
          makeTurnEvent({
            action: {
              tool: 'check_secret',
              args: { guess: 'SECRET-Alpha-42', nested: { a: 1, b: 2 } },
            },
            result: { nested: { z: 1, a: 2 }, verdict: 'miss' },
          }),
        ],
        'prompt-injection-arena',
      );
      const [right] = applyRedaction(
        [
          makeTurnEvent({
            action: {
              tool: 'check_secret',
              args: { nested: { b: 2, a: 1 }, guess: 'SECRET-Alpha-42' },
            },
            result: { verdict: 'miss', nested: { a: 2, z: 1 } },
          }),
        ],
        'prompt-injection-arena',
      );

      expect(left.eventHash).toBe(right.eventHash);
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

    it('adds isHiddenInfoRedacted=false for non-redacting games', () => {
      const event = makeTurnEvent();
      const [redacted] = applyRedaction([event], 'vector-grid-wars');

      expect(redacted.isHiddenInfoRedacted).toBe(false);
      expect(redacted.redactionVersion).toBe(REDACTION_VERSION);
      expect(typeof redacted.eventHash).toBe('string');
      expect(redacted.eventHash.length).toBe(64);
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

    it('produces different hashes for redacted vs unredacted events', () => {
      const event = makeTurnEvent({ result: { secret: 'TOP-SECRET', content: 'hello' } });
      const [redactedEvent] = applyRedaction([event], 'prompt-injection-arena');
      const [plainEvent] = applyRedaction([event], 'vector-grid-wars');

      // Different content AND different isHiddenInfoRedacted → different hashes
      expect(redactedEvent.eventHash).not.toBe(plainEvent.eventHash);
    });
  });

  describe('analytics fields preservation', () => {
    it('preserves actionType, seat, and ruleVersion through redaction', () => {
      const event = makeTurnEvent({
        actionType: 'check_secret',
        seat: 'second',
        ruleVersion: '2.0.0',
      });
      const [redacted] = applyRedaction([event], 'prompt-injection-arena');

      expect(redacted.actionType).toBe('check_secret');
      expect(redacted.seat).toBe('second');
      expect(redacted.ruleVersion).toBe('2.0.0');
    });

    it('preserves optional fields when present', () => {
      const event = makeTurnEvent({ phase: 'attack', scoreDiffBefore: 10, scoreDiffAfter: -5 });
      const [redacted] = applyRedaction([event], 'vector-grid-wars');

      expect(redacted.phase).toBe('attack');
      expect(redacted.scoreDiffBefore).toBe(10);
      expect(redacted.scoreDiffAfter).toBe(-5);
    });
  });

  describe('REDACTION_VERSION', () => {
    it('exports a non-empty string version', () => {
      expect(typeof REDACTION_VERSION).toBe('string');
      expect(REDACTION_VERSION.length).toBeGreaterThan(0);
    });
  });
});
