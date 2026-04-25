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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

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

const extractConnectToken = (data: unknown): string => {
  const body = asRecord(data);
  const token = body?.connectToken;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Token response did not include connectToken');
  }
  return token;
};

const waitForMessage = async (
  messages: readonly unknown[],
  predicate: (m: unknown) => boolean,
  timeout = 10000,
): Promise<unknown> => {
  const found = await poll(async () => messages.some(predicate), timeout, 200);
  if (!found) {
    throw new Error('Timed out waiting for message');
  }
  return messages.find(predicate);
};

describe('Match Activation (Issue #73) E2E', () => {
  it('delayed second-agent connection does not cause TURN_EXPIRED on first move', async () => {
    const gatewayHealth = await requestJson({ url: `${GATEWAY_URL}/healthz`, method: 'GET' });
    expect(gatewayHealth.status).toBe(200);

    const engineHealth = await requestJson({ url: `${ENGINE_URL}/healthz`, method: 'GET' });
    expect(engineHealth.status).toBe(200);

    const matchId = `e2e-activation-delay-${Date.now()}`;
    await requestJson({
      url: `${ENGINE_URL}/matches/${matchId}/start`,
      method: 'POST',
      body: { gameId: 'prompt-injection-arena', seed: 42 },
    });

    const token1Response = await requestJson({
      url: `${GATEWAY_URL}/v1/tokens`,
      method: 'POST',
      body: { matchId, agentId: 'agent-1' },
      headers: { Authorization: 'Bearer valid-token' },
    });
    const token2Response = await requestJson({
      url: `${GATEWAY_URL}/v1/tokens`,
      method: 'POST',
      body: { matchId, agentId: 'agent-2' },
      headers: { Authorization: 'Bearer valid-token' },
    });

    const token1 = extractConnectToken(token1Response.data);
    const token2 = extractConnectToken(token2Response.data);

    // Connect agent-1 only
    const agent1 = new WebSocket(`${GATEWAY_WS_URL}?connect_token=${token1}`, 'moltgame.v1');
    const agent1Messages: unknown[] = [];
    agent1.on('message', (data) => agent1Messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => agent1.on('open', resolve));

    // Wait for match to reach WAITING_AGENT_CONNECT before second agent joins
    const reachedWaiting = await poll(async () => {
      const res = await requestJson({ url: `${GATEWAY_URL}/v1/matches/${matchId}`, method: 'GET' });
      return asRecord(asRecord(res.data)?.match)?.status === 'WAITING_AGENT_CONNECT';
    }, 5000);
    expect(reachedWaiting).toBe(true);

    // Simulate connection delay (2 seconds) before second agent joins
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const agent2 = new WebSocket(`${GATEWAY_WS_URL}?connect_token=${token2}`, 'moltgame.v1');
    const agent2Messages: unknown[] = [];
    agent2.on('message', (data) => agent2Messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => agent2.on('open', resolve));

    // Both agents should receive session/ready after activation
    const isSessionReady = (m: unknown) => asRecord(m)?.type === 'session/ready';
    await Promise.all([
      waitForMessage(agent1Messages, isSessionReady),
      waitForMessage(agent2Messages, isSessionReady),
    ]);

    // Match should now be IN_PROGRESS
    const statusRes = await requestJson({
      url: `${GATEWAY_URL}/v1/matches/${matchId}`,
      method: 'GET',
    });
    const matchStatus = asRecord(asRecord(statusRes.data)?.match)?.status;
    expect(matchStatus).toBe('IN_PROGRESS');

    // Agent-1 (attacker) makes a move — must NOT get TURN_EXPIRED despite the 2-second delay
    const moveRequestId = 'req-activation-1';
    agent1.send(
      JSON.stringify({
        tool: 'send_message',
        request_id: moveRequestId,
        args: { content: 'Hello after activation delay' },
      }),
    );

    const isMoveResponse = (m: unknown) =>
      asRecord(m)?.request_id === moveRequestId &&
      (asRecord(m)?.status === 'ok' || asRecord(m)?.status === 'error');

    const moveResponse = asRecord(await waitForMessage(agent1Messages, isMoveResponse, 10000));
    expect(moveResponse?.status).not.toBe('error');

    // Explicitly verify it was not a TURN_EXPIRED error
    if (moveResponse?.status === 'error') {
      const error = asRecord(moveResponse.error);
      expect(error?.code).not.toBe('TURN_EXPIRED');
    }

    agent1.close();
    agent2.close();
  }, 30_000);

  it('match status is WAITING_AGENT_CONNECT (not IN_PROGRESS) after only one agent connects', async () => {
    const gatewayHealth = await requestJson({ url: `${GATEWAY_URL}/healthz`, method: 'GET' });
    expect(gatewayHealth.status).toBe(200);

    const matchId = `e2e-activation-single-${Date.now()}`;
    await requestJson({
      url: `${ENGINE_URL}/matches/${matchId}/start`,
      method: 'POST',
      body: { gameId: 'prompt-injection-arena', seed: 99 },
    });

    const token1Response = await requestJson({
      url: `${GATEWAY_URL}/v1/tokens`,
      method: 'POST',
      body: { matchId, agentId: 'agent-1' },
      headers: { Authorization: 'Bearer valid-token' },
    });
    const token1 = extractConnectToken(token1Response.data);

    const agent1 = new WebSocket(`${GATEWAY_WS_URL}?connect_token=${token1}`, 'moltgame.v1');
    await new Promise<void>((resolve) => agent1.on('open', resolve));

    const reachedWaiting = await poll(async () => {
      const res = await requestJson({ url: `${GATEWAY_URL}/v1/matches/${matchId}`, method: 'GET' });
      return asRecord(asRecord(res.data)?.match)?.status === 'WAITING_AGENT_CONNECT';
    }, 5000);
    expect(reachedWaiting).toBe(true);

    agent1.close();
  }, 15_000);
});
