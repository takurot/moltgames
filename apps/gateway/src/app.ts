import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Redis } from 'ioredis';

import {
  ConnectTokenService,
  createConnectTokenApi,
  InMemoryConnectTokenSessionStore,
  type FirebaseIdTokenVerifier,
  type VerifiedFirebaseIdToken,
} from './index.js';
import { loggerOptions } from './logger.js';
import { RedisConnectTokenSessionStore } from './auth/redis-store.js';
import { FirebaseAuthVerifier } from './auth/firebase-verifier.js';

class MockFirebaseVerifier implements FirebaseIdTokenVerifier {
  async verifyIdToken(_idToken: string): Promise<VerifiedFirebaseIdToken> {
    return {
      uid: 'test-user',
      providerId: 'google.com',
      customClaims: {},
    };
  }
}

export interface AppOptions {
  redis?: Redis;
  verifier?: FirebaseIdTokenVerifier;
}

export const createApp = async (options: AppOptions = {}) => {
  const app = Fastify({
    logger: loggerOptions,
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

  const redisUrl =
    process.env.REDIS_URL ||
    `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
  const redis =
    options.redis ||
    new Redis(redisUrl, {
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });

  // Health check
  app.get('/healthz', async () => {
    try {
      if (redis.status === 'ready' || redis.status === 'connect') {
        await redis.ping();
      } else {
        await redis.connect().catch(() => {});
        await redis.ping();
      }
      return { status: 'ok' };
    } catch (error) {
      app.log.error({ error }, 'Health check failed');
      return { status: 'error', details: 'redis connection failed' };
    }
  });

  let verifier = options.verifier;
  if (!verifier) {
    if (process.env.NODE_ENV === 'test' || process.env.MOCK_AUTH === 'true') {
      verifier = new MockFirebaseVerifier();
    } else {
      if (getApps().length === 0) {
        initializeApp();
      }
      verifier = new FirebaseAuthVerifier(getAuth());
    }
  }

  const store =
    process.env.NODE_ENV === 'test' && !options.redis
      ? new InMemoryConnectTokenSessionStore()
      : new RedisConnectTokenSessionStore(redis);

  const service = new ConnectTokenService({
    store,
    secret: process.env.CONNECT_TOKEN_SECRET || 'dev-secret',
  });

  const api = createConnectTokenApi({
    connectTokenService: service,
    idTokenVerifier: verifier,
  });

  // Adapter for ConnectTokenApi
  const handleConnectTokenRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const protocol = request.protocol;
    const host = request.hostname;
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
