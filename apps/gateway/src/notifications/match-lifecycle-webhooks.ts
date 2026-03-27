import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { getFirestore } from 'firebase-admin/firestore';

import type { Match } from '@moltgames/domain';

export type MatchLifecycleEventType = 'match.started' | 'match.ended';

export interface MatchLifecycleWebhookOutcome {
  winnerUid: string | null;
  winnerAgentId?: string | undefined;
  reason?: string | undefined;
}

export interface MatchLifecycleNotifier {
  notifyMatchStarted(match: Match): Promise<void>;
  notifyMatchEnded(match: Match, outcome: MatchLifecycleWebhookOutcome): Promise<void>;
}

export interface MatchLifecycleWebhookSubscription {
  uid: string;
  url: string;
  secret: string;
  enabled: boolean;
  subscribedEvents: MatchLifecycleEventType[];
}

export interface MatchLifecycleWebhookSubscriptionRepository {
  listSubscriptions(
    participantUids: readonly string[],
    eventType: MatchLifecycleEventType,
  ): Promise<MatchLifecycleWebhookSubscription[]>;
}

export class InMemoryMatchLifecycleWebhookSubscriptionRepository
  implements MatchLifecycleWebhookSubscriptionRepository
{
  constructor(private readonly subscriptions: MatchLifecycleWebhookSubscription[] = []) {}

  async listSubscriptions(
    participantUids: readonly string[],
    eventType: MatchLifecycleEventType,
  ): Promise<MatchLifecycleWebhookSubscription[]> {
    const allowedUids = new Set(participantUids);

    return this.subscriptions.filter(
      (subscription) =>
        allowedUids.has(subscription.uid) &&
        subscription.enabled &&
        subscription.subscribedEvents.includes(eventType),
    );
  }
}

interface StoredWebhookSubscription {
  enabled?: unknown;
  url?: unknown;
  secret?: unknown;
  subscribedEvents?: unknown;
}

const isMatchLifecycleEventType = (value: unknown): value is MatchLifecycleEventType =>
  value === 'match.started' || value === 'match.ended';

const isStoredWebhookSubscription = (value: unknown): value is StoredWebhookSubscription =>
  typeof value === 'object' && value !== null;

export class FirestoreMatchLifecycleWebhookSubscriptionRepository
  implements MatchLifecycleWebhookSubscriptionRepository
{
  private get db() {
    return getFirestore();
  }

  async listSubscriptions(
    participantUids: readonly string[],
    eventType: MatchLifecycleEventType,
  ): Promise<MatchLifecycleWebhookSubscription[]> {
    const uniqueUids = Array.from(new Set(participantUids)).filter((uid) => uid.length > 0);

    const snapshots = await Promise.all(
      uniqueUids.map((uid) =>
        this.db.collection('users').doc(uid).collection('webhooks').doc('match-lifecycle').get(),
      ),
    );

    return snapshots.flatMap((snapshot, index) => {
      const uid = uniqueUids[index];
      if (uid === undefined) {
        return [];
      }

      if (!snapshot.exists) {
        return [];
      }

      const payload = snapshot.data();
      if (!isStoredWebhookSubscription(payload)) {
        return [];
      }

      const enabled = payload.enabled === true;
      const url = typeof payload.url === 'string' ? payload.url.trim() : '';
      const secret = typeof payload.secret === 'string' ? payload.secret : '';
      const subscribedEvents = Array.isArray(payload.subscribedEvents)
        ? payload.subscribedEvents.filter(isMatchLifecycleEventType)
        : [];

      if (
        !enabled ||
        url.length === 0 ||
        secret.length === 0 ||
        !subscribedEvents.includes(eventType)
      ) {
        return [];
      }

      return [
        {
          uid,
          url,
          secret,
          enabled,
          subscribedEvents,
        },
      ];
    });
  }
}

export interface MatchLifecycleWebhookDeliveryRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface MatchLifecycleWebhookDeliveryResponse {
  ok: boolean;
  status: number;
}

export interface MatchLifecycleWebhookSubscriptionDelivery {
  send(
    request: MatchLifecycleWebhookDeliveryRequest,
  ): Promise<MatchLifecycleWebhookDeliveryResponse>;
}

export class FetchMatchLifecycleWebhookDelivery
  implements MatchLifecycleWebhookSubscriptionDelivery
{
  async send(
    request: MatchLifecycleWebhookDeliveryRequest,
  ): Promise<MatchLifecycleWebhookDeliveryResponse> {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });

    return { ok: response.ok, status: response.status };
  }
}

