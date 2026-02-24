import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '../../src/client.js';

const wsMockState = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock('ws', () => {
  type EventHandler = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    private handlers = new Map<string, EventHandler[]>();

    constructor() {
      wsMockState.instances.push(this);
    }

    on(event: string, handler: EventHandler): this {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }

    send(): void {
      // no-op for tests
    }

    close(code = 1000, reason = ''): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', code, reason);
    }

    emit(event: string, ...args: unknown[]): void {
      const list = this.handlers.get(event);
      if (!list) {
        return;
      }
      for (const handler of list) {
        handler(...args);
      }
    }

    triggerOpen(): void {
      this.readyState = MockWebSocket.OPEN;
      this.emit('open');
    }

    triggerError(error: Error): void {
      this.emit('error', error);
    }

    triggerClose(code: number, reason: string): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', code, reason);
    }

    triggerMessage(payload: unknown): void {
      const text = JSON.stringify(payload);
      this.emit('message', Buffer.from(text, 'utf-8'));
    }
  }

  return { default: MockWebSocket };
});

interface TestSocket {
  triggerOpen(): void;
  triggerError(error: Error): void;
  triggerClose(code: number, reason: string): void;
  triggerMessage(payload: unknown): void;
}

const getLatestSocket = (): TestSocket => {
  const socket = wsMockState.instances.at(-1) as TestSocket | undefined;
  if (!socket) {
    throw new Error('Expected a websocket instance to exist');
  }
  return socket;
};

describe('CLI Client', () => {
  beforeEach(() => {
    wsMockState.instances.length = 0;
    vi.restoreAllMocks();
  });

  it('initializes with correct options', () => {
    const client = new Client({
      url: 'ws://localhost:8080/v1/ws',
      token: 'test-token',
    });
    expect(client).toBeDefined();
    expect(client.getAvailableTools()).toEqual([]);
  });

  it('does not throw when websocket error occurs without an error listener', async () => {
    const client = new Client({
      url: 'ws://localhost:8080/v1/ws',
      token: 'test-token',
    });

    const connectPromise = client.connect();
    const socket = getLatestSocket();
    const error = new Error('connection failed');

    expect(() => socket.triggerError(error)).not.toThrow();
    await expect(connectPromise).rejects.toBe(error);
  });

  it('uses reconnect_after_ms from DRAINING messages, including 0', async () => {
    const client = new Client({
      url: 'ws://localhost:8080/v1/ws',
      token: 'test-token',
      reconnectInitialDelayMs: 250,
      reconnectMaxDelayMs: 2000,
    });

    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);

    const connectPromise = client.connect();
    const socket = getLatestSocket();
    socket.triggerOpen();
    await connectPromise;

    socket.triggerMessage({
      type: 'DRAINING',
      reconnect_after_ms: 0,
    });
    socket.triggerClose(1012, 'draining');

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0);
  });
});
