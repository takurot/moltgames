const MAX_RETRY_DELAY_MS = 8_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseRetryAfterHeaderMs = (value: string): number | null => {
  const asSeconds = Number.parseInt(value, 10);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }

  const asTimestamp = Date.parse(value);
  if (Number.isFinite(asTimestamp)) {
    return Math.max(0, asTimestamp - Date.now());
  }

  return null;
};

const getRetryMessage = (data: unknown): string | null => {
  if (isRecord(data)) {
    if (typeof data.message === 'string') {
      return data.message;
    }

    if (isRecord(data.error) && typeof data.error.message === 'string') {
      return data.error.message;
    }
  }

  return null;
};

export const parseRetryDelayMs = (
  status: number,
  headers: Headers,
  data: unknown,
  attempt: number,
): number => {
  if (status === 429) {
    const retryAfterHeader = headers.get('retry-after');
    if (retryAfterHeader) {
      const retryAfterMs = parseRetryAfterHeaderMs(retryAfterHeader);
      if (retryAfterMs !== null) {
        return retryAfterMs;
      }
    }

    const retryMessage = getRetryMessage(data);
    if (retryMessage) {
      const match = retryMessage.match(/retry in (\d+)\s*seconds?/i);
      const secondsText = match?.[1];
      if (secondsText) {
        const asSeconds = Number.parseInt(secondsText, 10);
        if (Number.isFinite(asSeconds) && asSeconds >= 0) {
          return asSeconds * 1000;
        }
      }
    }
  }

  return Math.min(1_000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface RequestJsonWithRetryOptions {
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export const requestJsonWithRetry = async (
  options: RequestJsonWithRetryOptions,
): Promise<{ status: number; data: unknown }> => {
  const maxRetries = options.maxRetries ?? 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  let attempt = 0;

  for (;;) {
    const requestInit: RequestInit = {
      method: options.method,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    };
    if (options.body !== undefined) {
      requestInit.body = JSON.stringify(options.body);
    }

    const response = await fetchImpl(options.url, requestInit);

    const text = await response.text();
    let data: unknown = null;

    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (response.ok) {
      return {
        status: response.status,
        data,
      };
    }

    if (attempt < maxRetries) {
      const delayMs = parseRetryDelayMs(response.status, response.headers, data, attempt);
      attempt += 1;
      await sleep(delayMs);
      continue;
    }

    throw new Error(
      `HTTP ${response.status} ${options.method} ${options.url}: ${JSON.stringify(data)}`,
    );
  }
};
