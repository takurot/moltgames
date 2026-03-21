import { type FastifyInstance } from 'fastify';
import { type Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { type RawData } from 'ws';

import {
  createApp,
  type GatewayEngineClient,
  type SpectatorAccessController,
} from '../../src/app.js';
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
    if (idToken === 'spectator-token') {
      return {
        uid: 'spectator-user',
        providerId: 'google.com',
        customClaims: { roles: ['spectator'] },
      };
    }

    throw new Error('Invalid token');
  }
}

class MessageCollector {
  private messages: unknown[] = [];
  private waiters: { predicate: (value: unknown) => boolean; resolve: (value: any) => void }[] = [];

  constructor(socket: WebSocket) {
    socket.on('message', (data: RawData) => {
      try {
        const parsed = JSON.parse(data.toString());
        this.messages.push(parsed);
        this.checkWaiters();
      } catch {
        // ignore invalid JSON
      }
    });
  }

  async waitFor<T>(predicate: (value: unknown) => value is T, timeoutMs = 3000): Promise<T> {
    const existing = this.messages.find(predicate);
    if (existing) {
      return existing as T;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error('Timed out waiting for message'));
      }, timeoutMs);

      this.waiters.push({
        predicate,
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
      });
    });
  }

  private checkWaiters() {
    for (const message of this.messages) {
      for (let i = 0; i < this.waiters.length; i++) {
        const waiter = this.waiters[i];
        if (waiter.predicate(message)) {
          this.waiters.splice(i, 1);
          waiter.resolve(message);
          return;
        }
      }
    }
  }

  snapshot(): unknown[] {
    return [...this.messages];
  }
}

const waitForOpen = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('WebSocket failed to open'));
    };
    const cleanup = () => {
      socket.off('open', onOpen);
      socket.off('error', onError);
    };

    socket.on('open', onOpen);
    socket.on('error', onError);
  });

const waitForClose = (socket: WebSocket): Promise<number> =>
  new Promise((resolve) => {
    socket.once('close', (code) => {
      resolve(code);
    });
  });

const waitForMessage = <T>(
  socket: WebSocket,
  predicate: (value: unknown) => value is T,
  timeoutMs = 3000,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);

    const onMessage = (data: RawData) => {
      try {
        const parsed = JSON.parse(data.toString()) as unknown;
        if (predicate(parsed)) {
          cleanup();
          resolve(parsed);
        }
      } catch {
        // ignore invalid JSON and continue waiting
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
    };

    socket.on('message', onMessage);
  });

const isSessionReady = (value: unknown): value is { type: 'session/ready'; session_id: string } =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<string, unknown>).type === 'session/ready' &&
  typeof (value as Record<string, unknown>).session_id === 'string';

const isSessionResumed = (
  value: unknown,
): value is { type: 'session/resumed'; session_id: string } =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<string, unknown>).type === 'session/resumed' &&
  typeof (value as Record<string, unknown>).session_id === 'string';

const isToolsList = (value: unknown): value is { type: 'tools/list'; tools: unknown[] } =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<string, unknown>).type === 'tools/list' &&
  Array.isArray((value as Record<string, unknown>).tools);

const isToolCallResponse = (
  value: unknown,
): value is { request_id: string; status: 'ok' | 'error' } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>).request_id === 'string' &&
  ((value as Record<string, unknown>).status === 'ok' ||
    (value as Record<string, unknown>).status === 'error');

const isMatchEnded = (
  value: unknown,
): value is { type: 'match/ended'; winner?: string; reason?: string } =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<string, unknown>).type === 'match/ended';

const isSpectatorReady = (
  value: unknown,
): value is { type: 'spectator/ready'; match_id: string; session_id: string } =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<string, unknown>).type === 'spectator/ready' &&
  typeof (value as Record<string, unknown>).match_id === 'string' &&
  typeof (value as Record<string, unknown>).session_id === 'string';

const isMatchEvent = (
  value: unknown,
): value is {
  type: 'match/event';
  event: {
    actor: string;
    turn: number;
    action: Record<string, unknown>;
    result: Record<string, unknown>;
  };
} =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<string, unknown>).type === 'match/event' &&
  typeof (value as Record<string, unknown>).event === 'object' &&
  (value as Record<string, unknown>).event !== null;

