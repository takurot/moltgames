import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://localhost:8080/v1/ws';
const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8081';

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

const poll = async (fn: () => Promise<boolean>, timeout = 10000, interval = 250) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return true;
    } catch {
      // Ignore transient poll errors.
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const findRequestMessage = (
  messages: readonly unknown[],
  requestId: string,
): Record<string, unknown> | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.request_id === requestId) {
      return message;
    }
  }
  return null;
};

const waitForRequestMessage = async (
  messages: readonly unknown[],
  requestId: string,
  timeout = 10000,
) => {
  const found = await poll(
    async () => {
      const message = findRequestMessage(messages, requestId);
      return message?.status === 'ok' || message?.status === 'error';
    },
    timeout,
    200,
  );

  if (!found) {
    throw new Error(`Timed out waiting for request ${requestId}`);
  }

  const message = findRequestMessage(messages, requestId);
  if (message?.status === 'error') {
    const error = asRecord(message.error);
    throw new Error(
      `Request ${requestId} failed: ${JSON.stringify({
        code: error?.code,
        message: error?.message,
        retryable: error?.retryable,
      })}`,
    );
  }

  return message;
};

const extractConnectToken = (data: unknown): string => {
  const body = asRecord(data);
  const token = body?.connectToken;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Token response did not include connectToken');
  }
  return token;
};

describe('Bluff Dice E2E Verification', () => {
  it('completes a full 5-round match through gateway and engine', async () => {
    const gatewayHealth = await requestJson({
      url: `${GATEWAY_URL}/healthz`,
      method: 'GET',
    });
    expect(gatewayHealth.status).toBe(200);

    const engineHealth = await requestJson({
      url: `${ENGINE_URL}/healthz`,
      method: 'GET',
    });
    expect(engineHealth.status).toBe(200);

    const matchId = `e2e-bluff-dice-${Date.now()}`;
    await requestJson({
      url: `${ENGINE_URL}/matches/${matchId}/start`,
      method: 'POST',
      body: {
        gameId: 'bluff-dice',
        seed: 20260401,
      },
    });

    const token1Response = await requestJson({
      url: `${GATEWAY_URL}/v1/tokens`,
      method: 'POST',
      body: {
        matchId,
        agentId: 'agent-1',
      },
      headers: { Authorization: 'Bearer valid-token' },
    });
    const token2Response = await requestJson({
      url: `${GATEWAY_URL}/v1/tokens`,
      method: 'POST',
      body: {
        matchId,
        agentId: 'agent-2',
      },
      headers: { Authorization: 'Bearer valid-token' },
    });

    const token1 = extractConnectToken(token1Response.data);
    const token2 = extractConnectToken(token2Response.data);

    const agent1 = new WebSocket(`${GATEWAY_WS_URL}?connect_token=${token1}`, 'moltgame.v1');
    const agent2 = new WebSocket(`${GATEWAY_WS_URL}?connect_token=${token2}`, 'moltgame.v1');

    const agent1Messages: unknown[] = [];
    const agent2Messages: unknown[] = [];
    agent1.on('message', (data) => agent1Messages.push(JSON.parse(data.toString())));
    agent2.on('message', (data) => agent2Messages.push(JSON.parse(data.toString())));

    await Promise.all([
      new Promise((resolve) => agent1.on('open', resolve)),
      new Promise((resolve) => agent2.on('open', resolve)),
    ]);

    const sessionsReady = await poll(
      async () =>
        agent1Messages.some((message) => asRecord(message)?.type === 'session/ready') &&
        agent2Messages.some((message) => asRecord(message)?.type === 'session/ready'),
      10000,
      200,
    );
    expect(sessionsReady).toBe(true);

    let requestCounter = 0;
    const nextRequestId = (label: string) => `${label}-${++requestCounter}`;

    for (let round = 1; round <= 5; round += 1) {
      const bet1RequestId = nextRequestId(`bet-a1-r${round}`);
      agent1.send(
        JSON.stringify({
          tool: 'place_bet',
          request_id: bet1RequestId,
          args: { amount: 1 },
        }),
      );
      await waitForRequestMessage(agent1Messages, bet1RequestId);

      const bet2RequestId = nextRequestId(`bet-a2-r${round}`);
      agent2.send(
        JSON.stringify({
          tool: 'place_bet',
          request_id: bet2RequestId,
          args: { amount: 1 },
        }),
      );
      await waitForRequestMessage(agent2Messages, bet2RequestId);

      const activeAgentSocket = round % 2 === 1 ? agent1 : agent2;
      const activeAgentMessages = round % 2 === 1 ? agent1Messages : agent2Messages;
      const challengerSocket = round % 2 === 1 ? agent2 : agent1;
      const challengerMessages = round % 2 === 1 ? agent2Messages : agent1Messages;

      const bidRequestId = nextRequestId(`bid-r${round}`);
      activeAgentSocket.send(
        JSON.stringify({
          tool: 'make_bid',
          request_id: bidRequestId,
          args: { count: 10, face: 6 },
        }),
      );
      await waitForRequestMessage(activeAgentMessages, bidRequestId);

      const callRequestId = nextRequestId(`call-r${round}`);
      challengerSocket.send(
        JSON.stringify({
          tool: 'call_bluff',
          request_id: callRequestId,
          args: {},
        }),
      );
      const callMessage = await waitForRequestMessage(challengerMessages, callRequestId);
      const callResult = asRecord(asRecord(callMessage)?.result);
      expect(callResult?.status).toBe('resolved');
      expect(typeof callResult?.winner).toBe('string');
      expect(typeof callResult?.loser).toBe('string');
    }

    const ended = await poll(
      async () => agent1Messages.some((message) => asRecord(message)?.type === 'match/ended'),
      15000,
      200,
    );
    expect(ended).toBe(true);

    const endedMessage = asRecord(
      agent1Messages.find((message) => asRecord(message)?.type === 'match/ended') ?? null,
    );
    expect(endedMessage?.reason).toBe('All rounds completed');
    expect(typeof endedMessage?.winner === 'string' || endedMessage?.winner === undefined).toBe(
      true,
    );

    agent1.close();
    agent2.close();
  }, 60_000);
});
