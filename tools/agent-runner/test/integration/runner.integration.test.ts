import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { Runner } from '../../src/runner.js';

const waitFor = async (
  condition: () => boolean,
  timeoutMs = 3_000,
  intervalMs = 25,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
};

const createServerUrl = (port: number): string => `ws://127.0.0.1:${port}/v1/ws`;

describe('Runner integration', () => {
  const servers = new Set<WebSocketServer>();

  afterEach(async () => {
    await Promise.all(
      [...servers].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            for (const client of server.clients) {
              client.terminate();
            }
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }

              resolve();
            });
          }),
      ),
    );
    servers.clear();
  });

  it('backs off before retrying after a retryable SERVICE_UNAVAILABLE tool response', async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.add(server);

    const port = (server.address() as { port: number }).port;
    const requestTimes: number[] = [];
    let responseCount = 0;
    let plannedActions = 0;

    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'session/ready', session_id: 'session-1' }));
      socket.send(
        JSON.stringify({
          type: 'tools/list',
          tools: [
            {
              name: 'send_message',
              description: 'Send a message',
              version: '1.0.0',
              inputSchema: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                },
                required: ['content'],
                additionalProperties: false,
              },
            },
          ],
        }),
      );

      socket.on('message', (raw) => {
        requestTimes.push(Date.now());
        const payload = JSON.parse(raw.toString()) as { request_id: string };
        responseCount += 1;

        if (responseCount === 1) {
          socket.send(
            JSON.stringify({
              request_id: payload.request_id,
              status: 'error',
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'Please retry later',
                retryable: true,
              },
            }),
          );
          return;
        }

        socket.send(
          JSON.stringify({
            request_id: payload.request_id,
            status: 'ok',
            result: { accepted: true },
          }),
        );
      });
    });

    const runner = new Runner({
      url: createServerUrl(port),
      token: 'connect-token',
      responseRetryInitialDelayMs: 75,
      responseRetryMaxDelayMs: 150,
      planner: {
        decide: async () => {
          if (plannedActions >= 2) {
            return null;
          }

          plannedActions += 1;
          return {
            tool: 'send_message',
            args: { content: 'hello' },
          };
        },
      },
    });

    try {
      await runner.connect();
      await waitFor(() => requestTimes.length >= 2);

      expect(requestTimes).toHaveLength(2);
      expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(70);
    } finally {
      runner.close();
    }
  });

  it('stops sending new actions after DRAINING until the session reconnects', async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.add(server);

    const port = (server.address() as { port: number }).port;
    const sentTools: string[] = [];
    let connectionCount = 0;
    let sendMessageDecisions = 0;
    let respondDecisions = 0;

    server.on('connection', (socket, request) => {
      connectionCount += 1;
      const url = new URL(request.url ?? '/', createServerUrl(port));
      const isResumed = url.searchParams.get('session_id') === 'session-1';

      socket.send(
        JSON.stringify({
          type: isResumed ? 'session/resumed' : 'session/ready',
          session_id: 'session-1',
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'tools/list',
          tools: [
            {
              name: isResumed ? 'respond' : 'send_message',
              description: 'Tool',
              version: '1.0.0',
              inputSchema: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                },
                required: ['content'],
                additionalProperties: false,
              },
            },
          ],
        }),
      );

      socket.on('message', (raw) => {
        const payload = JSON.parse(raw.toString()) as { tool: string; request_id: string };
        sentTools.push(payload.tool);
        socket.send(
          JSON.stringify({
            request_id: payload.request_id,
            status: 'ok',
            result: { accepted: true },
          }),
        );

        if (!isResumed) {
          socket.send(JSON.stringify({ type: 'DRAINING', reconnect_after_ms: 0 }));
          socket.send(
            JSON.stringify({
              type: 'tools/list_changed',
              tools: [
                {
                  name: 'respond',
                  description: 'Tool',
                  version: '1.0.0',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      content: { type: 'string' },
                    },
                    required: ['content'],
                    additionalProperties: false,
                  },
                },
              ],
            }),
          );
          setTimeout(() => {
            socket.close(1012, 'draining');
          }, 10);
        }
      });
    });

    const runner = new Runner({
      url: createServerUrl(port),
      token: 'connect-token',
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 20,
      planner: {
        decide: async ({ tools }) => {
          if (tools.some((tool) => tool.name === 'send_message') && sendMessageDecisions === 0) {
            sendMessageDecisions += 1;
            return { tool: 'send_message', args: { content: 'hello' } };
          }

          if (tools.some((tool) => tool.name === 'respond') && respondDecisions === 0) {
            respondDecisions += 1;
            return { tool: 'respond', args: { content: 'ack' } };
          }

          return null;
        },
      },
    });

    try {
      await runner.connect();
      await waitFor(() => sentTools.length >= 2);

      expect(connectionCount).toBeGreaterThanOrEqual(2);
      expect(sentTools).toEqual(['send_message', 'respond']);
    } finally {
      runner.close();
    }
  });
});
