import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const buildToolDefinition = (name: string) => ({
  name,
  description: `${name} description`,
  version: '1.0.0',
  inputSchema: {
    type: 'object',
    additionalProperties: true,
  },
});

describe('Runner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    socket.triggerMessage({ type: 'tools/list', tools: [buildToolDefinition('send_message')] });
    await Promise.resolve();

    expect(socket.sentPayloads).toHaveLength(1);
    socket.triggerMessage({ type: 'tools/list_changed', tools: [buildToolDefinition('respond')] });
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

  it('does not reconnect after explicit close even when reconnect timer is pending', async () => {
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
    firstSocket.triggerOpen();
    await connectPromise;

    firstSocket.triggerClose(1012, 'draining');
    runner.close();
    await vi.advanceTimersByTimeAsync(20);

    expect(wsMockState.instances).toHaveLength(1);
  });

  describe('tools/list_changed race condition guard', () => {
    it('defers the next action loop after ok when tools/list_changed has not yet arrived', async () => {
      vi.useFakeTimers();

      const planner = {
        decide: vi
          .fn()
          .mockResolvedValueOnce({ tool: 'send_message', args: { content: 'A' } })
          .mockResolvedValueOnce({ tool: 'send_message', args: { content: 'B' } }),
      };

      const runner = new Runner({
        url: 'ws://localhost:8080/v1/ws',
        token: 'connect-token',
        planner,
        toolsListRefreshTimeoutMs: 100,
      });

      const connectPromise = runner.connect();
      const socket = getSocketAt(0);
      socket.triggerOpen();
      await connectPromise;

      socket.triggerMessage({ type: 'session/ready', session_id: 'session-1' });
      socket.triggerMessage({
        type: 'tools/list',
        tools: [buildToolDefinition('send_message')],
      });
      await Promise.resolve();
      expect(socket.sentPayloads).toHaveLength(1);

      // ok arrives WITHOUT a prior tools/list_changed for this request
      const firstPayload = JSON.parse(socket.sentPayloads[0]!) as { request_id: string };
      socket.triggerMessage({ request_id: firstPayload.request_id, status: 'ok', result: {} });
      await Promise.resolve();

      // Action loop should be deferred — no second action yet
      expect(socket.sentPayloads).toHaveLength(1);

      // Fallback timer fires → action loop unblocks
      await vi.advanceTimersByTimeAsync(101);
      expect(socket.sentPayloads).toHaveLength(2);

      runner.close();
    });

    it('proceeds immediately after ok when tools/list_changed arrived while request was in-flight', async () => {
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
      socket.triggerMessage({
        type: 'tools/list',
        tools: [buildToolDefinition('send_message')],
      });
      await Promise.resolve();
      expect(socket.sentPayloads).toHaveLength(1);

      // tools/list_changed arrives WHILE request in-flight
      socket.triggerMessage({
        type: 'tools/list_changed',
        tools: [buildToolDefinition('respond')],
      });
      await Promise.resolve();
      expect(socket.sentPayloads).toHaveLength(1);

      // ok arrives AFTER tools/list_changed — should proceed immediately
      const firstPayload = JSON.parse(socket.sentPayloads[0]!) as { request_id: string };
      socket.triggerMessage({ request_id: firstPayload.request_id, status: 'ok', result: {} });
      await Promise.resolve();

      expect(socket.sentPayloads).toHaveLength(2);
      expect(planner.decide).toHaveBeenCalledTimes(2);

      runner.close();
    });

    it('fires action loop immediately when tools/list_changed arrives during refresh wait', async () => {
      vi.useFakeTimers();

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
        toolsListRefreshTimeoutMs: 500,
      });

      const connectPromise = runner.connect();
      const socket = getSocketAt(0);
      socket.triggerOpen();
      await connectPromise;

      socket.triggerMessage({ type: 'session/ready', session_id: 'session-1' });
      socket.triggerMessage({
        type: 'tools/list',
        tools: [buildToolDefinition('send_message')],
      });
      await Promise.resolve();
      expect(socket.sentPayloads).toHaveLength(1);

      // ok without prior tools/list_changed → deferred
      const firstPayload = JSON.parse(socket.sentPayloads[0]!) as { request_id: string };
      socket.triggerMessage({ request_id: firstPayload.request_id, status: 'ok', result: {} });
      await Promise.resolve();
      expect(socket.sentPayloads).toHaveLength(1);

      // Advance slightly (not past timeout) — still deferred
      await vi.advanceTimersByTimeAsync(50);
      expect(socket.sentPayloads).toHaveLength(1);

      // tools/list_changed arrives during wait → cancels timer, fires immediately
      socket.triggerMessage({
        type: 'tools/list_changed',
        tools: [buildToolDefinition('respond')],
      });
      await Promise.resolve();
      expect(socket.sentPayloads).toHaveLength(2);

      runner.close();
    });

    it('cancels the tools-list refresh timer when close() is called', async () => {
      vi.useFakeTimers();

      const planner = {
        decide: vi
          .fn()
          .mockResolvedValueOnce({ tool: 'send_message', args: { content: 'A' } })
          .mockResolvedValueOnce({ tool: 'send_message', args: { content: 'B' } }),
      };

      const runner = new Runner({
        url: 'ws://localhost:8080/v1/ws',
        token: 'connect-token',
        planner,
        toolsListRefreshTimeoutMs: 100,
      });

      const connectPromise = runner.connect();
      const socket = getSocketAt(0);
      socket.triggerOpen();
      await connectPromise;

      socket.triggerMessage({ type: 'session/ready', session_id: 'session-1' });
      socket.triggerMessage({
        type: 'tools/list',
        tools: [buildToolDefinition('send_message')],
      });
      await Promise.resolve();
      expect(socket.sentPayloads).toHaveLength(1);

      // ok without tools/list_changed → deferred
      const firstPayload = JSON.parse(socket.sentPayloads[0]!) as { request_id: string };
      socket.triggerMessage({ request_id: firstPayload.request_id, status: 'ok', result: {} });
      await Promise.resolve();

      runner.close();

      // Advance past timeout — timer should be cancelled, no additional action
      await vi.advanceTimersByTimeAsync(200);
      expect(socket.sentPayloads).toHaveLength(1);
    });
  });

  it('clears active in-flight request on disconnect so action loop resumes after reconnect', async () => {
    vi.useFakeTimers();

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
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 20,
    });

    const connectPromise = runner.connect();
    const firstSocket = getSocketAt(0);
    firstSocket.triggerOpen();
    await connectPromise;

    firstSocket.triggerMessage({ type: 'session/ready', session_id: 'session-1' });
    firstSocket.triggerMessage({
      type: 'tools/list',
      tools: [buildToolDefinition('send_message')],
    });
    await Promise.resolve();
    expect(firstSocket.sentPayloads).toHaveLength(1);

    firstSocket.triggerClose(1012, 'network');
    await vi.advanceTimersByTimeAsync(10);

    const secondSocket = getSocketAt(1);
    secondSocket.triggerOpen();
    secondSocket.triggerMessage({ type: 'session/resumed', session_id: 'session-1' });
    secondSocket.triggerMessage({ type: 'tools/list', tools: [buildToolDefinition('respond')] });
    await Promise.resolve();

    expect(secondSocket.sentPayloads).toHaveLength(1);
    expect(planner.decide).toHaveBeenCalledTimes(2);
  });
});
