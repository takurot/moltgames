import { describe, expect, it } from 'vitest';

import {
  CONNECT_TOKEN_TTL_SECONDS,
  ConnectTokenError,
  ConnectTokenService,
  InMemoryConnectTokenSessionStore,
  type Clock,
} from '../../../src/auth/connect-token.js';

class FixedClock implements Clock {
  #epochMs: number;

  constructor(iso8601: string) {
    this.#epochMs = new Date(iso8601).getTime();
  }

  now(): Date {
    return new Date(this.#epochMs);
  }

  advanceSeconds(seconds: number): void {
    this.#epochMs += seconds * 1000;
  }
}

describe('ConnectTokenService', () => {
  it('issues and consumes a signed single-use token', async () => {
    const clock = new FixedClock('2026-02-18T00:00:00.000Z');
    const service = new ConnectTokenService({
      secret: 'unit-test-secret',
      store: new InMemoryConnectTokenSessionStore(clock),
      clock,
    });

    const issued = await service.issueToken({
      uid: 'user-1',
      matchId: 'match-1',
      agentId: 'agent-1',
    });

    expect(issued.expiresAt).toBe(issued.issuedAt + CONNECT_TOKEN_TTL_SECONDS);
    expect(issued.connectToken).toContain('.');

    const verified = await service.verifyToken(issued.connectToken);
    expect(verified.uid).toBe('user-1');
    expect(verified.matchId).toBe('match-1');
    expect(verified.agentId).toBe('agent-1');

    const consumed = await service.consumeToken(issued.connectToken);
    expect(consumed.tokenId).toBe(issued.tokenId);

    await expect(service.consumeToken(issued.connectToken)).rejects.toBeInstanceOf(
      ConnectTokenError,
    );
    await expect(service.consumeToken(issued.connectToken)).rejects.toMatchObject({
      code: 'TOKEN_ALREADY_USED',
    });
  });

  it('rejects tampered tokens', async () => {
    const clock = new FixedClock('2026-02-18T00:00:00.000Z');
    const service = new ConnectTokenService({
      secret: 'unit-test-secret',
      store: new InMemoryConnectTokenSessionStore(clock),
      clock,
    });
    const issued = await service.issueToken({
      uid: 'user-1',
      matchId: 'match-1',
      agentId: 'agent-1',
    });

    const tampered = `${issued.connectToken}tampered`;

    await expect(service.verifyToken(tampered)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('rejects expired tokens', async () => {
    const clock = new FixedClock('2026-02-18T00:00:00.000Z');
    const service = new ConnectTokenService({
      secret: 'unit-test-secret',
      store: new InMemoryConnectTokenSessionStore(clock),
      clock,
    });
    const issued = await service.issueToken({
      uid: 'user-1',
      matchId: 'match-1',
      agentId: 'agent-1',
    });

    clock.advanceSeconds(CONNECT_TOKEN_TTL_SECONDS + 1);

    await expect(service.verifyToken(issued.connectToken)).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
  });

  it('revokes token by owner and blocks verification', async () => {
    const clock = new FixedClock('2026-02-18T00:00:00.000Z');
    const service = new ConnectTokenService({
      secret: 'unit-test-secret',
      store: new InMemoryConnectTokenSessionStore(clock),
      clock,
    });
    const issued = await service.issueToken({
      uid: 'user-1',
      matchId: 'match-1',
      agentId: 'agent-1',
    });

    await service.revokeToken({
      tokenId: issued.tokenId,
      requesterUid: 'user-1',
      requesterRoles: [],
    });

    await expect(service.verifyToken(issued.connectToken)).rejects.toMatchObject({
      code: 'TOKEN_REVOKED',
    });
  });

  it('allows admin to revoke another user token', async () => {
    const clock = new FixedClock('2026-02-18T00:00:00.000Z');
    const service = new ConnectTokenService({
      secret: 'unit-test-secret',
      store: new InMemoryConnectTokenSessionStore(clock),
      clock,
    });
    const issued = await service.issueToken({
      uid: 'user-1',
      matchId: 'match-1',
      agentId: 'agent-1',
    });

    await service.revokeToken({
      tokenId: issued.tokenId,
      requesterUid: 'admin-user',
      requesterRoles: ['admin'],
    });

    await expect(service.verifyToken(issued.connectToken)).rejects.toMatchObject({
      code: 'TOKEN_REVOKED',
    });
  });

  it('rejects token revoke from non-owner non-admin', async () => {
    const clock = new FixedClock('2026-02-18T00:00:00.000Z');
    const service = new ConnectTokenService({
      secret: 'unit-test-secret',
      store: new InMemoryConnectTokenSessionStore(clock),
      clock,
    });
    const issued = await service.issueToken({
      uid: 'user-1',
      matchId: 'match-1',
      agentId: 'agent-1',
    });

    await expect(
      service.revokeToken({
        tokenId: issued.tokenId,
        requesterUid: 'user-2',
        requesterRoles: ['player'],
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_FORBIDDEN' });
  });
});
