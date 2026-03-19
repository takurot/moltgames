import type { JsonValue, TurnEvent } from '@moltgames/domain';

export const REDACTION_VERSION = 'v1';
const REDACTION_PLACEHOLDER = '***REDACTED***';

// Fields to mask for the prompt-injection-arena game
const PROMPT_INJECTION_ARENA_SECRET_FIELDS = new Set(['secret', 'secretString']);

const maskSecretFields = (value: JsonValue, fields: Set<string>): JsonValue => {
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

const redactEvent = (event: TurnEvent, fields: Set<string>): TurnEvent => ({
  ...event,
  action: maskSecretFields(event.action, fields),
  result: maskSecretFields(event.result, fields),
});

export const applyRedaction = (events: readonly TurnEvent[], gameId: string): TurnEvent[] => {
  if (gameId === 'prompt-injection-arena') {
    return events.map((event) => redactEvent(event, PROMPT_INJECTION_ARENA_SECRET_FIELDS));
  }

  // No redaction for other games
  return events.map((event) => ({ ...event }));
};