describe('Gateway WebSocket integration', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    for (const app of apps) {
      await app.close();
    }
    apps.length = 0;
    vi.restoreAllMocks();
  });

  it('sends tools/list on connect and routes tool calls to engine', async () => {
    const engineClient: GatewayEngineClient = {
      getTools: vi.fn(async () => [
        {
          name: 'send_message',
          description: 'Send a prompt',
          version: '1.0.0',
          inputSchema: { type: 'object' },
        },
      ]),
      callTool: vi.fn(async () => ({
        request_id: 'req-1',
        status: 'ok',
        result: { accepted: true },
      })),
      getMatchMeta: vi.fn(async () => null),
    };

    const app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      engineClient,
    });
    apps.push(app);
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const issueTokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer valid-token' },
      payload: { matchId: 'match-1', agentId: 'agent-1' },
    });
    const { connectToken } = issueTokenResponse.json();

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server address is unavailable');
    }

    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?connect_token=${encodeURIComponent(connectToken)}`,
      'moltgame.v1',
    );
    const collector = new MessageCollector(socket);

    await waitForOpen(socket);
    const ready = await collector.waitFor(isSessionReady);
    expect(ready.session_id).toBeDefined();
    const toolsList = await collector.waitFor(isToolsList);
    expect(toolsList.tools.length).toBe(1);

    socket.send(
      JSON.stringify({
        tool: 'send_message',
        request_id: 'req-1',
        args: { content: 'hello' },
      }),
    );

    const response = await collector.waitFor(isToolCallResponse);
    expect(response.request_id).toBe('req-1');
    expect(response.status).toBe('ok');
    expect(engineClient.callTool).toHaveBeenCalledWith('match-1', {
      tool: 'send_message',
      request_id: 'req-1',
      args: { content: 'hello' },
      actor: 'agent-1',
    });

    socket.close();
  });

  it('allows reconnect with session_id during grace period', async () => {
    const engineClient: GatewayEngineClient = {
      getTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({
        request_id: 'req-1',
        status: 'ok',
        result: {},
      })),
      getMatchMeta: vi.fn(async () => null),
    };

    const app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      engineClient,
    });
    apps.push(app);
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const issueTokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer valid-token' },
      payload: { matchId: 'match-2', agentId: 'agent-2' },
    });
    const { connectToken } = issueTokenResponse.json();

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server address is unavailable');
    }

    const firstSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?connect_token=${encodeURIComponent(connectToken)}`,
      'moltgame.v1',
    );
    const firstCollector = new MessageCollector(firstSocket);
    await waitForOpen(firstSocket);
    const ready = await firstCollector.waitFor(isSessionReady);
    await firstCollector.waitFor(isToolsList);
    firstSocket.close();
    await waitForClose(firstSocket);

    const secondSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?session_id=${encodeURIComponent(ready.session_id)}`,
      'moltgame.v1',
    );
    const secondCollector = new MessageCollector(secondSocket);
    await waitForOpen(secondSocket);
    const resumed = await secondCollector.waitFor(isSessionResumed);
    expect(resumed.session_id).toBe(ready.session_id);
    await secondCollector.waitFor(isToolsList);
    secondSocket.close();
  });

  it('rejects tool calls that are not in the current session tool list', async () => {
    const engineClient: GatewayEngineClient = {
      getTools: vi.fn(async () => [
        {
          name: 'send_message',
          description: 'Send a prompt',
          version: '1.0.0',
          inputSchema: { type: 'object' },
        },
      ]),
      callTool: vi.fn(async () => ({
        request_id: 'req-allowed',
        status: 'ok',
        result: {},
      })),
      getMatchMeta: vi.fn(async () => null),
    };

    const app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      engineClient,
    });
    apps.push(app);
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const issueTokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer valid-token' },
      payload: { matchId: 'match-tool-check', agentId: 'agent-1' },
    });
    const { connectToken } = issueTokenResponse.json();

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server address is unavailable');
    }

    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?connect_token=${encodeURIComponent(connectToken)}`,
      'moltgame.v1',
    );
    const collector = new MessageCollector(socket);
    await waitForOpen(socket);
    await collector.waitFor(isSessionReady);
    await collector.waitFor(isToolsList);

    socket.send(
      JSON.stringify({
        tool: 'respond',
        request_id: 'req-blocked',
        args: { content: 'I should be rejected' },
      }),
    );

    const blockedResponse = await collector.waitFor(
      (
        value,
      ): value is {
        request_id: string;
        status: 'error';
        error: { code: string; message: string; retryable: boolean };
      } =>
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>).request_id === 'req-blocked' &&
        (value as Record<string, unknown>).status === 'error' &&
        typeof (value as Record<string, unknown>).error === 'object' &&
        (value as Record<string, unknown>).error !== null &&
        ((value as Record<string, unknown>).error as Record<string, unknown>).code ===
          'NOT_YOUR_TURN',
    );

    expect(blockedResponse.error.retryable).toBe(true);
    expect(engineClient.callTool).not.toHaveBeenCalled();

    socket.close();
  });

  it('closes previous socket when same agent reconnects with a new connect token', async () => {
    const engineClient: GatewayEngineClient = {
      getTools: vi.fn(async () => [
        {
          name: 'send_message',
          description: 'Send a prompt',
          version: '1.0.0',
          inputSchema: { type: 'object' },
        },
      ]),
      callTool: vi.fn(
        async (_matchId, request): Promise<{ request_id: string; status: 'ok'; result: {} }> => ({
          request_id: request.request_id,
          status: 'ok',
          result: {},
        }),
      ),
      getMatchMeta: vi.fn(async () => null),
    };

    const app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      engineClient,
    });
    apps.push(app);
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server address is unavailable');
    }

    const issueFirstTokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer valid-token' },
      payload: { matchId: 'match-dup', agentId: 'agent-dup' },
    });
    const { connectToken: firstToken } = issueFirstTokenResponse.json();

    const firstSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?connect_token=${encodeURIComponent(firstToken)}`,
      'moltgame.v1',
    );
    const firstCollector = new MessageCollector(firstSocket);
    await waitForOpen(firstSocket);
    await firstCollector.waitFor(isSessionReady);
    await firstCollector.waitFor(isToolsList);

    const firstSocketClosed = waitForClose(firstSocket);

    const issueSecondTokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer valid-token' },
      payload: { matchId: 'match-dup', agentId: 'agent-dup' },
    });
    const { connectToken: secondToken } = issueSecondTokenResponse.json();

    const secondSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?connect_token=${encodeURIComponent(secondToken)}`,
      'moltgame.v1',
    );
    const secondCollector = new MessageCollector(secondSocket);
    await waitForOpen(secondSocket);
    await secondCollector.waitFor(isSessionReady);
    await secondCollector.waitFor(isToolsList);

    expect(await firstSocketClosed).toBe(1012);

    secondSocket.send(
      JSON.stringify({
        tool: 'send_message',
        request_id: 'req-second',
        args: { content: 'hello from second socket' },
      }),
    );

    const secondResponse = await secondCollector.waitFor(isToolCallResponse);
    expect(secondResponse.request_id).toBe('req-second');
    expect(secondResponse.status).toBe('ok');
    expect(engineClient.callTool).toHaveBeenCalledTimes(1);

    secondSocket.close();
  });

  it('rejects unsupported websocket protocol', async () => {
    const engineClient: GatewayEngineClient = {
      getTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({
        request_id: 'req-1',
        status: 'ok',
        result: {},
      })),
      getMatchMeta: vi.fn(async () => null),
    };

    const app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      engineClient,
    });
    apps.push(app);
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const issueTokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer valid-token' },
      payload: { matchId: 'match-3', agentId: 'agent-3' },
    });
    const { connectToken } = issueTokenResponse.json();

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server address is unavailable');
    }

    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?connect_token=${encodeURIComponent(connectToken)}`,
      'moltgame.v2',
    );

    await waitForOpen(socket);
    const closeCode = await waitForClose(socket);
    expect(closeCode).toBe(1002);
  });

  it('skips replay generation when match metadata is unavailable at termination time', async () => {
    const replayRepository = new InMemoryReplayRepository();
    const replayStorage = new InMemoryReplayStorage();
    const engineClient: GatewayEngineClient = {
      getTools: vi.fn(async () => [
        {
          name: 'send_message',
          description: 'Send a prompt',
          version: '1.0.0',
          inputSchema: { type: 'object' },
        },
      ]),
      callTool: vi.fn(async () => ({
        request_id: 'req-finish',
        status: 'ok',
        result: { accepted: true },
        termination: {
          ended: true,
          winner: 'agent-1',
          reason: 'finished',
        },
      })),
      getMatchMeta: vi.fn(async () => null),
    };

    const app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      engineClient,
      replayRepository,
      replayStorage,
    });
    apps.push(app);
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const issueTokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer valid-token' },
      payload: { matchId: 'match-replay-metadata-miss', agentId: 'agent-1' },
    });
    const { connectToken } = issueTokenResponse.json();

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server address is unavailable');
    }

    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?connect_token=${encodeURIComponent(connectToken)}`,
      'moltgame.v1',
    );
    const collector = new MessageCollector(socket);
    await waitForOpen(socket);
    await collector.waitFor(isSessionReady);
    await collector.waitFor(isToolsList);

    socket.send(
      JSON.stringify({
        tool: 'send_message',
        request_id: 'req-finish',
        args: { content: 'hello' },
      }),
    );

    await collector.waitFor(
      (value): value is { request_id: string; status: 'ok' } =>
        isToolCallResponse(value) && value.request_id === 'req-finish' && value.status === 'ok',
    );
    await collector.waitFor(isMatchEnded);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await replayRepository.getReplay('match-replay-metadata-miss')).toBeNull();
    expect(replayStorage.listFiles()).toHaveLength(0);

    socket.close();
  });

  it('streams redacted match events to spectator sockets', async () => {
    const engineClient: GatewayEngineClient = {
      getTools: vi.fn(async () => [
        {
          name: 'check_secret',
          description: 'Guess the secret',
          version: '1.0.0',
          inputSchema: { type: 'object' },
        },
      ]),
      callTool: vi.fn(async () => ({
        request_id: 'req-spectator',
        status: 'ok',
        result: { guessedSecret: 'SECRET-Alpha-42', verdict: 'miss' },
        turnEventContext: {
          phase: 'secret-guess',
          seat: 'first',
          scoreDiffBefore: 0,
          scoreDiffAfter: 0,
          ruleVersion: '1.1.0',
        },
      })),
      getMatchMeta: vi.fn(async () => ({ gameId: 'prompt-injection-arena', ruleVersion: '1.1.0' })),
    };

    const app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      engineClient,
    });
    apps.push(app);
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const issueTokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer valid-token' },
      payload: { matchId: 'match-spectator', agentId: 'agent-1' },
    });
    const { connectToken } = issueTokenResponse.json<{ connectToken: string }>();

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server address is unavailable');
    }

    const spectatorSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws/spectate?match_id=match-spectator`,
      'moltgame.v1',
      { headers: { authorization: 'Bearer spectator-token' } },
    );
    const spectatorCollector = new MessageCollector(spectatorSocket);
    await waitForOpen(spectatorSocket);
    await spectatorCollector.waitFor(isSpectatorReady);

    const playerSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?connect_token=${encodeURIComponent(connectToken)}`,
      'moltgame.v1',
    );
    const playerCollector = new MessageCollector(playerSocket);
    await waitForOpen(playerSocket);
    await playerCollector.waitFor(isSessionReady);
    await playerCollector.waitFor(isToolsList);

    playerSocket.send(
      JSON.stringify({
        tool: 'check_secret',
        request_id: 'req-spectator',
        args: { guess: 'SECRET-Alpha-42' },
      }),
    );

    const playerResponse = await playerCollector.waitFor(
      (value): value is Record<string, unknown> =>
        isToolCallResponse(value) &&
        (value as Record<string, unknown>).request_id === 'req-spectator',
    );
    expect(playerResponse).not.toHaveProperty('turnEventContext');

    const event = await spectatorCollector.waitFor(isMatchEvent);
    expect(event.event.actor).toBe('agent-1');
    expect(event.event.turn).toBe(1);
    expect(event.event.action).toEqual({ tool: 'check_secret', args: { guess: '***REDACTED***' } });
    expect(event.event.result).toEqual({ guessedSecret: '***REDACTED***', verdict: 'miss' });
    expect((event.event as Record<string, unknown>).phase).toBe('secret-guess');
    expect((event.event as Record<string, unknown>).seat).toBe('first');
    expect((event.event as Record<string, unknown>).ruleVersion).toBe('1.1.0');
    expect((event.event as Record<string, unknown>).scoreDiffBefore).toBe(0);
    expect((event.event as Record<string, unknown>).scoreDiffAfter).toBe(0);
    expect(typeof (event.event as Record<string, unknown>).actionLatencyMs).toBe('number');

    spectatorSocket.close();
    playerSocket.close();
  });

  it('writes analytics fields to replay output without relying on match metadata warmup', async () => {
    const replayRepository = new InMemoryReplayRepository();
    const replayStorage = new InMemoryReplayStorage();
    const engineClient: GatewayEngineClient = {
      getTools: vi.fn(async () => [
        {
          name: 'send_message',
          description: 'Send a prompt',
          version: '1.0.0',
          inputSchema: { type: 'object' },
        },
      ]),
      callTool: vi.fn(async () => ({
        request_id: 'req-analytics-replay',
        status: 'ok',
        result: { accepted: true },
        termination: {
          ended: true,
          winner: 'agent-1',
          reason: 'finished',
        },
        turnEventContext: {
          phase: 'dialogue',
          seat: 'first',
          scoreDiffBefore: 0,
          scoreDiffAfter: 1,
          ruleVersion: '1.1.0',
        },
      })),
      getMatchMeta: vi.fn(async () => ({ gameId: 'prompt-injection-arena', ruleVersion: '1.1.0' })),
    };

    const app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      engineClient,
      replayRepository,
      replayStorage,
    });
    apps.push(app);
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const issueTokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer valid-token' },
      payload: { matchId: 'match-replay-analytics', agentId: 'agent-1' },
    });
    const { connectToken } = issueTokenResponse.json<{ connectToken: string }>();

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server address is unavailable');
    }

    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?connect_token=${encodeURIComponent(connectToken)}`,
      'moltgame.v1',
    );
    const collector = new MessageCollector(socket);
    await waitForOpen(socket);
    await collector.waitFor(isSessionReady);
    await collector.waitFor(isToolsList);

    socket.send(
      JSON.stringify({
        tool: 'send_message',
        request_id: 'req-analytics-replay',
        args: { content: 'hello' },
      }),
    );

    await collector.waitFor(
      (value): value is { request_id: string; status: 'ok' } =>
        isToolCallResponse(value) &&
        value.request_id === 'req-analytics-replay' &&
        value.status === 'ok',
    );
    await collector.waitFor(isMatchEnded);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const files = replayStorage.listFiles();
    expect(files).toHaveLength(1);

    const replayJsonl = replayStorage.getFileData(files[0]);
    const [line] = replayJsonl.trim().split('\n');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.ruleVersion).toBe('1.1.0');
    expect(parsed.phase).toBe('dialogue');
    expect(parsed.scoreDiffBefore).toBe(0);
    expect(parsed.scoreDiffAfter).toBe(1);
    expect(parsed.seat).toBe('first');
    expect(typeof parsed.actionLatencyMs).toBe('number');

    socket.close();
  });

  it('rejects spectator access to private matches when access controller denies', async () => {
    const spectatorAccessController: SpectatorAccessController = {
      authorize: vi.fn(async () => ({
        allowed: false,
        reason: 'Match is private',
      })),
    };

    const app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      spectatorAccessController,
    });
    apps.push(app);
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server address is unavailable');
    }

    const spectatorSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws/spectate?match_id=private-match`,
      'moltgame.v1',
      { headers: { authorization: 'Bearer spectator-token' } },
    );
    await waitForOpen(spectatorSocket);
    expect(await waitForClose(spectatorSocket)).toBe(1008);
  });

  it('returns MATCH_ENDED error for tool calls after match termination', async () => {
    const engineClient: GatewayEngineClient = {
      getTools: vi.fn(async () => [
        {
          name: 'send_message',
          description: 'Send a message',
          version: '1.0.0',
          inputSchema: { type: 'object' },
        },
      ]),
      callTool: vi.fn(async () => ({
        request_id: 'req-end',
        status: 'ok',
        result: {},
        termination: { ended: true, winner: 'agent-1', reason: 'VICTORY' },
      })),
      getMatchMeta: vi.fn(async () => null),
    };

    const app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      engineClient,
    });
    apps.push(app);
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const issueTokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer valid-token' },
      payload: { matchId: 'match-ended-test', agentId: 'agent-1' },
    });
    const { connectToken } = issueTokenResponse.json<{ connectToken: string }>();

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server address is unavailable');
    }

    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?connect_token=${encodeURIComponent(connectToken)}`,
      'moltgame.v1',
    );
    const collector = new MessageCollector(socket);
    await waitForOpen(socket);
    await collector.waitFor(isSessionReady);
    await collector.waitFor(isToolsList);

    // First call ends the match
    socket.send(
      JSON.stringify({
        tool: 'send_message',
        request_id: 'req-end',
        args: { content: 'hello' },
      }),
    );
    await collector.waitFor(isMatchEnded);

    // Second call after match ended should return MATCH_ENDED error
    socket.send(
      JSON.stringify({
        tool: 'send_message',
        request_id: 'req-after-end',
        args: { content: 'hello' },
      }),
    );

    const errorResponse = await collector.waitFor(
      (v): v is { request_id: string; status: 'error'; error: { code: string } } =>
        isToolCallResponse(v) &&
        v.request_id === 'req-after-end' &&
        v.status === 'error' &&
        typeof (v as Record<string, unknown>).error === 'object',
    );
    expect((errorResponse.error as { code: string }).code).toBe('MATCH_ENDED');

    socket.close();
  });

  it('does not fail player tool calls when spectator broadcast fails', async () => {
    const engineClient: GatewayEngineClient = {
      getTools: vi.fn(async () => [
        {
          name: 'send_message',
          description: 'Send a message',
          version: '1.0.0',
          inputSchema: { type: 'object' },
        },
      ]),
      callTool: vi.fn(async () => ({
        request_id: 'req-broadcast-failure',
        status: 'ok',
        result: { accepted: true },
      })),
      getMatchMeta: vi.fn(async () => {
        throw new Error('metadata unavailable');
      }),
    };

    const app = await createApp({
      redis: new RedisMock() as unknown as Redis,
      verifier: new MockVerifier(),
      engineClient,
    });
    apps.push(app);
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });

    const issueTokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer valid-token' },
      payload: { matchId: 'match-broadcast-failure', agentId: 'agent-1' },
    });
    const { connectToken } = issueTokenResponse.json<{ connectToken: string }>();

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server address is unavailable');
    }

    const spectatorSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws/spectate?match_id=match-broadcast-failure`,
      'moltgame.v1',
    );
    const spectatorCollector = new MessageCollector(spectatorSocket);
    await waitForOpen(spectatorSocket);
    await spectatorCollector.waitFor(isSpectatorReady);

    const playerSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?connect_token=${encodeURIComponent(connectToken)}`,
      'moltgame.v1',
    );
    const playerCollector = new MessageCollector(playerSocket);
    await waitForOpen(playerSocket);
    await playerCollector.waitFor(isSessionReady);
    await playerCollector.waitFor(isToolsList);

    playerSocket.send(
      JSON.stringify({
        tool: 'send_message',
        request_id: 'req-broadcast-failure',
        args: { content: 'hello' },
      }),
    );

    const response = await playerCollector.waitFor(
      (value): value is { request_id: string; status: 'ok'; result: { accepted: boolean } } =>
        isToolCallResponse(value) &&
        value.request_id === 'req-broadcast-failure' &&
        value.status === 'ok',
    );
    expect(response.result).toEqual({ accepted: true });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const duplicateErrors = playerCollector
      .snapshot()
      .filter(
        (value) =>
          isToolCallResponse(value) &&
          value.request_id === 'req-broadcast-failure' &&
          value.status === 'error',
      );
    expect(duplicateErrors).toHaveLength(0);

    spectatorSocket.close();
    playerSocket.close();
  });
});
