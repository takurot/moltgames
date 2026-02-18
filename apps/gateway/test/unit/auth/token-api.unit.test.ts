import { describe, expect, it } from 'vitest';

import {
  ConnectTokenService,
  InMemoryConnectTokenSessionStore,
  type Clock,
} from '../../../src/auth/connect-token.js';
import { createConnectTokenApi } from '../../../src/auth/token-api.js';

class FixedClock implements Clock {
  #epochMs: number;

  constructor(iso8601: string) {
    this.#epochMs = new Date(iso8601).getTime();
  }

  now(): Date {
    return new Date(this.#epochMs);
  }
}

const createApi = () => {
  const clock = new FixedClock('2026-02-18T00:00:00.000Z');
  const service = new ConnectTokenService({
    secret: 'unit-test-secret',
    store: new InMemoryConnectTokenSessionStore(clock),
    clock,
  });

  const api = createConnectTokenApi({
    connectTokenService: service,
    idTokenVerifier: {
      verifyIdToken: async (idToken) => {
        if (idToken === 'owner-token') {
          return {
            uid: 'owner-user',
            providerId: 'google.com',
            customClaims: { roles: ['player'] },
          };
        }

        if (idToken === 'admin-token') {
          return {
            uid: 'admin-user',
            providerId: 'github.com',
            customClaims: { roles: ['admin'] },
          };
        }

        if (idToken === 'other-token') {
          return {
            uid: 'other-user',
            providerId: 'google.com',
            customClaims: { roles: ['player'] },
          };
        }

        throw new Error('token verification failed');
      },
    },
  });

  return { api };
};

describe('connect token api', () => {
  it('issues token via POST /v1/tokens', async () => {
    const { api } = createApi();

    const response = await api.handle(
      new Request('https://gateway.local/v1/tokens', {
        method: 'POST',
        headers: {
          authorization: 'Bearer owner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          matchId: 'match-1',
          agentId: 'agent-1',
        }),
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.tokenId).toBeTypeOf('string');
    expect(body.connectToken).toBeTypeOf('string');
    expect(body.expiresAt).toBeTypeOf('number');
  });

  it('rejects invalid issue payload', async () => {
    const { api } = createApi();

    const response = await api.handle(
      new Request('https://gateway.local/v1/tokens', {
        method: 'POST',
        headers: {
          authorization: 'Bearer owner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          matchId: '',
          agentId: 'agent-1',
        }),
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('INVALID_REQUEST');
  });

  it('rejects missing authorization header', async () => {
    const { api } = createApi();

    const response = await api.handle(
      new Request('https://gateway.local/v1/tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          matchId: 'match-1',
          agentId: 'agent-1',
        }),
      }),
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });

  it('revokes token via DELETE /v1/tokens/:tokenId by owner', async () => {
    const { api } = createApi();

    const issueResponse = await api.handle(
      new Request('https://gateway.local/v1/tokens', {
        method: 'POST',
        headers: {
          authorization: 'Bearer owner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          matchId: 'match-1',
          agentId: 'agent-1',
        }),
      }),
    );

    const issueBody = (await issueResponse.json()) as { tokenId: string };

    const revokeResponse = await api.handle(
      new Request(`https://gateway.local/v1/tokens/${issueBody.tokenId}`, {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer owner-token',
        },
      }),
    );

    expect(revokeResponse.status).toBe(204);
  });

  it('allows admin to revoke another user token', async () => {
    const { api } = createApi();

    const issueResponse = await api.handle(
      new Request('https://gateway.local/v1/tokens', {
        method: 'POST',
        headers: {
          authorization: 'Bearer owner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          matchId: 'match-1',
          agentId: 'agent-1',
        }),
      }),
    );

    const issueBody = (await issueResponse.json()) as { tokenId: string };

    const revokeResponse = await api.handle(
      new Request(`https://gateway.local/v1/tokens/${issueBody.tokenId}`, {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer admin-token',
        },
      }),
    );

    expect(revokeResponse.status).toBe(204);
  });

  it('rejects revoke from non owner', async () => {
    const { api } = createApi();

    const issueResponse = await api.handle(
      new Request('https://gateway.local/v1/tokens', {
        method: 'POST',
        headers: {
          authorization: 'Bearer owner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          matchId: 'match-1',
          agentId: 'agent-1',
        }),
      }),
    );

    const issueBody = (await issueResponse.json()) as { tokenId: string };

    const revokeResponse = await api.handle(
      new Request(`https://gateway.local/v1/tokens/${issueBody.tokenId}`, {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer other-token',
        },
      }),
    );

    expect(revokeResponse.status).toBe(403);
    const revokeBody = (await revokeResponse.json()) as { error?: { code?: string } };
    expect(revokeBody.error?.code).toBe('FORBIDDEN');
  });
});
