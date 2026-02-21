import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

import {
  ConnectTokenService,
  createConnectTokenApi,
  InMemoryConnectTokenSessionStore,
  type FirebaseIdTokenVerifier,
  type VerifiedFirebaseIdToken,
} from './index.js';

class MockFirebaseVerifier implements FirebaseIdTokenVerifier {
  async verifyIdToken(_idToken: string): Promise<VerifiedFirebaseIdToken> {
    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      return {
        uid: 'test-user',
        providerId: 'google.com', // or github.com
        customClaims: {},
      };
    }
    throw new Error('Not implemented');
  }
}

export const createApp = async () => {
  const logger = {
    level: process.env.LOG_LEVEL || 'info',
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
      : {}),
  };

  const app = Fastify({
    logger,
    trustProxy: true,
  });

  // Middleware
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['https://moltgame.com'];

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || /localhost/.test(origin) || allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error('Not allowed'), false);
    },
  });

  await app.register(rateLimit, {
    max: 5,
    timeWindow: 10000,
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      if (auth && auth.startsWith('Bearer ')) {
        return auth.substring(7);
      }
      return req.ip;
    },
  });

  // Health check
  app.get('/healthz', async () => {
    return { status: 'ok' };
  });

  // Connect Token API Setup
  const store = new InMemoryConnectTokenSessionStore();
  const service = new ConnectTokenService({
    store,
    secret: process.env.CONNECT_TOKEN_SECRET || 'dev-secret',
  });

  // TODO: Use real Firebase implementation in production
  const verifier = new MockFirebaseVerifier();

  const api = createConnectTokenApi({
    connectTokenService: service,
    idTokenVerifier: verifier,
  });

  // Adapter for ConnectTokenApi
  const handleConnectTokenRequest: RouteHandlerMethod = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const protocol = request.protocol;
    const host = request.hostname;
    // Fastify request.url is relative path
    const url = new URL(`${protocol}://${host}${request.url}`);

    const headers = new Headers();
    Object.entries(request.headers).forEach(([key, value]) => {
      if (typeof value === 'string') {
        headers.set(key, value);
      } else if (Array.isArray(value)) {
        value.forEach((v) => headers.append(key, v));
      }
    });

    const webRequestInit: RequestInit = {
      method: request.method,
      headers,
    };

    if (request.body && (request.method === 'POST' || request.method === 'PUT')) {
      webRequestInit.body = JSON.stringify(request.body);
    }

    const webRequest = new Request(url, webRequestInit);
    const response = await api.handle(webRequest);

    reply.status(response.status);
    response.headers.forEach((value, key) => {
      reply.header(key, value);
    });

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  app.post('/v1/tokens', handleConnectTokenRequest);
  app.delete('/v1/tokens/:tokenId', handleConnectTokenRequest);

  return app;
};
