import type { MatchResultJob } from './service.js';

export interface CloudTasksConfig {
  projectId: string;
  location: string;
  queueName: string;
  gatewayBaseUrl: string;
  authToken: string;
}

/**
 * Retrieves a GCP access token from the instance metadata server.
 * This works on Cloud Run and other GCP environments using ADC.
 */
export const getGcpAccessToken = async (): Promise<string> => {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  );
  if (!response.ok) {
    throw new Error(`Failed to get GCP access token: ${response.status}`);
  }
  const data = (await response.json()) as { access_token: string };
  return data.access_token;
};

/**
 * Enqueues a rating update job as a Cloud Tasks HTTP task.
 * The task targets the internal /internal/tasks/ratings/match-finished endpoint.
 * Uses matchId as the task name for idempotency.
 */
export class CloudTasksRatingJobQueue {
  private readonly tasksApiUrl: string;
  private readonly taskNamePrefix: string;

  constructor(
    private config: CloudTasksConfig,
    private getAccessToken: () => Promise<string> = getGcpAccessToken,
  ) {
    const { projectId, location, queueName } = config;
    this.tasksApiUrl = `https://cloudtasks.googleapis.com/v2/projects/${projectId}/locations/${location}/queues/${queueName}/tasks`;
    this.taskNamePrefix = `projects/${projectId}/locations/${location}/queues/${queueName}/tasks`;
  }

  async enqueue(job: MatchResultJob): Promise<void> {
    const accessToken = await this.getAccessToken();
    const encodedBody = Buffer.from(JSON.stringify(job)).toString('base64');

    const taskBody = {
      task: {
        name: `${this.taskNamePrefix}/${job.matchId}`,
        httpRequest: {
          httpMethod: 'POST',
          url: `${this.config.gatewayBaseUrl}/internal/tasks/ratings/match-finished`,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.authToken}`,
          },
          body: encodedBody,
        },
      },
    };

    const response = await fetch(this.tasksApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(taskBody),
    });

    // 409 means the task already exists (same matchId), treat as idempotent success
    if (response.status === 409) {
      return;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`Failed to enqueue Cloud Tasks task: ${response.status} ${errorText}`);
    }
  }
}
