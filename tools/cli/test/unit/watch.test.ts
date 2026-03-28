import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- WebSocket mock setup (hoisted so it runs before imports) ----

const wsMockState = vi.hoisted(() => ({
  instances: [] as MockWebSocketInstance[],
}));

interface MockWebSocketInstance {
  url: string;
  protocols: string | string[] | undefined;
  readyState: number;
  triggerOpen(): void;
  triggerClose(code: number, reason: string): void;
  triggerMessage(payload: unknown): void;
  triggerError(error: Error): void;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

vi.mock('ws', () => {
  type EventHandler = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    url: string;
    protocols: string | string[] | undefined;

    private readonly handlers = new Map<string, EventHandler[]>();

    close = vi.fn((_code = 1000, _reason = '') => {
      this.readyState = MockWebSocket.CLOSED;
      this._emit('close', _code, Buffer.from(''));
    });

    send = vi.fn();

    constructor(url: string, protocols?: string | string[]) {
      this.url = url;
      this.protocols = protocols;
      wsMockState.instances.push(this as unknown as MockWebSocketInstance);
    }

    on(event: string, handler: EventHandler): this {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }

    _emit(event: string, ...args: unknown[]): void {
      const list = this.handlers.get(event);
      if (!list) return;
      for (const handler of list) {
        handler(...args);
      }
    }

    triggerOpen(): void {
      this.readyState = MockWebSocket.OPEN;
      this._emit('open');
    }

    triggerClose(code: number, reason: string): void {
      this.readyState = MockWebSocket.CLOSED;
      this._emit('close', code, Buffer.from(reason));
    }

    triggerMessage(payload: unknown): void {
      this._emit('message', JSON.stringify(payload));
    }

    triggerError(error: Error): void {
      this._emit('error', error);
    }
  }

  return { default: MockWebSocket };
});

const getLatestSocket = (): MockWebSocketInstance => {
  const socket = wsMockState.instances.at(-1);
  if (!socket) throw new Error('Expected a WebSocket instance to exist');
  return socket;
};

// ---- Import under test (after mock) ----

import { createWatchCommand, httpToWs } from '../../src/commands/watch.js';

// ---- Helper to run the watch command via parseAsync ----

async function runWatch(args: string[]): Promise<void> {
  const cmd = createWatchCommand();
  await cmd.parseAsync(['node', 'moltgame-watch', ...args]);
}

// ---- Tests ----

describe('httpToWs()', () => {
  it('converts http:// to ws://', () => {
    expect(httpToWs('http://localhost:8080')).toBe('ws://localhost:8080');
  });

  it('converts https:// to wss://', () => {
    expect(httpToWs('https://api.moltgame.com')).toBe('wss://api.moltgame.com');
  });

  it('leaves ws:// unchanged', () => {
    expect(httpToWs('ws://localhost:8080')).toBe('ws://localhost:8080');
  });

  it('leaves wss:// unchanged', () => {
    expect(httpToWs('wss://api.moltgame.com')).toBe('wss://api.moltgame.com');
  });
});

describe('createWatchCommand() - command metadata', () => {
  it('returns a Command with name "watch"', () => {
    const cmd = createWatchCommand();
    expect(cmd.name()).toBe('watch');
  });

  it('has a --json option', () => {
    const cmd = createWatchCommand();
    const jsonOpt = cmd.options.find((o) => o.long === '--json');
    expect(jsonOpt).toBeDefined();
  });

  it('has a --url option', () => {
    const cmd = createWatchCommand();
    const urlOpt = cmd.options.find((o) => o.long === '--url');
    expect(urlOpt).toBeDefined();
  });
});

