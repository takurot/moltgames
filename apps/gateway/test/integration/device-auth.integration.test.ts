import { type FastifyInstance } from 'fastify';
import { type Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  type FirebaseIdTokenVerifier,
  type VerifiedFirebaseIdToken,
} from '../../src/auth/firebase-auth.js';

class MockVerifier implements FirebaseIdTokenVerifier {
  async verifyIdToken(idToken: string): Promise<VerifiedFirebaseIdToken> {
    if (idToken === 'valid-token') {
      return {
        uid: 'test-user',
        providerId: 'google.com',
        customClaims: { roles: ['player'] },
      };
    }

    throw new Error('Invalid token');
  }
}

describe('device auth integration', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('completes the device flow through issue, activate, and token polling endpoints', async () => {
    const issueResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/device',
    });

    expect(issueResponse.statusCode).toBe(201);
    const issueBody = issueResponse.json<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>();
    expect(issueBody.verification_uri).toBe('https://moltgame.com/activate');

    const pendingResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: {
        device_code: issueBody.device_code,
      },
    });

    expect(pendingResponse.statusCode).toBe(428);
    expect(pendingResponse.json()).toEqual({
      error: {
        code: 'AUTHORIZATION_PENDING',
        message: 'Device authorization is still pending',
        retryable: true,
      },
    });

    const activateResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/device/activate',
      headers: {
        authorization: 'Bearer valid-token',
      },
      payload: {
        userCode: issueBody.user_code,
        refreshToken: 'refresh-token-1',
        expiresIn: 3600,
      },
    });

    expect(activateResponse.statusCode).toBe(204);

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: {
        device_code: issueBody.device_code,
      },
    });

    expect(tokenResponse.statusCode).toBe(200);
    expect(tokenResponse.json()).toEqual({
      id_token: 'valid-token',
      refresh_token: 'refresh-token-1',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  });
});
