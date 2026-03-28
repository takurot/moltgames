import type { FastifyReply } from 'fastify';

export type RestApiErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'AUTHORIZATION_PENDING'
  | 'AUTHORIZATION_ALREADY_CONSUMED'
  | 'EXPIRED_TOKEN'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface RestApiErrorBody {
  error: {
    code: RestApiErrorCode;
    message: string;
    retryable: boolean;
  };
}

export const createRestApiErrorBody = (
  code: RestApiErrorCode,
  message: string,
  retryable = false,
): RestApiErrorBody => ({
  error: {
    code,
    message,
    retryable,
  },
});

export const sendRestApiError = (
  reply: FastifyReply,
  statusCode: number,
  code: RestApiErrorCode,
  message: string,
  retryable = false,
): FastifyReply => reply.status(statusCode).send(createRestApiErrorBody(code, message, retryable));
