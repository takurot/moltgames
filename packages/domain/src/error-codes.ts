export const COMMON_ERROR_CODES = [
  'VALIDATION_ERROR',
  'TURN_EXPIRED',
  'INVALID_REQUEST',
  'NOT_YOUR_TURN',
  'MATCH_ENDED',
  'SERVICE_UNAVAILABLE',
] as const;

export type CommonErrorCode = (typeof COMMON_ERROR_CODES)[number];

const commonErrorCodeSet: ReadonlySet<CommonErrorCode> = new Set(COMMON_ERROR_CODES);

export const RETRYABLE_COMMON_ERROR_CODES = ['VALIDATION_ERROR', 'SERVICE_UNAVAILABLE'] as const;

export type RetryableCommonErrorCode = (typeof RETRYABLE_COMMON_ERROR_CODES)[number];

const retryableCommonErrorCodeSet: ReadonlySet<RetryableCommonErrorCode> = new Set(
  RETRYABLE_COMMON_ERROR_CODES,
);

export interface CommonError {
  code: CommonErrorCode;
  message: string;
  retryable: boolean;
}

export const isCommonErrorCode = (value: unknown): value is CommonErrorCode =>
  typeof value === 'string' && commonErrorCodeSet.has(value as CommonErrorCode);

export const isRetryableCommonErrorCode = (value: unknown): value is RetryableCommonErrorCode =>
  typeof value === 'string' && retryableCommonErrorCodeSet.has(value as RetryableCommonErrorCode);
