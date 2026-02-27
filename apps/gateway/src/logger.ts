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

export const loggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
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
