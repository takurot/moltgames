import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPromptInjectionPlanner, Runner } from '../../src/runner.js';

const wsMockState = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock('ws', () => {
  type EventHandler = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    readonly sentPayloads: string[] = [];
    private handlers = new Map<string, EventHandler[]>();

    constructor(public readonly url: string) {
      wsMockState.instances.push(this);
    }

    on(event: string, handler: EventHandler): this {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }

    send(payload: string): void {
      this.sentPayloads.push(payload);
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
  readonly url: string;
  readonly sentPayloads: string[];
  triggerOpen(): void;
  triggerError(error: Error): void;
  triggerClose(code: number, reason: string): void;
  triggerMessage(payload: unknown): void;
}

const getSocketAt = (index: number): TestSocket => {
  const socket = wsMockState.instances.at(index) as TestSocket | undefined;
  if (!socket) {
    throw new Error(`Expected websocket instance at index ${index}`);
  }

  return socket;
};

describe('Runner', () => {
  beforeEach(() => {
    wsMockState.instances.length = 0;
    vi.restoreAllMocks();
  });

  it('reconnects with session_id after initial session/ready', async () => {
    vi.useFakeTimers();

    const runner = new Runner({
      url: 'ws://localhost:8080/v1/ws',
      token: 'connect-token',
      planner: createPromptInjectionPlanner(),
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 20,
    });

    const connectPromise = runner.connect();
    const firstSocket = getSocketAt(0);
    expect(firstSocket.url).toContain('connect_token=connect-token');
    firstSocket.triggerOpen();
    await connectPromise;

    firstSocket.triggerMessage({ type: 'session/ready', session_id: 'session-123' });
    firstSocket.triggerClose(1012, 'draining');
    await vi.advanceTimersByTimeAsync(10);

    const secondSocket = getSocketAt(1);
    expect(secondSocket.url).toContain('session_id=session-123');
  });

  it('runs one tool action at a time and waits for response', async () => {
    const planner = {
      decide: vi
        .fn()
        .mockResolvedValueOnce({ tool: 'send_message', args: { content: 'A' } })
        .mockResolvedValueOnce({ tool: 'respond', args: { content: 'B' } }),
    };

    const runner = new Runner({
      url: 'ws://localhost:8080/v1/ws',
      token: 'connect-token',
      planner,
    });

    const connectPromise = runner.connect();
    const socket = getSocketAt(0);
    socket.triggerOpen();
    await connectPromise;

    socket.triggerMessage({ type: 'session/ready', session_id: 'session-1' });
    socket.triggerMessage({ type: 'tools/list', tools: [{ name: 'send_message' }] });
    await Promise.resolve();

    expect(socket.sentPayloads).toHaveLength(1);
    socket.triggerMessage({ type: 'tools/list_changed', tools: [{ name: 'respond' }] });
    await Promise.resolve();
    expect(socket.sentPayloads).toHaveLength(1);

    const firstPayload = JSON.parse(socket.sentPayloads[0]) as { request_id: string };
    socket.triggerMessage({
      request_id: firstPayload.request_id,
      status: 'ok',
      result: {},
    });
    await Promise.resolve();

    expect(socket.sentPayloads).toHaveLength(2);
    expect(planner.decide).toHaveBeenCalledTimes(2);
  });
});
