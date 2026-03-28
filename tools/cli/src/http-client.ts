import type { ApiError } from './types.js';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly apiError: ApiError,
  ) {
    super(apiError.message);
    this.name = 'HttpError';
  }

  get retryable(): boolean {
    return this.apiError.retryable ?? false;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseApiError = (payload: unknown, statusCode: number, statusText: string): ApiError => {
  const candidate = isRecord(payload) && isRecord(payload.error) ? payload.error : payload;

  if (!isRecord(candidate)) {
    return {
      code: 'HTTP_ERROR',
      message: `HTTP ${statusCode}: ${statusText}`,
    };
  }

  const code = typeof candidate.code === 'string' ? candidate.code : 'HTTP_ERROR';
  const message =
    typeof candidate.message === 'string' ? candidate.message : `HTTP ${statusCode}: ${statusText}`;
  const retryable = typeof candidate.retryable === 'boolean' ? candidate.retryable : undefined;

  return {
    code,
    message,
    ...(retryable === undefined ? {} : { retryable }),
  };
};

export async function apiRequest<T>(
  baseUrl: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, token, headers: extraHeaders = {} } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = `${baseUrl}${path}`;
  const fetchInit: RequestInit = { method, headers };
  if (body !== undefined) {
    fetchInit.body = JSON.stringify(body);
  }
  const response = await fetch(url, fetchInit);

  if (!response.ok) {
    let apiError: ApiError;
    try {
      apiError = parseApiError(await response.json(), response.status, response.statusText);
    } catch {
      apiError = {
        code: 'HTTP_ERROR',
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    throw new HttpError(response.status, apiError);
  }

  if (response.status === 204) {
    return undefined as unknown as T;
  }

  return response.json() as Promise<T>;
}