interface LoggerLike {
  info(msg: string): void;
  info(obj: object, msg?: string): void;
  warn(msg: string): void;
  warn(obj: object, msg?: string): void;
  error(msg: string): void;
  error(obj: object, msg?: string): void;
}

export interface MatchLifecycleWebhookServiceOptions {
  subscriptionRepository: MatchLifecycleWebhookSubscriptionRepository;
  delivery?: MatchLifecycleWebhookSubscriptionDelivery;
  retryBaseDelayMs?: number;
  maxAttempts?: number;
  log?: LoggerLike;
}

interface MatchLifecycleWebhookEventPayload {
  id: string;
  type: MatchLifecycleEventType;
  occurredAt: string;
  match: Match;
  outcome?: MatchLifecycleWebhookOutcome | undefined;
}

const noopLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const shouldRetry = (status: number): boolean => status === 429 || status >= 500;

export class MatchLifecycleWebhookService implements MatchLifecycleNotifier {
  private readonly delivery: MatchLifecycleWebhookSubscriptionDelivery;
  private readonly retryBaseDelayMs: number;
  private readonly maxAttempts: number;
  private readonly log: LoggerLike;

  constructor(private readonly options: MatchLifecycleWebhookServiceOptions) {
    this.delivery = options.delivery ?? new FetchMatchLifecycleWebhookDelivery();
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.log = options.log ?? noopLogger;
  }

  async notifyMatchStarted(match: Match): Promise<void> {
    await this.dispatch({
      id: randomUUID(),
      type: 'match.started',
      occurredAt: match.startedAt ?? new Date().toISOString(),
      match,
    });
  }

  async notifyMatchEnded(match: Match, outcome: MatchLifecycleWebhookOutcome): Promise<void> {
    await this.dispatch({
      id: randomUUID(),
      type: 'match.ended',
      occurredAt: match.endedAt ?? new Date().toISOString(),
      match,
      outcome,
    });
  }

  private async dispatch(payload: MatchLifecycleWebhookEventPayload): Promise<void> {
    const participantUids = payload.match.participants.map((participant) => participant.uid);
    const subscriptions = await this.options.subscriptionRepository.listSubscriptions(
      participantUids,
      payload.type,
    );

    await Promise.all(
      subscriptions.map(async (subscription) => {
        const body = JSON.stringify(payload);
        const timestamp = payload.occurredAt;
        const signature = `sha256=${createHmac('sha256', subscription.secret)
          .update(`${timestamp}.${body}`)
          .digest('hex')}`;
        const request: MatchLifecycleWebhookDeliveryRequest = {
          url: subscription.url,
          headers: {
            'content-type': 'application/json',
            'x-moltgames-delivery-id': payload.id,
            'x-moltgames-event': payload.type,
            'x-moltgames-signature': signature,
            'x-moltgames-timestamp': timestamp,
            'x-moltgames-user-id': subscription.uid,
          },
          body,
        };

        await this.deliverWithRetry(request);
      }),
    );
  }

  private async deliverWithRetry(request: MatchLifecycleWebhookDeliveryRequest): Promise<void> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.delivery.send(request);
        if (response.ok) {
          this.log.info(
            {
              deliveryId: request.headers['x-moltgames-delivery-id'],
              event: request.headers['x-moltgames-event'],
              status: response.status,
              url: request.url,
            },
            'Delivered match lifecycle webhook',
          );
          return;
        }

        if (!shouldRetry(response.status) || attempt === this.maxAttempts) {
          this.log.warn(
            {
              attempt,
              deliveryId: request.headers['x-moltgames-delivery-id'],
              status: response.status,
              url: request.url,
            },
            'Match lifecycle webhook delivery was not acknowledged',
          );
          return;
        }
      } catch (error) {
        if (attempt === this.maxAttempts) {
          this.log.error(
            {
              attempt,
              deliveryId: request.headers['x-moltgames-delivery-id'],
              error,
              url: request.url,
            },
            'Failed to deliver match lifecycle webhook',
          );
          return;
        }
      }

      await delay(this.retryBaseDelayMs * 2 ** (attempt - 1));
    }
  }
}

export class NoopMatchLifecycleNotifier implements MatchLifecycleNotifier {
  async notifyMatchStarted(_match: Match): Promise<void> {}

  async notifyMatchEnded(
    _match: Match,
    _outcome: MatchLifecycleWebhookOutcome,
  ): Promise<void> {}
}
