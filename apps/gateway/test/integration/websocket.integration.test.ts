import { type FastifyInstance } from 'fastify';
import { type Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { type RawData } from 'ws';

import { createApp, type GatewayEngineClient } from '../../src/app.js';
import {
  type FirebaseIdTokenVerifier,
  type VerifiedFirebaseIdToken,
} from '../../src/auth/firebase-auth.js';

class MockVerifier implements FirebaseIdTokenVerifier {
  async verifyIdToken(idToken: string): Promise<VerifiedFirebaseIdToken> {
    if (idToken !== 'valid-token') {
      throw new Error('Invalid token');
    }

    return {
      uid: 'test-user',
      providerId: 'google.com',
      customClaims: { roles: ['player'] },
    };
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

  it('rejects unsupported websocket protocol', async () => {
    const engineClient: GatewayEngineClient = {
      getTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({
        request_id: 'req-1',
        status: 'ok',
        result: {},
      })),
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
});
