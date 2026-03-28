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
      const errorBody = (await response.json()) as {
        code?: string;
        message?: string;
        retryable?: boolean;
      };
      apiError = {
        code: errorBody.code ?? 'HTTP_ERROR',
        message: errorBody.message ?? `HTTP ${response.status}`,
        ...(errorBody.retryable !== undefined && { retryable: errorBody.retryable }),
      };
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
