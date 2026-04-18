const API_KEY_PATTERN_SOURCE = String.raw`\b(?:sk-[\w-]+|AIza[\w-]+)\b`;
const EMAIL_PATTERN_SOURCE = String.raw`\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`;
const PHONE_PATTERN_SOURCE = String.raw`(?:\+?\d[\d()\s-]{7,}\d)`;
const SECRET_PATTERN_SOURCE = String.raw`\bSECRET-[\w-]+\b`;

const createPattern = (source: string, flags = ''): RegExp => new RegExp(source, flags);

const API_KEY_TEXT_PATTERN = createPattern(API_KEY_PATTERN_SOURCE, 'g');
const EMAIL_TEXT_PATTERN = createPattern(EMAIL_PATTERN_SOURCE, 'gi');
const PHONE_TEXT_PATTERN = createPattern(PHONE_PATTERN_SOURCE, 'g');
const SECRET_TEXT_PATTERN = createPattern(SECRET_PATTERN_SOURCE, 'g');

const TOKEN_KEY_PATTERN = /(?:authorization|token)/i;
const API_KEY_KEY_PATTERN = /api[_-]?key/i;
const SECRET_KEY_PATTERN = /(?:secret|guess)/i;
const REASONING_KEY_PATTERN = /(?:reasoning|thought|chain[_-]?of[_-]?thought|cot)/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export interface TraceLogEntry {
  event: string;
  requestId?: string | undefined;
  sessionId?: string | null | undefined;
  tool?: string | undefined;
  status?: string | undefined;
  latencyMs?: number | undefined;
  errorCode?: string | undefined;
  reconnectDelayMs?: number | undefined;
  args?: unknown;
  response?: unknown;
}

export interface TraceLogger {
  log(entry: TraceLogEntry): void;
}

export interface ConsoleJsonTraceLoggerOptions {
  agentId?: string | undefined;
  matchId?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
}

const sanitizeString = (value: string, keyName?: string): string => {
  if (keyName && REASONING_KEY_PATTERN.test(keyName)) {
    return '[OMITTED_REASONING]';
  }

  if (keyName && API_KEY_KEY_PATTERN.test(keyName)) {
    return '[REDACTED_API_KEY]';
  }

  if (keyName && TOKEN_KEY_PATTERN.test(keyName)) {
    return '[REDACTED_TOKEN]';
  }

  if (keyName && SECRET_KEY_PATTERN.test(keyName)) {
    return '[REDACTED_SECRET]';
  }

  let sanitized = value;
  sanitized = sanitized.replace(API_KEY_TEXT_PATTERN, '[REDACTED_API_KEY]');
  sanitized = sanitized.replace(SECRET_TEXT_PATTERN, '[REDACTED_SECRET]');
  sanitized = sanitized.replace(EMAIL_TEXT_PATTERN, '[REDACTED_TEXT]');
  sanitized = sanitized.replace(PHONE_TEXT_PATTERN, '[REDACTED_TEXT]');

  return sanitized;
};

export const sanitizeTraceValue = (value: unknown, keyName?: string): unknown => {
  if (typeof value === 'string') {
    return sanitizeString(value, keyName);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceValue(item, keyName));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeTraceValue(entryValue, entryKey),
      ]),
    );
  }

  return value;
};

const summarizeTraceValue = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return value.length <= 180 ? value : `${value.slice(0, 180)}...`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (depth >= 2) {
    if (Array.isArray(value)) {
      return `[array:${value.length}]`;
    }

    if (isRecord(value)) {
      return '[object]';
    }

    return String(value);
  }

  if (Array.isArray(value)) {
    const summarized = value.slice(0, 4).map((item) => summarizeTraceValue(item, depth + 1));
    if (value.length > 4) {
      summarized.push(`...(${value.length - 4} more)`);
    }
    return summarized;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value).slice(0, 8);
    const next: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of entries) {
      next[entryKey] = summarizeTraceValue(entryValue, depth + 1);
    }
    if (Object.keys(value).length > 8) {
      next._truncatedKeys = Object.keys(value).length - 8;
    }
    return next;
  }

  return String(value);
};

export const summarizeAndSanitizeTraceValue = (value: unknown): unknown =>
  sanitizeTraceValue(summarizeTraceValue(value));

export class ConsoleJsonTraceLogger implements TraceLogger {
  constructor(private readonly options: ConsoleJsonTraceLoggerOptions = {}) {}

  log(entry: TraceLogEntry): void {
    const payload = sanitizeTraceValue({
      timestamp: new Date().toISOString(),
      level: 'info',
      ...this.options,
      ...entry,
    });

    console.log(JSON.stringify(payload));
  }
}
