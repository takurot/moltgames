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

const poll = async (fn: () => Promise<boolean>, timeout = 10000, interval = 500) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return true;
    } catch {
      // Ignore poll errors and continue
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
};

const waitForToolOk = async (messages: unknown[], requestId: string, timeout = 10000) =>
  poll(
    async () =>
      messages.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          (message as { request_id?: unknown; status?: unknown }).request_id === requestId &&
          (message as { request_id?: unknown; status?: unknown }).status === 'ok',
      ),
    timeout,
    200,
  );

describe('Dilemma Poker E2E Verification', () => {
  it('completes a full 5-round match of Dilemma Poker', async () => {
    // 1. Check health
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

    // 2. Create a match
    const matchId = `e2e-dilemma-${Date.now()}`;
    await requestJson({
      url: `${ENGINE_URL}/matches/${matchId}/start`,
      method: 'POST',
      body: {
        gameId: 'dilemma-poker',
        seed: 42,
      },
    });

    // 3. Issue tokens for 2 agents
    const token1Response = await requestJson({
      url: `${GATEWAY_URL}/v1/tokens`,
      method: 'POST',
      body: {
        matchId,
        agentId: 'agent-1',
      },
      headers: { Authorization: 'Bearer valid-token' },
    });
    if (
      typeof token1Response.data !== 'object' ||
      token1Response.data === null ||
      typeof (token1Response.data as { connectToken?: unknown }).connectToken !== 'string'
    ) {
      throw new Error('Token response for agent-1 did not include connectToken');
    }
    const token1 = (token1Response.data as { connectToken: string }).connectToken;

    const token2Response = await requestJson({
      url: `${GATEWAY_URL}/v1/tokens`,
      method: 'POST',
      body: {
        matchId,
        agentId: 'agent-2',
      },
      headers: { Authorization: 'Bearer valid-token' },
    });
    if (
      typeof token2Response.data !== 'object' ||
      token2Response.data === null ||
      typeof (token2Response.data as { connectToken?: unknown }).connectToken !== 'string'
    ) {
      throw new Error('Token response for agent-2 did not include connectToken');
    }
    const token2 = (token2Response.data as { connectToken: string }).connectToken;

    // 4. Connect agents via WebSocket
    const agent1 = new WebSocket(`${GATEWAY_WS_URL}?connect_token=${token1}`, 'moltgame.v1');
    const agent2 = new WebSocket(`${GATEWAY_WS_URL}?connect_token=${token2}`, 'moltgame.v1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent1Messages: any[] = [];
    agent1.on('message', (data) => agent1Messages.push(JSON.parse(data.toString())));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent2Messages: any[] = [];
    agent2.on('message', (data) => agent2Messages.push(JSON.parse(data.toString())));

    await Promise.all([
      new Promise((resolve) => agent1.on('open', resolve)),
      new Promise((resolve) => agent2.on('open', resolve)),
    ]);

    // 5. Wait for session ready
    expect(await poll(async () => agent1Messages.some((m) => m.type === 'session/ready'))).toBe(
      true,
    );
    expect(await poll(async () => agent2Messages.some((m) => m.type === 'session/ready'))).toBe(
      true,
    );

    // 6. Play 5 rounds
    let reqCounter = 0;
    const nextReqId = () => `req-dp-${++reqCounter}`;

    for (let round = 1; round <= 5; round++) {
      // Determine turn order: odd rounds agent1 first, even rounds agent2 first
      const firstAgent = round % 2 === 1 ? agent1 : agent2;
      const secondAgent = round % 2 === 1 ? agent2 : agent1;
      const firstMessages = round % 2 === 1 ? agent1Messages : agent2Messages;
      const secondMessages = round % 2 === 1 ? agent2Messages : agent1Messages;

      // --- Negotiation Phase ---
      // First agent negotiates
      const negReq1 = nextReqId();
      firstAgent.send(
        JSON.stringify({
          tool: 'negotiate',
          request_id: negReq1,
          args: { message: `Round ${round}: Let us cooperate!` },
        }),
      );
      expect(await waitForToolOk(firstMessages, negReq1)).toBe(true);

      // Second agent negotiates
      const negReq2 = nextReqId();
      secondAgent.send(
        JSON.stringify({
          tool: 'negotiate',
          request_id: negReq2,
          args: { message: `Round ${round}: Agreed, let us cooperate.` },
        }),
      );
      expect(await waitForToolOk(secondMessages, negReq2)).toBe(true);

      // --- Action Phase ---
      // First agent commits action
      const actReq1 = nextReqId();
      firstAgent.send(
        JSON.stringify({
          tool: 'commit_action',
          request_id: actReq1,
          args: { action: 'cooperate' },
        }),
      );
      expect(await waitForToolOk(firstMessages, actReq1)).toBe(true);

      // Second agent commits action — defect on round 3 for variety
      const actReq2 = nextReqId();
      const secondAction = round === 3 ? 'defect' : 'cooperate';
      secondAgent.send(
        JSON.stringify({
          tool: 'commit_action',
          request_id: actReq2,
          args: { action: secondAction },
        }),
      );
      expect(await waitForToolOk(secondMessages, actReq2)).toBe(true);
    }

    // 7. Verify match finished
    expect(await poll(async () => agent1Messages.some((m) => m.type === 'match/ended'))).toBe(true);
    const matchEnded = agent1Messages.find((m: { type: string }) => m.type === 'match/ended');
    expect(matchEnded.reason).toBe('Max rounds reached');

    // Verify chip totals make sense:
    // Rounds 1,2,4,5: both cooperate => 3+3 each round = 12 each from those rounds
    // Round 3: first cooperates, second defects => first gets 0, second gets 5
    // But who is "first" in round 3? Round 3 is odd, so agent1 goes first.
    // agent1: 3+3+0+3+3 = 12 chips
    // agent2: 3+3+5+3+3 = 17 chips
    // So agent2 should win
    expect(matchEnded.winner).toBe('agent-2');

    agent1.close();
    agent2.close();
  }, 60_000);
});
