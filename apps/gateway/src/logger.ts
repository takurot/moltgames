import pino from 'pino';

const redactPaths = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.query.connect_token',
  'req.body.token',
  'req.body.password',
  'req.body.email',
  'connectToken',
  '*.connectToken',
  'connect_token',
  '*.connect_token',
  'secret',
  '*.secret',
];

const SENSITIVE_QUERY_PARAMS = ['connect_token', 'session_id'] as const;
const SENSITIVE_QUERY_REPLACEMENT = 'REDACTED';

const hasAbsoluteUrlPrefix = (url: string): boolean =>
  url.startsWith('http://') || url.startsWith('https://');

export const maskSensitiveQueryParamsInUrl = (url: string): string => {
  if (!url.includes('?')) {
    return url;
  }

  try {
    const parsedUrl = new URL(url, 'http://localhost');
    let changed = false;

    for (const param of SENSITIVE_QUERY_PARAMS) {
      const values = parsedUrl.searchParams.getAll(param);
      if (values.length === 0) {
        continue;
      }

      parsedUrl.searchParams.delete(param);
      for (let index = 0; index < values.length; index += 1) {
        parsedUrl.searchParams.append(param, SENSITIVE_QUERY_REPLACEMENT);
      }
      changed = true;
    }

    if (!changed) {
      return url;
    }

    const suffix = `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
    if (hasAbsoluteUrlPrefix(url)) {
      return `${parsedUrl.protocol}//${parsedUrl.host}${suffix}`;
    }

    return suffix;
  } catch {
    return url;
  }
};

const reqSerializer = pino.stdSerializers.wrapRequestSerializer((request) => {
  if (typeof request.url !== 'string') {
    return request;
  }

  return {
    ...request,
    url: maskSensitiveQueryParamsInUrl(request.url),
  };
});

export const loggerOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  serializers: {
    req: reqSerializer,
  },
  ...(process.env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        },
      }
    : {
        formatters: {
          level: (label: string) => {
            return { severity: label.toUpperCase() };
          },
        },
        messageKey: 'message',
        timestamp: pino.stdTimeFunctions.isoTime,
      }),
};

export const logger = pino(loggerOptions);

export type Logger = typeof logger;
