import { describe, expect, it, vi, beforeEach } from 'vitest';

import { CloudTasksRatingJobQueue } from '../../../src/rating/cloud-tasks-queue.js';

const config = {
  projectId: 'my-project',
  location: 'us-central1',
  queueName: 'rating-updates',
  gatewayBaseUrl: 'https://gateway.example.com',
  authToken: 'internal-secret',
};

const job = {
  matchId: 'match-abc-123',
  participants: ['user-1', 'user-2'],
  winnerUid: 'user-1',
  endedAt: '2026-03-14T10:00:00.000Z',
};

const mockGetAccessToken = vi.fn().mockResolvedValue('gcp-access-token');

describe('CloudTasksRatingJobQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('sends a task to Cloud Tasks on enqueue', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const queue = new CloudTasksRatingJobQueue(config, mockGetAccessToken);
    await queue.enqueue(job);

    expect(mockGetAccessToken).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://cloudtasks.googleapis.com/v2/projects/my-project/locations/us-central1/queues/rating-updates/tasks',
    );
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer gcp-access-token',
    );

    const body = JSON.parse(init.body as string) as {
      task: {
        name: string;
        httpRequest: {
          httpMethod: string;
          url: string;
          headers: Record<string, string>;
          body: string;
        };
      };
    };
    expect(body.task.name).toContain('match-abc-123');
    expect(body.task.httpRequest.url).toBe(
      'https://gateway.example.com/internal/tasks/ratings/match-finished',
    );
    expect(body.task.httpRequest.headers['Authorization']).toBe('Bearer internal-secret');

    const decodedPayload = JSON.parse(Buffer.from(body.task.httpRequest.body, 'base64').toString());
    expect(decodedPayload).toEqual(job);
  });

  it('treats 409 (task already exists) as success for idempotency', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(new Response('{"error":"already exists"}', { status: 409 }));

    const queue = new CloudTasksRatingJobQueue(config, mockGetAccessToken);
    await expect(queue.enqueue(job)).resolves.not.toThrow();
  });

  it('throws on non-409 error responses', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }));

    const queue = new CloudTasksRatingJobQueue(config, mockGetAccessToken);
    await expect(queue.enqueue(job)).rejects.toThrow('Failed to enqueue Cloud Tasks task: 503');
  });

  it('throws when access token retrieval fails', async () => {
    mockGetAccessToken.mockRejectedValueOnce(new Error('Metadata server unavailable'));

    const queue = new CloudTasksRatingJobQueue(config, mockGetAccessToken);
    await expect(queue.enqueue(job)).rejects.toThrow('Metadata server unavailable');
  });
});
