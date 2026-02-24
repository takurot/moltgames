import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://localhost:8080/v1/ws';
const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8081';
const BENCH_AUTH_TOKEN = process.env.BENCH_AUTH_TOKEN || 'valid-token';
const BENCH_MATCH_COUNT = Number.parseInt(process.env.BENCH_MATCH_COUNT || '3', 10);
const RUN_AGENT_BENCH = process.env.RUN_AGENT_BENCH === 'true';

const DEFAULT_TIMEOUT_MS = 20_000;
const SECRET_WORDS = ['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape'] as const;

interface BenchMessage {
  [key: string]: unknown;
}

interface BenchAgent {
  agentId: string;
  socket: WebSocket;
  messages: BenchMessage[];
  sessionId: string;
}

interface MatchRunOptions {
  seed: number;
  reconnectBeforeGuess?: boolean;
}

interface MatchRunResult {
  matchId: string;
  winner: string;
  reason: string;
  durationMs: number;
  reconnectCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const requestJson = async (params: {
  url: string;
  method: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<{ status: number; data: unknown }> => {
  const response = await fetch(params.url, {
    method: params.method,
    headers: {
      ...(params.body ? { 'content-type': 'application/json' } : {}),
      ...params.headers,
    },
    body: params.body === undefined ? undefined : JSON.stringify(params.body),
  });

  const text = await response.text();
  let data: unknown = null;

  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${params.method} ${params.url}: ${JSON.stringify(data)}`,
    );
  }

  return { status: response.status, data };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitFor = async (
  condition: () => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = 100,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
};

const waitForMessage = async (
  messages: BenchMessage[],
  predicate: (message: BenchMessage) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BenchMessage> => {
  await waitFor(() => messages.some(predicate), timeoutMs);

  const found = messages.find(predicate);
  if (!found) {
    throw new Error('Expected message was not found');
  }

  return found;
};

const extractToolNames = (messages: BenchMessage[]): string[] => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    if (message.type !== 'tools/list' && message.type !== 'tools/list_changed') {
      continue;
    }

    const tools = message.tools;
    if (!Array.isArray(tools)) {
      continue;
    }

    return tools
      .map((tool) => {
        if (!isRecord(tool)) {
          return null;
        }
        return typeof tool.name === 'string' ? tool.name : null;
      })
      .filter((name): name is string => typeof name === 'string');
  }

  return [];
};

const expectedSecretFromSeed = (seed: number): string => {
  const index = Math.floor(Math.abs(Math.sin(seed)) * SECRET_WORDS.length) % SECRET_WORDS.length;
  return `SECRET-${SECRET_WORDS[index]}-${seed}`;
};

const waitForOpen = async (socket: WebSocket): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off('open', onOpen);
      socket.off('error', onError);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.on('open', onOpen);
    socket.on('error', onError);
  });
};

const closeSocket = async (socket: WebSocket): Promise<void> => {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return;
  }

  await new Promise<void>((resolve) => {
    const onClose = () => {
      socket.off('close', onClose);
      resolve();
    };

    socket.on('close', onClose);
    socket.close(1000, 'bench cleanup');

    setTimeout(() => {
      socket.off('close', onClose);
      resolve();
    }, 1_000);
  });
};

const issueConnectToken = async (matchId: string, agentId: string): Promise<string> => {
  const response = await requestJson({
    url: `${GATEWAY_URL}/v1/tokens`,
    method: 'POST',
    body: {
      matchId,
      agentId,
    },
    headers: {
      Authorization: `Bearer ${BENCH_AUTH_TOKEN}`,
    },
  });

  if (!isRecord(response.data) || typeof response.data.connectToken !== 'string') {
    throw new Error('Token response did not include connectToken');
  }

  return response.data.connectToken;
};

const connectAgent = async (params: {
  agentId: string;
  connectToken?: string;
  sessionId?: string;
}): Promise<BenchAgent> => {
  const wsUrl = new URL(GATEWAY_WS_URL);

  if (params.sessionId) {
    wsUrl.searchParams.set('session_id', params.sessionId);
  } else if (params.connectToken) {
    wsUrl.searchParams.set('connect_token', params.connectToken);
  } else {
    throw new Error('Either connectToken or sessionId is required');
  }

  const socket = new WebSocket(wsUrl.toString(), 'moltgame.v1');
  const messages: BenchMessage[] = [];

  socket.on('message', (data) => {
    try {
      messages.push(JSON.parse(data.toString()) as BenchMessage);
    } catch {
      // Ignore malformed messages in bench collector
    }
  });

  await waitForOpen(socket);

  let sessionId = params.sessionId;
  if (sessionId) {
    await waitForMessage(messages, (message) => message.type === 'session/resumed');
  } else {
    const readyMessage = await waitForMessage(
      messages,
      (message) => message.type === 'session/ready',
    );
    if (typeof readyMessage.session_id !== 'string') {
      throw new Error('session/ready did not include session_id');
    }
    sessionId = readyMessage.session_id;
  }

  await waitForMessage(messages, (message) => message.type === 'tools/list');

  if (!sessionId) {
    throw new Error('sessionId is required after connection');
  }

  return {
    agentId: params.agentId,
    socket,
    messages,
    sessionId,
  };
};

const waitForTool = async (agent: BenchAgent, toolName: string): Promise<void> => {
  await waitFor(() => extractToolNames(agent.messages).includes(toolName));
};

const callTool = async (
  agent: BenchAgent,
  tool: string,
  args: Record<string, unknown>,
  requestId: string,
): Promise<BenchMessage> => {
  agent.socket.send(
    JSON.stringify({
      tool,
      request_id: requestId,
      args,
    }),
  );

  const response = await waitForMessage(
    agent.messages,
    (message) =>
      message.request_id === requestId && (message.status === 'ok' || message.status === 'error'),
  );

  if (response.status === 'error') {
    throw new Error(`Tool call failed for ${tool}: ${JSON.stringify(response.error)}`);
  }

  return response;
};

const runSingleMatch = async ({ seed, reconnectBeforeGuess = false }: MatchRunOptions) => {
  const startedAtMs = Date.now();
  const matchId = `bench-match-${seed}-${startedAtMs}`;

  await requestJson({
    url: `${ENGINE_URL}/matches/${matchId}/start`,
    method: 'POST',
    body: {
      gameId: 'prompt-injection-arena',
      seed,
    },
  });

  const attackerToken = await issueConnectToken(matchId, 'agent-1');
  const defenderToken = await issueConnectToken(matchId, 'agent-2');

  let reconnectCount = 0;

  const defender = await connectAgent({
    agentId: 'agent-2',
    connectToken: defenderToken,
  });

  let attacker = await connectAgent({
    agentId: 'agent-1',
    connectToken: attackerToken,
  });

  try {
    await waitForTool(attacker, 'send_message');
    await callTool(
      attacker,
      'send_message',
      { content: `attacker message for seed ${seed}` },
      `req-${seed}-attacker-send`,
    );

    await waitForTool(defender, 'respond');
    await callTool(
      defender,
      'respond',
      { content: `defender response for seed ${seed}` },
      `req-${seed}-defender-respond`,
    );

    if (reconnectBeforeGuess) {
      await closeSocket(attacker.socket);
      reconnectCount += 1;

      attacker = await connectAgent({
        agentId: 'agent-1',
        sessionId: attacker.sessionId,
      });
    }

    await waitForTool(attacker, 'check_secret');
    await callTool(
      attacker,
      'check_secret',
      { guess: expectedSecretFromSeed(seed) },
      `req-${seed}-attacker-guess`,
    );

    const attackerEnded = await waitForMessage(
      attacker.messages,
      (message) => message.type === 'match/ended',
    );
    await waitForMessage(defender.messages, (message) => message.type === 'match/ended');

    const winner = typeof attackerEnded.winner === 'string' ? attackerEnded.winner : '';
    const reason = typeof attackerEnded.reason === 'string' ? attackerEnded.reason : '';

    return {
      matchId,
      winner,
      reason,
      durationMs: Date.now() - startedAtMs,
      reconnectCount,
    } satisfies MatchRunResult;
  } finally {
    await Promise.allSettled([closeSocket(attacker.socket), closeSocket(defender.socket)]);
  }
};

const runBench = async (matchCount: number): Promise<MatchRunResult[]> => {
  const results: MatchRunResult[] = [];
  for (let index = 0; index < matchCount; index++) {
    const seed = 20_000 + index;
    const result = await runSingleMatch({ seed });
    results.push(result);
  }
  return results;
};

const describeBench = RUN_AGENT_BENCH ? describe : describe.skip;

describeBench('Agent battle bench', () => {
  it('runs multiple matches and returns aggregate results', async () => {
    expect(BENCH_MATCH_COUNT).toBeGreaterThan(0);

    const results = await runBench(BENCH_MATCH_COUNT);
    const reasons = new Map<string, number>();

    for (const result of results) {
      reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
    }

    console.table(
      results.map((result) => ({
        matchId: result.matchId,
        winner: result.winner,
        reason: result.reason,
        durationMs: result.durationMs,
        reconnectCount: result.reconnectCount,
      })),
    );
    console.log('result summary:', Object.fromEntries(reasons.entries()));

    expect(results).toHaveLength(BENCH_MATCH_COUNT);
    expect(results.every((result) => result.winner === 'agent-1')).toBe(true);
    expect(results.every((result) => result.reason === 'Secret leaked')).toBe(true);
  }, 120_000);

  it('supports reconnect and resume during a match', async () => {
    const result = await runSingleMatch({
      seed: 30_123,
      reconnectBeforeGuess: true,
    });

    expect(result.winner).toBe('agent-1');
    expect(result.reason).toBe('Secret leaked');
    expect(result.reconnectCount).toBe(1);
  }, 60_000);
});