describe('createWatchCommand() - action', () => {
  let stdoutOutput: string;
  let stderrOutput: string;

  beforeEach(() => {
    wsMockState.instances.length = 0;
    stdoutOutput = '';
    stderrOutput = '';

    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += String(chunk);
      return true;
    });

    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += String(chunk);
      return true;
    });

    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects to the correct WebSocket URL with match_id', async () => {
    const p = runWatch(['match-abc', '--url', 'http://localhost:8080']);
    const socket = getLatestSocket();

    expect(socket.url).toContain('/v1/ws/spectate');
    expect(socket.url).toContain('match_id=match-abc');
    expect(socket.url).toMatch(/^ws:\/\/localhost:8080/);

    socket.triggerOpen();
    socket.triggerClose(1000, 'normal');
    await p;
  });

  it('connects with the moltgame.v1 subprotocol', async () => {
    const p = runWatch(['match-xyz', '--url', 'http://localhost:8080']);
    const socket = getLatestSocket();

    expect(socket.protocols).toBe('moltgame.v1');

    socket.triggerOpen();
    socket.triggerClose(1000, 'normal');
    await p;
  });

  it('converts https base URL to wss://', async () => {
    const p = runWatch(['match-5', '--url', 'https://api.moltgame.com']);
    const socket = getLatestSocket();

    expect(socket.url).toMatch(/^wss:\/\/api\.moltgame\.com/);

    socket.triggerOpen();
    socket.triggerClose(1000, 'normal');
    await p;
  });

  it('outputs received events as NDJSON lines with --json flag', async () => {
    const p = runWatch(['match-1', '--url', 'http://localhost:8080', '--json']);
    const socket = getLatestSocket();
    socket.triggerOpen();

    const event1 = {
      type: 'match/event',
      event: { turn: 1, actor: 'agent1', actionType: 'send_message' },
    };
    const event2 = { type: 'match/ended', winner: 'agent1', reason: 'SECRET_GUESSED' };
    socket.triggerMessage(event1);
    socket.triggerMessage(event2);
    await p;

    const lines = stdoutOutput.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(lines[0]!)).toEqual(event1);
    expect(JSON.parse(lines[1]!)).toEqual(event2);
  });

  it('pretty-prints events in human-readable format without --json flag', async () => {
    const p = runWatch(['match-2', '--url', 'http://localhost:8080']);
    const socket = getLatestSocket();
    socket.triggerOpen();

    socket.triggerMessage({
      type: 'match/event',
      event: { turn: 3, actor: 'agent1', actionType: 'send_message' },
    });
    socket.triggerClose(1000, 'normal');
    await p;

    // Human-readable output must go to stderr (via printInfo)
    // and must contain useful context from the event
    expect(stderrOutput).toMatch(/turn_start|TURN|turn/i);
  });

  it('closes WebSocket and exits cleanly when match/ended event is received', async () => {
    const p = runWatch(['match-3', '--url', 'http://localhost:8080']);
    const socket = getLatestSocket();
    socket.triggerOpen();

    socket.triggerMessage({ type: 'match/ended', winner: 'agent1', reason: 'SECRET_GUESSED' });
    // After match/ended the implementation should close the socket itself
    // The close triggers resolution of the promise
    await p;

    expect(socket.close).toHaveBeenCalled();
  });

  it('resolves cleanly when server closes the connection', async () => {
    const p = runWatch(['match-4', '--url', 'http://localhost:8080']);
    const socket = getLatestSocket();
    socket.triggerOpen();
    socket.triggerClose(1000, 'done');

    await expect(p).resolves.toBeUndefined();
  });

  it('prints info message to stderr when connecting', async () => {
    const p = runWatch(['match-6', '--url', 'http://localhost:8080']);
    const socket = getLatestSocket();
    socket.triggerOpen();
    socket.triggerClose(1000, 'normal');
    await p;

    // Should show the matchId in a connecting message
    expect(stderrOutput).toMatch(/match-6/);
  });

  it('rejects on WebSocket error', async () => {
    const p = runWatch(['match-err', '--url', 'http://localhost:8080']);
    const socket = getLatestSocket();
    socket.triggerError(new Error('connection refused'));

    await expect(p).rejects.toThrow();
  });

  it('uses default URL (http://localhost:8080) when --url not specified', async () => {
    const p = runWatch(['match-default']);
    const socket = getLatestSocket();

    expect(socket.url).toMatch(/^ws:\/\/localhost:8080/);

    socket.triggerOpen();
    socket.triggerClose(1000, 'normal');
    await p;
  });
});
