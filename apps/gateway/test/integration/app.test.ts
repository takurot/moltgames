import { FastifyInstance } from 'fastify';
import { type Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  type FirebaseIdTokenVerifier,
  type VerifiedFirebaseIdToken,
} from '../../src/auth/firebase-auth.js';
import { InMemoryReplayRepository } from '../../src/replay/repository.js';
import { InMemoryReplayStorage } from '../../src/replay/storage.js';

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
  let replayRepository: InMemoryReplayRepository;
  let replayStorage: InMemoryReplayStorage;

  beforeEach(async () => {
    redis = new RedisMock();
    replayRepository = new InMemoryReplayRepository();
    replayStorage = new InMemoryReplayStorage();
    app = await createApp({
      redis: redis as unknown as Redis,
      verifier: new MockVerifier(),
      replayRepository,
      replayStorage,
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

  it('GET /v1/replays/:matchId should return a signed URL for public replays', async () => {
    await replayStorage.upload('replays/2026-q1/match-public.jsonl.gz', Buffer.from('payload'));
    await replayRepository.saveReplay({
      matchId: 'match-public',
      storagePath: 'replays/2026-q1/match-public.jsonl.gz',
      visibility: 'PUBLIC',
      redactionVersion: 'v1',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/replays/match-public',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      url: 'https://storage.example.com/signed/replays/2026-q1/match-public.jsonl.gz?expires=mock',
    });
  });

  it('GET /v1/replays/:matchId should reject private replays', async () => {
    await replayStorage.upload('replays/2026-q1/match-private.jsonl.gz', Buffer.from('payload'));
    await replayRepository.saveReplay({
      matchId: 'match-private',
      storagePath: 'replays/2026-q1/match-private.jsonl.gz',
      visibility: 'PRIVATE',
      redactionVersion: 'v1',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/replays/match-private',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      status: 'error',
      message: 'Replay is not publicly accessible',
    });
  });
});
