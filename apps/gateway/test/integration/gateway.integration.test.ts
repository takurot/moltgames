import { type FastifyInstance } from 'fastify';
import { type Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';

describe('Gateway Integration Tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp({ redis: new RedisMock() as unknown as Redis });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /healthz returns 200 OK', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('CORS: Allows whitelisted origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: {
        origin: 'https://moltgame.com',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://moltgame.com');
  });

  it('CORS: Allows configured origin', async () => {
    process.env.ALLOWED_ORIGINS = 'https://custom-domain.com';
    const app2 = await createApp({ redis: new RedisMock() as unknown as Redis });
    await app2.ready();

    const response = await app2.inject({
      method: 'GET',
      url: '/healthz',
      headers: {
        origin: 'https://custom-domain.com',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://custom-domain.com');

    await app2.close();
    delete process.env.ALLOWED_ORIGINS;
  });

  it('CORS: Blocks unknown origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: {
        origin: 'https://evil.com',
      },
    });

    // Fastify CORS default behavior for error is usually 500 if callback returns error
    expect(response.statusCode).toBe(500);
  });

  it('Rate Limit: Blocks after 5 requests', async () => {
    const app2 = await createApp({ redis: new RedisMock() as unknown as Redis });
    await app2.ready();

    const remoteAddress = '10.0.0.1';

    for (let i = 0; i < 5; i++) {
      const res = await app2.inject({
        method: 'GET',
        url: '/healthz',
        remoteAddress,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    }

    const blocked = await app2.inject({
      method: 'GET',
      url: '/healthz',
      remoteAddress,
    });

    expect(blocked.statusCode).toBe(429);

    await app2.close();
  });
});
