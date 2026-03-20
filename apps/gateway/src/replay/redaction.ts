import { createHash } from 'node:crypto';
import type { JsonValue, RedactedTurnEvent, TurnEvent } from '@moltgames/domain';

export const REDACTION_VERSION = 'v1';
const REDACTION_PLACEHOLDER = '***REDACTED***';

// Fields to mask for the prompt-injection-arena game
const PROMPT_INJECTION_ARENA_SECRET_FIELDS = new Set(['secret', 'secretString']);
const PROMPT_INJECTION_ARENA_SECRET_VALUE_PATTERN = /SECRET-[A-Za-z]+-(?:-?\d+)/g;

const maskSecretFields = (value: JsonValue, fields: Set<string>): JsonValue => {
  if (typeof value === 'string') {
    return value.replace(PROMPT_INJECTION_ARENA_SECRET_VALUE_PATTERN, REDACTION_PLACEHOLDER);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskSecretFields(item, fields));
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, val] of Object.entries(value)) {
    if (fields.has(key)) {
      result[key] = REDACTION_PLACEHOLDER;
    } else {
      result[key] = maskSecretFields(val, fields);
    }
  }
  return result;
};

/**
 * Compute a deterministic SHA-256 hash of all TurnEvent fields (excluding eventHash itself).
 * The hash guarantees replay integrity and allows re-verification of disputed matches.
 */
const computeEventHash = (event: TurnEvent, isHiddenInfoRedacted: boolean): string => {
  const canonical = JSON.stringify({
    eventId: event.eventId,
    matchId: event.matchId,
    turn: event.turn,
    actor: event.actor,
    action: event.action,
    result: event.result,
    latencyMs: event.latencyMs,
    timestamp: event.timestamp,
    actionType: event.actionType,
    seat: event.seat,
    ruleVersion: event.ruleVersion,
    ...(event.phase !== undefined && { phase: event.phase }),
    ...(event.scoreDiffBefore !== undefined && { scoreDiffBefore: event.scoreDiffBefore }),
    ...(event.scoreDiffAfter !== undefined && { scoreDiffAfter: event.scoreDiffAfter }),
    isHiddenInfoRedacted,
    redactionVersion: REDACTION_VERSION,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
};

const enrichWithIntegrity = (
  event: TurnEvent,
  isHiddenInfoRedacted: boolean,
): RedactedTurnEvent => {
  const eventHash = computeEventHash(event, isHiddenInfoRedacted);
  return {
    ...event,
    isHiddenInfoRedacted,
    redactionVersion: REDACTION_VERSION,
    eventHash,
  };
};

const redactEvent = (event: TurnEvent, fields: Set<string>): TurnEvent => ({
  ...event,
  action: maskSecretFields(event.action, fields),
  result: maskSecretFields(event.result, fields),
});

export const applyRedaction = (
  events: readonly TurnEvent[],
  gameId: string,
): RedactedTurnEvent[] => {
  if (gameId === 'prompt-injection-arena') {
    return events.map((event) => {
      const redacted = redactEvent(event, PROMPT_INJECTION_ARENA_SECRET_FIELDS);
      return enrichWithIntegrity(redacted, true);
    });
  }

  // No content redaction for other games
  return events.map((event) => enrichWithIntegrity({ ...event }, false));
};
