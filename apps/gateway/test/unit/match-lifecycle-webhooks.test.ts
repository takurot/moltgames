import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryMatchLifecycleWebhookSubscriptionRepository,
  MatchLifecycleWebhookService,
  type MatchLifecycleWebhookSubscriptionDelivery,
} from '../../src/notifications/match-lifecycle-webhooks.js';

describe('MatchLifecycleWebhookService', () => {
  it('sends signed match.start payloads to enabled subscriptions', async () => {
    const delivery: MatchLifecycleWebhookSubscriptionDelivery = {
      send: vi.fn(async () => ({ ok: true, status: 202 })),
    };
    const repository = new InMemoryMatchLifecycleWebhookSubscriptionRepository([
      {
        uid: 'player-1',
        url: 'https://example.com/hooks/match',
        secret: 'top-secret',
        enabled: true,
        subscribedEvents: ['match.started', 'match.ended'],
      },
    ]);
    const service = new MatchLifecycleWebhookService({
      subscriptionRepository: repository,
      delivery,
      retryBaseDelayMs: 1,
      maxAttempts: 3,
    });

    await service.notifyMatchStarted({
      matchId: 'match-1',
      gameId: 'prompt-injection-arena',
      status: 'IN_PROGRESS',
      participants: [
        { uid: 'player-1', agentId: 'agent-1', role: 'PLAYER' },
        { uid: 'player-2', agentId: 'agent-2', role: 'PLAYER' },
      ],
      ruleId: 'prompt-injection-arena',
      ruleVersion: '1.1.0',
      region: 'us-central1',
      startedAt: '2026-03-28T00:00:00.000Z',
    });

    expect(delivery.send).toHaveBeenCalledTimes(1);
    const [request] = vi.mocked(delivery.send).mock.calls[0];
    expect(request.url).toBe('https://example.com/hooks/match');
    expect(request.headers['x-moltgames-event']).toBe('match.started');
    expect(request.headers['x-moltgames-signature']).toMatch(/^sha256=/);

    const expectedSignature = `sha256=${createHmac('sha256', 'top-secret')
      .update(`${request.headers['x-moltgames-timestamp']}.${request.body}`)
      .digest('hex')}`;
    expect(request.headers['x-moltgames-signature']).toBe(expectedSignature);
  });

  it('retries failed match.ended deliveries with exponential backoff', async () => {
    const delivery: MatchLifecycleWebhookSubscriptionDelivery = {
      send: vi
        .fn<MatchLifecycleWebhookSubscriptionDelivery['send']>()
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: false, status: 502 })
        .mockResolvedValueOnce({ ok: true, status: 200 }),
    };
    const repository = new InMemoryMatchLifecycleWebhookSubscriptionRepository([
      {
        uid: 'player-1',
        url: 'https://example.com/hooks/match',
        secret: 'top-secret',
        enabled: true,
        subscribedEvents: ['match.ended'],
      },
    ]);
    const service = new MatchLifecycleWebhookService({
      subscriptionRepository: repository,
      delivery,
      retryBaseDelayMs: 1,
      maxAttempts: 3,
    });

    await service.notifyMatchEnded(
      {
        matchId: 'match-1',
        gameId: 'prompt-injection-arena',
        status: 'FINISHED',
        participants: [{ uid: 'player-1', agentId: 'agent-1', role: 'PLAYER' }],
        ruleId: 'prompt-injection-arena',
        ruleVersion: '1.1.0',
        region: 'us-central1',
        startedAt: '2026-03-28T00:00:00.000Z',
        endedAt: '2026-03-28T00:01:00.000Z',
      },
      {
        winnerAgentId: 'agent-1',
        winnerUid: 'player-1',
        reason: 'finished',
      },
    );

    expect(delivery.send).toHaveBeenCalledTimes(3);
  });
});
