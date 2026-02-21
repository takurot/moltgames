import { FastifyInstance } from 'fastify';
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

describe('Gateway Integration', () => {
  let app: FastifyInstance;
  let redis: any;

  beforeEach(async () => {
    redis = new RedisMock();
    app = await createApp({
      redis: redis as unknown as Redis,
      verifier: new MockVerifier(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /healthz should return 200', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('POST /v1/tokens should issue a token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: {
        authorization: 'Bearer valid-token',
      },
      payload: {
        matchId: 'match-1',
        agentId: 'agent-1',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toHaveProperty('tokenId');
    expect(body).toHaveProperty('connectToken');
  });

  it('POST /v1/tokens should fail with invalid token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: {
        authorization: 'Bearer invalid-token',
      },
      payload: {
        matchId: 'match-1',
        agentId: 'agent-1',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('DELETE /v1/tokens/:tokenId should revoke token', async () => {
    // 1. Issue token
    const issueResponse = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: {
        authorization: 'Bearer valid-token',
      },
      payload: {
        matchId: 'match-1',
        agentId: 'agent-1',
      },
    });
    const { tokenId } = issueResponse.json();

    // 2. Revoke token
    const revokeResponse = await app.inject({
      method: 'DELETE',
      url: `/v1/tokens/${tokenId}`,
      headers: {
        authorization: 'Bearer valid-token',
      },
    });

    expect(revokeResponse.statusCode).toBe(204);
  });
});
