import { type FastifyInstance } from 'fastify';
import { type Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { createApp, type GatewayEngineClient } from '../../src/app.js';
import {
  type FirebaseIdTokenVerifier,
  type VerifiedFirebaseIdToken,
} from '../../src/auth/firebase-auth.js';
import { InMemoryMatchRepository } from '../../src/match/repository.js';
import { InMemoryReplayRepository } from '../../src/replay/repository.js';
import { InMemoryReplayStorage } from '../../src/replay/storage.js';

class MockVerifier implements FirebaseIdTokenVerifier {
  async verifyIdToken(_idToken: string): Promise<VerifiedFirebaseIdToken> {
    return {
      uid: 'test-user',
      providerId: 'google.com',
      customClaims: {},
    };
  }
}

class MessageCollector {
  private messages: unknown[] = [];
  private waiters: { predicate: (v: unknown) => boolean; resolve: (v: unknown) => void }[] = [];

  constructor(socket: WebSocket) {
    socket.on('message', (data: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(data.toString()) as unknown;
        this.messages.push(parsed);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          const waiter = this.waiters[i];
          if (waiter.predicate(parsed)) {
            this.waiters.splice(i, 1);
            waiter.resolve(parsed);
          }
        }
      } catch {
        // ignore
      }
    });
  }

  waitFor<T>(predicate: (v: unknown) => v is T, timeoutMs = 3000): Promise<T> {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing as T);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error('Timed out waiting for message'));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (v) => {
          clearTimeout(timeout);
          resolve(v as T);
        },
      });
    });
  }
}

const waitForOpen = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    socket.once('open', resolve);
    socket.once('error', () => reject(new Error('WebSocket failed to open')));
  });

const isSessionReady = (v: unknown): v is { type: 'session/ready' } =>
  typeof v === 'object' && v !== null && (v as Record<string, unknown>).type === 'session/ready';

const isMatchEnded = (v: unknown): v is { type: 'match/ended' } =>
  typeof v === 'object' && v !== null && (v as Record<string, unknown>).type === 'match/ended';

const makeEngineClient = (opts?: { terminateOnFirstCall?: boolean }): GatewayEngineClient => ({
  getTools: vi.fn(async () => [
    {
      name: 'submit_action',
      description: 'Submit action',
      version: '1.0.0',
      inputSchema: { type: 'object', properties: { move: { type: 'string' } } },
    },
  ]),
  callTool: vi.fn(async () =>
    opts?.terminateOnFirstCall
      ? {
          request_id: 'req-1',
          status: 'ok' as const,
          result: { accepted: true },
          termination: { ended: true, winner: 'agent-1', reason: 'SCORE' },
        }
      : {
          request_id: 'req-1',
          status: 'ok' as const,
          result: { accepted: true },
        },
  ),
  getMatchMeta: vi.fn(async () => ({
    gameId: 'prompt-injection-arena',
    ruleVersion: '1.0.0',
  })),
});

describe('Match status lifecycle (Issue #38)', () => {
  const apps: FastifyInstance[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    sockets.length = 0;
    for (const app of apps) {
      await app.close();
    }
    apps.length = 0;
    vi.restoreAllMocks();
  });

  const startApp = async (
    engineClient: GatewayEngineClient,
    matchRepo: InMemoryMatchRepository,
  ) => {
    const app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      engineClient,
      reconnectGraceMs: 100,
      replayRepository: new InMemoryReplayRepository(),
      replayStorage: new InMemoryReplayStorage(),
      matchRepository: matchRepo,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    apps.push(app);
    return app;
  };

  const connectAgent = async (
    app: FastifyInstance,
    connectToken: string,
  ): Promise<{ ws: WebSocket; collector: MessageCollector }> => {
    const address = app.server.address() as { port: number };
    const ws = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?connect_token=${encodeURIComponent(connectToken)}`,
      ['moltgame.v1'],
    );
    sockets.push(ws);
    const collector = new MessageCollector(ws);
    await waitForOpen(ws);
    await collector.waitFor(isSessionReady);
    return { ws, collector };
  };

  const issueToken = async (
    app: FastifyInstance,
    matchId: string,
    agentId: string,
  ): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer valid-token' },
      payload: { matchId, agentId },
    });
    if (res.statusCode !== 201) {
      throw new Error(`Token issuance failed: ${res.payload}`);
    }
    return (res.json() as { connectToken: string }).connectToken;
  };

  it('GET /v1/matches/:matchId returns 404 before any agent connects', async () => {
    const matchRepo = new InMemoryMatchRepository();
    const app = await startApp(makeEngineClient(), matchRepo);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/matches/no-such-match',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status: 'error' });
  });

  it('GET /v1/matches/:matchId returns WAITING_AGENT_CONNECT after first agent connects', async () => {
    const matchRepo = new InMemoryMatchRepository();
    const app = await startApp(makeEngineClient(), matchRepo);

    const token = await issueToken(app, 'match-001', 'agent-1');
    await connectAgent(app, token);
    // Give async match status update time to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/matches/match-001',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; match: { status: string; matchId: string } };
    expect(body.status).toBe('ok');
    expect(body.match.matchId).toBe('match-001');
    expect(body.match.status).toBe('WAITING_AGENT_CONNECT');
  });

  it('match transitions to IN_PROGRESS when both agents connect', async () => {
    const matchRepo = new InMemoryMatchRepository();
    const app = await startApp(makeEngineClient(), matchRepo);

    const token1 = await issueToken(app, 'match-002', 'agent-1');
    const token2 = await issueToken(app, 'match-002', 'agent-2');

    await connectAgent(app, token1);
    await connectAgent(app, token2);
    // Give async match status update time to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/matches/match-002',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { match: { status: string; startedAt?: string } };
    expect(body.match.status).toBe('IN_PROGRESS');
    expect(body.match.startedAt).toBeDefined();
  });

  it('match transitions to FINISHED when termination is detected', async () => {
    const matchRepo = new InMemoryMatchRepository();
    const engineClient = makeEngineClient({ terminateOnFirstCall: true });
    const app = await startApp(engineClient, matchRepo);

    const token1 = await issueToken(app, 'match-003', 'agent-1');
    const token2 = await issueToken(app, 'match-003', 'agent-2');

    const { ws: ws1, collector: collector1 } = await connectAgent(app, token1);
    await connectAgent(app, token2);
    // Give async IN_PROGRESS update time
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Trigger a tool call that causes termination
    ws1.send(JSON.stringify({ request_id: 'req-1', tool: 'submit_action', args: { move: 'A1' } }));

    // Wait for match/ended message
    await collector1.waitFor(isMatchEnded);

    // Give async operations time to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/matches/match-003',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { match: { status: string; endedAt?: string } };
    expect(body.match.status).toBe('FINISHED');
    expect(body.match.endedAt).toBeDefined();
  });

  it('match transitions to ABORTED when reconnect grace period expires', async () => {
    const matchRepo = new InMemoryMatchRepository();
    const app = await startApp(makeEngineClient(), matchRepo);

    const token1 = await issueToken(app, 'match-004', 'agent-1');
    const token2 = await issueToken(app, 'match-004', 'agent-2');

    const { ws: ws1 } = await connectAgent(app, token1);
    await connectAgent(app, token2);
    // Give async IN_PROGRESS update time
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Disconnect agent-1 and let the forfeit timer expire
    ws1.close();

    // Wait for reconnect grace (100ms) + buffer
    await new Promise((resolve) => setTimeout(resolve, 250));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/matches/match-004',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { match: { status: string } };
    expect(body.match.status).toBe('ABORTED');
  });
});
