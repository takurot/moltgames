import { randomUUID, timingSafeEqual } from 'node:crypto';

import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Redis } from 'ioredis';
import {
  isMcpToolDefinition,
  isToolCallResponse,
  parseToolCallRequest,
  type MCPToolDefinition,
  type ToolCallResponse,
} from '@moltgames/mcp-protocol';
import type { JsonValue, TurnEvent, TurnEventSeat } from '@moltgames/domain';
import WebSocket, { type RawData } from 'ws';

import {
  ConnectTokenError,
  ConnectTokenService,
  createConnectTokenApi,
  InMemoryConnectTokenSessionStore,
  type FirebaseIdTokenVerifier,
  type VerifiedFirebaseIdToken,
} from './index.js';
import { loggerOptions } from './logger.js';
import { RedisConnectTokenSessionStore } from './auth/redis-store.js';
import { FirebaseAuthVerifier } from './auth/firebase-verifier.js';
import { EngineClient } from './engine/client.js';
import {
  FirestoreRatingRepository,
  InMemoryRatingRepository,
  type RatingRepository,
} from './rating/repository.js';
import { RatingService, type MatchResultJob } from './rating/service.js';
import { RedisLeaderboardCache, type LeaderboardCache } from './rating/leaderboard-cache.js';
import { CloudTasksRatingJobQueue, getGcpAccessToken } from './rating/cloud-tasks-queue.js';
import {
  FirestoreReplayRepository,
  InMemoryReplayRepository,
  type ReplayRepository,
} from './replay/repository.js';
import {
  FirebaseReplayStorage,
  InMemoryReplayStorage,
  type ReplayStorage,
} from './replay/storage.js';
import { ReplayService } from './replay/service.js';
import { applyRedaction } from './replay/redaction.js';

class MockFirebaseVerifier implements FirebaseIdTokenVerifier {
  async verifyIdToken(_idToken: string): Promise<VerifiedFirebaseIdToken> {
    return {
      uid: 'test-user',
      providerId: 'google.com',
      customClaims: {},
    };
  }
}

interface SpectatorAuthorizationInput {
  matchId: string;
  viewerUid: string | null;
  claims: VerifiedFirebaseIdToken | null;
}

interface SpectatorAuthorizationResult {
  allowed: boolean;
  reason?: string;
}

export interface SpectatorAccessController {
  authorize(
    input: SpectatorAuthorizationInput,
  ): Promise<SpectatorAuthorizationResult> | SpectatorAuthorizationResult;
}

interface SpectatorSession {
  id: string;
  matchId: string;
  viewerUid: string | null;
  socket: WebSocket;
}

interface EngineTurnEventContext {
  phase: string;
  seat: TurnEventSeat;
  scoreDiffBefore: number;
  scoreDiffAfter: number;
  ruleVersion: string;
}

type GatewayEngineToolCallResponse = ToolCallResponse & {
  turnEventContext?: EngineTurnEventContext;
};

export interface AppOptions {
  redis?: Redis;
  verifier?: FirebaseIdTokenVerifier;
  engineClient?: GatewayEngineClient;
  reconnectGraceMs?: number;
  ratingRepository?: RatingRepository;
  leaderboardCache?: LeaderboardCache;
  internalTaskAuthToken?: string;
  replayRepository?: ReplayRepository;
  replayStorage?: ReplayStorage;
  spectatorAccessController?: SpectatorAccessController;
}

export interface GatewayEngineClient {
  getTools(matchId: string, agentId: string): Promise<MCPToolDefinition[]>;
  callTool(
    matchId: string,
    request: {
      tool: string;
      request_id: string;
      args: Record<string, JsonValue>;
      actor: string;
    },
  ): Promise<GatewayEngineToolCallResponse>;
  getMatchMeta(matchId: string): Promise<{ gameId: string; ruleVersion?: string | null } | null>;
}

interface AgentSession {
  id: string;
  uid: string;
  matchId: string;
  agentId: string;
  tools: MCPToolDefinition[];
  toolsFingerprint: string;
  socket: WebSocket | null;
  forfeitTimer: NodeJS.Timeout | null;
  reconnectDeadlineAtMs: number | null;
}

interface RatingJobQueue {
  enqueue(job: MatchResultJob): Promise<void>;
}

const SUPPORTED_WS_PROTOCOL = 'moltgame.v1';
const DEFAULT_ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8081';
const DEFAULT_RECONNECT_GRACE_MS = 20_000;
const RECONNECT_BACKOFF_INITIAL_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 8_000;
const READ_ONLY_SPECTATOR_ERROR = {
  type: 'error',
  error: {
    code: 'INVALID_REQUEST',
    message: 'Spectator connections are read-only',
    retryable: false,
  },
} as const;

const toSessionLookupKey = (matchId: string, agentId: string): string => `${matchId}:${agentId}`;
const FALLBACK_FIRST_SEAT = 'first' as const;

const isTurnEventSeat = (value: unknown): value is TurnEventSeat =>
  value === 'first' || value === 'second';

const isEngineTurnEventContext = (value: unknown): value is EngineTurnEventContext => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.phase === 'string' &&
    isTurnEventSeat(candidate.seat) &&
    typeof candidate.scoreDiffBefore === 'number' &&
    Number.isFinite(candidate.scoreDiffBefore) &&
    typeof candidate.scoreDiffAfter === 'number' &&
    Number.isFinite(candidate.scoreDiffAfter) &&
    typeof candidate.ruleVersion === 'string' &&
    candidate.ruleVersion.length > 0
  );
};

const extractTurnEventContext = (value: unknown): EngineTurnEventContext | null => {
  if (
    typeof value === 'object' &&
    value !== null &&
    'turnEventContext' in value &&
    isEngineTurnEventContext((value as { turnEventContext?: unknown }).turnEventContext)
  ) {
    return (value as { turnEventContext: EngineTurnEventContext }).turnEventContext;
  }

  return null;
};

const stripTurnEventContext = (response: GatewayEngineToolCallResponse): ToolCallResponse => {
  const clientResponse = { ...response };
  delete clientResponse.turnEventContext;
  return clientResponse;
};

const createDefaultEngineClient = (): GatewayEngineClient => {
  const client = new EngineClient({ engineUrl: DEFAULT_ENGINE_URL });

  return {
    getTools: async (matchId, agentId) => {
      const response = await client.get<{ status: 'ok'; tools: unknown[] }>(
        `/matches/${encodeURIComponent(matchId)}/tools?agentId=${encodeURIComponent(agentId)}`,
      );

      if (
        !Array.isArray(response.tools) ||
        !response.tools.every((tool) => isMcpToolDefinition(tool))
      ) {
        throw new Error('Engine returned invalid tools payload');
      }

      return response.tools;
    },
    callTool: (matchId, request) =>
      client.post<GatewayEngineToolCallResponse>(
        `/matches/${encodeURIComponent(matchId)}/action`,
        request,
      ),
    getMatchMeta: async (matchId) => {
      try {
        const response = await client.get<{
          status: 'ok';
          gameId: string;
          ruleVersion?: string | null;
        }>(`/matches/${encodeURIComponent(matchId)}/meta`);
        return { gameId: response.gameId, ruleVersion: response.ruleVersion ?? null };
      } catch {
        return null;
      }
    },
  };
};

const normalizeOrigins = (origins: string[]): string[] =>
  origins.map((origin) => origin.trim()).filter((origin) => origin.length > 0);

const isOriginAllowed = (origin: string | undefined, allowedOrigins: string[]): boolean => {
  if (!origin) {
    return true;
  }

  try {
    const url = new URL(origin);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return true;
    }
  } catch {
    return false;
  }

  return allowedOrigins.includes(origin);
};

const parseRequestedProtocols = (header: string | string[] | undefined): string[] => {
  if (header === undefined) {
    return [];
  }

  const value = Array.isArray(header) ? header.join(',') : header;
  return value
    .split(',')
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
};

const getQueryStringValue = (value: unknown): string | null => {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (
    Array.isArray(value) &&
    value.length > 0 &&
    typeof value[0] === 'string' &&
    value[0].length > 0
  ) {
    return value[0];
  }

  return null;
};

const getBearerToken = (authorizationHeader: string | undefined): string | null => {
  if (authorizationHeader === undefined) {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
};

const isSecretMatch = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
};

const serializeTools = (tools: MCPToolDefinition[]): string => JSON.stringify(tools);

const defaultSpectatorAccessController: SpectatorAccessController = {
  authorize: async () => ({ allowed: true }),
};

interface MinimalLogger {
  warn(msg: string): void;
  warn(obj: object, msg?: string): void;
  error(msg: string): void;
  error(obj: object, msg?: string): void;
  info(msg: string): void;
  info(obj: object, msg?: string): void;
}

const sendJson = (
  socket: WebSocket | undefined | null,
  payload: unknown,
  log?: MinimalLogger,
): void => {
  if (!socket) {
    return;
  }
  if (socket.readyState !== WebSocket.OPEN) {
    log?.warn({ readyState: socket.readyState }, 'sendJson called but socket is not OPEN');
    return;
  }

  try {
    socket.send(JSON.stringify(payload));
  } catch (error) {
    log?.error({ error }, 'Failed to send message to socket');
  }
};

const getRequestId = (payload: unknown): string => {
  if (typeof payload === 'object' && payload !== null) {
    const requestId = (payload as Record<string, unknown>).request_id;
    if (typeof requestId === 'string' && requestId.trim().length > 0) {
      return requestId;
    }
  }

  return randomUUID();
};

const mapRuntimeErrorToToolResponse = (requestId: string, error: unknown): ToolCallResponse => {
  const message = error instanceof Error ? error.message : 'Unknown internal error';
  const retryable = message.includes('Service Unavailable') || message.includes('Engine error: 5');

  return {
    request_id: requestId,
    status: 'error',
    error: {
      code: retryable ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
      message: retryable ? 'Service temporarily unavailable' : 'Internal server error',
      retryable,
    },
  };
};

const normalizeRawDataToText = (rawData: RawData): string => {
  if (typeof rawData === 'string') {
    return rawData;
  }

  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(rawData).toString('utf8');
  }

  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData).toString('utf8');
  }

  return rawData.toString('utf8');
};

export const createApp = async (options: AppOptions = {}) => {
  const secret = process.env.CONNECT_TOKEN_SECRET;
  if (!secret && process.env.NODE_ENV !== 'test') {
    throw new Error('CONNECT_TOKEN_SECRET is required');
  }

  const app = Fastify({
    logger: loggerOptions,
    trustProxy: process.env.TRUST_PROXY === 'true' || false,
  });

  // Middleware
  const allowedOrigins = normalizeOrigins(
    process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['https://moltgame.com'],
  );

  await app.register(cors, {
    origin: (origin, cb) => {
      if (isOriginAllowed(origin, allowedOrigins)) {
        cb(null, true);
        return;
      }
      cb(new Error('Not allowed'), false);
    },
  });

  const isDevelopment = process.env.NODE_ENV === 'development';
  const configuredRateLimitMax = Number.parseInt(process.env.RATE_LIMIT_MAX ?? '', 10);
  const rateLimitMax =
    Number.isFinite(configuredRateLimitMax) && configuredRateLimitMax > 0
      ? configuredRateLimitMax
      : isDevelopment
        ? 1000
        : 5;
  await app.register(rateLimit, {
    max: rateLimitMax,
    timeWindow: 10000,
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      if (auth && auth.startsWith('Bearer ')) {
        return auth.substring(7);
      }
      return req.ip;
    },
  });

  await app.register(websocket, {
    options: {
      maxPayload: 1048576, // 1MB
    },
  });

  const redisUrl =
    process.env.REDIS_URL ||
    `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
  const redis =
    options.redis ||
    new Redis(redisUrl, {
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });

  // Health check
  app.get('/healthz', async () => {
    try {
      // Use a timeout to prevent hanging on redis.ping() if offline queue is active
      const pingPromise = (async () => {
        if (redis.status === 'ready' || redis.status === 'connect') {
          return redis.ping();
        }
        await redis.connect().catch(() => {});
        return redis.ping();
      })();

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis ping timeout')), 1000),
      );

      await Promise.race([pingPromise, timeoutPromise]);

      return { status: 'ok' };
    } catch (error) {
      app.log.error({ error }, 'Health check failed');
      return { status: 'error', details: 'redis connection failed' };
    }
  });

  let verifier = options.verifier;
  if (!verifier) {
    if (
      process.env.NODE_ENV === 'test' ||
      (process.env.NODE_ENV === 'development' && process.env.MOCK_AUTH === 'true')
    ) {
      verifier = new MockFirebaseVerifier();
    } else {
      if (getApps().length === 0) {
        initializeApp();
      }
      verifier = new FirebaseAuthVerifier(getAuth());
    }
  }

  const ratingRepository =
    options.ratingRepository ??
    (process.env.NODE_ENV === 'test' || getApps().length === 0
      ? new InMemoryRatingRepository()
      : new FirestoreRatingRepository());

  const leaderboardCache =
    options.leaderboardCache ??
    (process.env.NODE_ENV !== 'test' || options.redis
      ? new RedisLeaderboardCache(redis)
      : undefined);

  const ratingService = new RatingService(
    leaderboardCache !== undefined
      ? { repository: ratingRepository, cache: leaderboardCache }
      : { repository: ratingRepository },
  );
  const internalTaskAuthToken =
    options.internalTaskAuthToken ?? process.env.INTERNAL_TASK_AUTH_TOKEN;

  const cloudTasksQueueName = process.env.CLOUD_TASKS_QUEUE_NAME;
  const cloudTasksProjectId = process.env.CLOUD_TASKS_PROJECT_ID;
  const cloudTasksLocation = process.env.CLOUD_TASKS_LOCATION;
  const cloudTasksGatewayBaseUrl = process.env.CLOUD_TASKS_GATEWAY_BASE_URL;

  const ratingJobQueue: RatingJobQueue =
    cloudTasksQueueName &&
    cloudTasksProjectId &&
    cloudTasksLocation &&
    cloudTasksGatewayBaseUrl &&
    internalTaskAuthToken
      ? new CloudTasksRatingJobQueue(
          {
            projectId: cloudTasksProjectId,
            location: cloudTasksLocation,
            queueName: cloudTasksQueueName,
            gatewayBaseUrl: cloudTasksGatewayBaseUrl,
            authToken: internalTaskAuthToken,
          },
          getGcpAccessToken,
        )
      : {
          enqueue: async (job) => {
            await ratingService.processMatchResult(job);
          },
        };

  const store =
    process.env.NODE_ENV === 'test' && !options.redis
      ? new InMemoryConnectTokenSessionStore()
      : new RedisConnectTokenSessionStore(redis);

  const service = new ConnectTokenService({
    store,
    secret: secret || 'dev-secret',
  });

  const api = createConnectTokenApi({
    connectTokenService: service,
    idTokenVerifier: verifier,
  });
  const engineClient = options.engineClient ?? createDefaultEngineClient();
  const reconnectGraceMs = options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;

  const isTestOrNoFirebase = process.env.NODE_ENV === 'test' || getApps().length === 0;
  const replayRepository =
    options.replayRepository ??
    (isTestOrNoFirebase ? new InMemoryReplayRepository() : new FirestoreReplayRepository());
  const replayStorage =
    options.replayStorage ??
    (isTestOrNoFirebase ? new InMemoryReplayStorage() : new FirebaseReplayStorage());
  const replayService = new ReplayService({ repository: replayRepository, storage: replayStorage });
  const spectatorAccessController =
    options.spectatorAccessController ?? defaultSpectatorAccessController;

  // Per-match TurnEvent accumulator (in-memory, cleared after replay generation)
  const matchEvents = new Map<string, TurnEvent[]>();
  const matchTurnCounters = new Map<string, number>();
  const matchGameIds = new Map<string, string>();
  const endedMatchIds = new Set<string>();

  const sessionsById = new Map<string, AgentSession>();
  const sessionIdByMatchAgent = new Map<string, string>();
  const spectatorSessionsByMatch = new Map<string, Map<string, SpectatorSession>>();

  const clearSessionTimer = (session: AgentSession): void => {
    if (session.forfeitTimer !== null) {
      clearTimeout(session.forfeitTimer);
      session.forfeitTimer = null;
    }
  };

  const scheduleForfeit = (session: AgentSession): void => {
    clearSessionTimer(session);
    session.reconnectDeadlineAtMs = Date.now() + reconnectGraceMs;

    session.forfeitTimer = setTimeout(() => {
      sessionsById.delete(session.id);
      sessionIdByMatchAgent.delete(toSessionLookupKey(session.matchId, session.agentId));
      session.forfeitTimer = null;
      session.reconnectDeadlineAtMs = null;
    }, reconnectGraceMs);
  };

  const refreshToolsAndNotify = async (session: AgentSession): Promise<void> => {
    try {
      const nextTools = await engineClient.getTools(session.matchId, session.agentId);
      const nextFingerprint = serializeTools(nextTools);

      if (nextFingerprint !== session.toolsFingerprint && session.socket !== null) {
        sendJson(
          session.socket,
          {
            type: 'tools/list_changed',
            tools: nextTools,
          },
          app.log,
        );
        session.tools = nextTools;
        session.toolsFingerprint = nextFingerprint;
      }
    } catch (error) {
      app.log.warn(
        { error, matchId: session.matchId, agentId: session.agentId },
        'Failed to refresh tools list',
      );
    }
  };

  const notifyMatchSessionsOfChange = async (matchId: string): Promise<void> => {
    const sessions = Array.from(sessionsById.values()).filter((s) => s.matchId === matchId);
    await Promise.all(sessions.map((s) => refreshToolsAndNotify(s)));
  };

  const getMatchGameId = async (matchId: string): Promise<string | null> => {
    const cached = matchGameIds.get(matchId);
    if (cached !== undefined) {
      return cached;
    }

    const meta = await engineClient.getMatchMeta(matchId);
    if (!meta?.gameId) {
      return null;
    }

    matchGameIds.set(matchId, meta.gameId);
    return meta.gameId;
  };

  const broadcastToSpectators = (matchId: string, payload: unknown): void => {
    const spectators = spectatorSessionsByMatch.get(matchId);
    if (!spectators) {
      return;
    }

    for (const session of spectators.values()) {
      sendJson(session.socket, payload, app.log);
    }
  };

  const broadcastSpectatorEvent = async (matchId: string, event: TurnEvent): Promise<void> => {
    const gameId = await getMatchGameId(matchId);
    if (!gameId) {
      app.log.warn(
        { matchId },
        'Skipped spectator event broadcast because game metadata is missing',
      );
      return;
    }

    const [redactedEvent] = applyRedaction([event], gameId);
    broadcastToSpectators(matchId, {
      type: 'match/event',
      event: redactedEvent,
    });
  };

  const queueSpectatorEventBroadcast = (matchId: string, event: TurnEvent): void => {
    void broadcastSpectatorEvent(matchId, event).catch((error: unknown) => {
      app.log.warn(
        { error, matchId, eventId: event.eventId },
        'Failed to broadcast spectator event',
      );
    });
  };

  const bindSocketHandlers = (session: AgentSession): void => {
    const socket = session.socket;
    if (socket === null) {
      return;
    }

    socket.on('message', async (rawData: RawData) => {
      if (session.socket !== socket) {
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(normalizeRawDataToText(rawData));
      } catch {
        const response: ToolCallResponse = {
          request_id: randomUUID(),
          status: 'error',
          error: {
            code: 'INVALID_REQUEST',
            message: 'Request body must be valid JSON',
            retryable: false,
          },
        };
        sendJson(socket, response, app.log);
        return;
      }

      let requestId = getRequestId(payload);
      try {
        const request = parseToolCallRequest(payload);
        requestId = request.request_id;

        // Issue #41: return MATCH_ENDED if the match has already terminated
        if (endedMatchIds.has(session.matchId)) {
          const response: ToolCallResponse = {
            request_id: request.request_id,
            status: 'error',
            error: {
              code: 'MATCH_ENDED',
              message: 'Match has already ended',
              retryable: false,
            },
          };
          sendJson(socket, response, app.log);
          return;
        }

        const isToolAvailable = session.tools.some((tool) => tool.name === request.tool);
        if (!isToolAvailable) {
          const response: ToolCallResponse = {
            request_id: request.request_id,
            status: 'error',
            error: {
              code: 'INVALID_REQUEST',
              message: 'Tool is not available for this session',
              retryable: false,
            },
          };
          sendJson(socket, response, app.log);
          return;
        }

        // Issue #36: measure actual action latency
        const actionStartMs = Date.now();
        const rawResponse = await engineClient.callTool(session.matchId, {
          ...(request as {
            tool: string;
            request_id: string;
            args: Record<string, JsonValue>;
          }),
          actor: session.agentId,
        });
        const actionLatencyMs = Date.now() - actionStartMs;
        const turnEventContext = extractTurnEventContext(rawResponse);

        const normalizedResponse = isToolCallResponse(rawResponse)
          ? rawResponse
          : mapRuntimeErrorToToolResponse(request.request_id, new Error('Invalid engine response'));
        const clientResponse = stripTurnEventContext(
          normalizedResponse as GatewayEngineToolCallResponse,
        );

        sendJson(socket, clientResponse, app.log);

        // Record TurnEvent for replay (only on successful actions)
        if (normalizedResponse.status === 'ok') {
          const turnCounter = (matchTurnCounters.get(session.matchId) ?? 0) + 1;
          matchTurnCounters.set(session.matchId, turnCounter);

          const turnEvent: TurnEvent = {
            eventId: randomUUID(),
            matchId: session.matchId,
            turn: turnCounter,
            actor: session.agentId,
            action: { tool: request.tool, args: request.args } as JsonValue,
            result: normalizedResponse.result as JsonValue,
            actionLatencyMs,
            timestamp: new Date().toISOString(),
            actionType: request.tool,
            seat: turnEventContext?.seat ?? FALLBACK_FIRST_SEAT,
            ruleVersion: turnEventContext?.ruleVersion ?? 'unknown',
            phase: turnEventContext?.phase ?? 'default',
            scoreDiffBefore: turnEventContext?.scoreDiffBefore ?? 0,
            scoreDiffAfter: turnEventContext?.scoreDiffAfter ?? 0,
          };

          const events = matchEvents.get(session.matchId) ?? [];
          events.push(turnEvent);
          matchEvents.set(session.matchId, events);

          queueSpectatorEventBroadcast(session.matchId, turnEvent);
        }

        // Notify all agents in this match about turn change or termination
        const matchSessions = Array.from(sessionsById.values()).filter(
          (s) => s.matchId === session.matchId,
        );

        if (
          normalizedResponse.status === 'ok' &&
          normalizedResponse.termination &&
          normalizedResponse.termination.ended
        ) {
          const termination = normalizedResponse.termination;
          const playerSessions = matchSessions.filter((s) => s.uid.length > 0);
          const participants = Array.from(new Set(playerSessions.map((s) => s.uid)));
          const winnerUid =
            termination.winner === undefined
              ? null
              : (playerSessions.find((s) => s.agentId === termination.winner)?.uid ?? null);
          const endedAt = new Date().toISOString();

          if (participants.length === 2) {
            ratingJobQueue
              .enqueue({
                matchId: session.matchId,
                participants,
                winnerUid,
                endedAt,
              })
              .catch((enqueueError: unknown) => {
                app.log.error(
                  { error: enqueueError, matchId: session.matchId },
                  'Failed to enqueue rating job',
                );
              });
          }

          // Generate replay asynchronously (fire and forget)
          const eventsForReplay = matchEvents.get(session.matchId) ?? [];
          matchEvents.delete(session.matchId);
          matchTurnCounters.delete(session.matchId);

          engineClient
            .getMatchMeta(session.matchId)
            .then((meta) => {
              if (!meta?.gameId) {
                throw new Error('Replay generation requires match metadata');
              }
              return replayService.generateAndStore(
                session.matchId,
                meta.gameId,
                eventsForReplay,
                endedAt,
              );
            })
            .then(() => {
              app.log.info({ matchId: session.matchId }, 'Replay generated successfully');
            })
            .catch((replayError: unknown) => {
              app.log.error(
                { error: replayError, matchId: session.matchId },
                'Failed to generate replay',
              );
            });

          // Mark match as ended to block subsequent tool calls (Issue #41)
          endedMatchIds.add(session.matchId);

          const endedPayload = {
            type: 'match/ended',
            winner: termination.winner,
            reason: termination.reason,
          };
          for (const s of matchSessions) {
            sendJson(s.socket, endedPayload, app.log);
          }
          broadcastToSpectators(session.matchId, endedPayload);
        } else {
          await notifyMatchSessionsOfChange(session.matchId);
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Invalid MCP tool call request') {
          const response: ToolCallResponse = {
            request_id: requestId,
            status: 'error',
            error: {
              code: 'INVALID_REQUEST',
              message: error.message,
              retryable: false,
            },
          };
          sendJson(socket, response, app.log);
          return;
        }

        const response = mapRuntimeErrorToToolResponse(requestId, error);
        sendJson(socket, response, app.log);
      }
    });

    socket.on('close', () => {
      if (session.socket !== socket) {
        return;
      }

      session.socket = null;
      scheduleForfeit(session);
    });

    socket.on('error', (error: Error) => {
      app.log.warn(
        { error, matchId: session.matchId, agentId: session.agentId },
        'WebSocket connection error',
      );
    });
  };

  // Adapter for ConnectTokenApi
  const handleConnectTokenRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const protocol = request.protocol;
    const host = request.hostname;
    const url = new URL(`${protocol}://${host}${request.url}`);

    const headers = new Headers();
    Object.entries(request.headers).forEach(([key, value]) => {
      if (typeof value === 'string') {
        headers.set(key, value);
      } else if (Array.isArray(value)) {
        value.forEach((v) => headers.append(key, v));
      }
    });

    const webRequestInit: RequestInit = {
      method: request.method,
      headers,
    };

    if (request.body && (request.method === 'POST' || request.method === 'PUT')) {
      webRequestInit.body = JSON.stringify(request.body);
    }

    const webRequest = new Request(url, webRequestInit);
    const response = await api.handle(webRequest);

    reply.status(response.status);
    response.headers.forEach((value, key) => {
      reply.header(key, value);
    });

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  app.post('/v1/tokens', handleConnectTokenRequest);
  app.delete('/v1/tokens/:tokenId', handleConnectTokenRequest);

  app.post<{
    Body: { matchId: string; participants: string[]; winnerUid?: string | null; endedAt: string };
  }>('/internal/tasks/ratings/match-finished', async (request, reply) => {
    const authorizationHeader =
      typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined;
    const bearerToken = getBearerToken(authorizationHeader);

    if (internalTaskAuthToken === undefined) {
      if (process.env.NODE_ENV !== 'test') {
        request.log.error('INTERNAL_TASK_AUTH_TOKEN is not configured');
        reply
          .status(503)
          .send({ status: 'error', message: 'Internal task authentication is not configured' });
        return;
      }
    } else if (bearerToken === null || !isSecretMatch(bearerToken, internalTaskAuthToken)) {
      reply.status(401).send({ status: 'error', message: 'Unauthorized internal task request' });
      return;
    }

    try {
      const result = await ratingService.processMatchResult(request.body);
      return {
        status: 'ok',
        seasonId: result.season.seasonId,
        leaderboardSize: result.leaderboard.entries.length,
      };
    } catch (error: unknown) {
      request.log.error({ error }, 'Failed to process rating task');
      const message = error instanceof Error ? error.message : 'Unknown error';
      reply.status(400).send({ status: 'error', message });
    }
  });

  app.get<{ Params: { seasonId: string; uid: string } }>(
    '/v1/ratings/:seasonId/:uid',
    async (request, reply) => {
      const rating = await ratingService.getRating(request.params.seasonId, request.params.uid);
      if (rating === null) {
        reply.status(404).send({ status: 'error', message: 'Rating not found' });
        return;
      }

      return { status: 'ok', rating };
    },
  );

  app.get<{ Params: { seasonId: string } }>(
    '/v1/leaderboards/:seasonId',
    async (request, reply) => {
      const leaderboard = await ratingService.getLeaderboard(request.params.seasonId);
      if (leaderboard === null) {
        reply.status(404).send({ status: 'error', message: 'Leaderboard not found' });
        return;
      }

      return { status: 'ok', leaderboard };
    },
  );

  app.get<{ Params: { matchId: string } }>('/v1/replays/:matchId', async (request, reply) => {
    const { matchId } = request.params;
    try {
      const url = await replayService.getSignedDownloadUrl(matchId);
      return { status: 'ok', url };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('not found')) {
        reply.status(404).send({ status: 'error', message: 'Replay not found' });
        return;
      }
      if (message.includes('not publicly accessible')) {
        reply.status(403).send({ status: 'error', message: 'Replay is not publicly accessible' });
        return;
      }
      reply.status(500).send({ status: 'error', message: 'Failed to get replay URL' });
    }
  });

  app.get(
    '/v1/ws',
    { websocket: true },
    async (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connection: any,
      request,
    ) => {
      const socket = connection.socket || (connection as unknown as WebSocket);
      if (!socket) {
        app.log.warn('WebSocket connection opened but socket is missing');
        return;
      }

      const originHeader =
        typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
      if (!isOriginAllowed(originHeader, allowedOrigins)) {
        app.log.warn({ originHeader }, 'Origin not allowed');
        socket.close(1008, 'Origin not allowed');
        return;
      }

      const requestedProtocols = parseRequestedProtocols(request.headers['sec-websocket-protocol']);
      if (!requestedProtocols.includes(SUPPORTED_WS_PROTOCOL)) {
        app.log.warn({ requestedProtocols }, 'Unsupported protocol');
        socket.close(1002, 'Unsupported protocol');
        return;
      }

      const query = request.query as Record<string, unknown>;
      const sessionId = getQueryStringValue(query.session_id);
      const connectToken = getQueryStringValue(query.connect_token);

      if (sessionId !== null) {
        const session = sessionsById.get(sessionId);
        if (!session) {
          sendJson(
            socket,
            {
              type: 'match/ended',
              reason: 'FORFEIT_LOSS',
              retryable: false,
            },
            app.log,
          );
          socket.close(1008, 'Session not found');
          return;
        }

        if (session.reconnectDeadlineAtMs !== null && Date.now() > session.reconnectDeadlineAtMs) {
          sessionsById.delete(session.id);
          sessionIdByMatchAgent.delete(toSessionLookupKey(session.matchId, session.agentId));
          sendJson(
            socket,
            {
              type: 'match/ended',
              reason: 'FORFEIT_LOSS',
              retryable: false,
            },
            app.log,
          );
          socket.close(1008, 'Reconnect grace period exceeded');
          return;
        }

        clearSessionTimer(session);
        session.reconnectDeadlineAtMs = null;

        if (session.socket && session.socket.readyState === WebSocket.OPEN) {
          session.socket.close(1012, 'Superseded by new connection');
        }

        session.socket = socket;
        app.log.info({ sessionId: session.id }, 'Session resumed');
        sendJson(
          socket,
          {
            type: 'session/resumed',
            session_id: session.id,
          },
          app.log,
        );
        sendJson(
          socket,
          {
            type: 'tools/list',
            tools: session.tools,
          },
          app.log,
        );
        bindSocketHandlers(session);
        return;
      }

      if (connectToken === null) {
        socket.close(1008, 'connect_token or session_id is required');
        return;
      }

      let claims;
      try {
        claims = await service.consumeToken(connectToken);
      } catch (error) {
        if (error instanceof ConnectTokenError) {
          socket.close(1008, error.code);
          return;
        }

        app.log.error({ error }, 'Failed to verify connect token');
        socket.close(1011, 'Failed to verify connect token');
        return;
      }

      const sessionKey = toSessionLookupKey(claims.matchId, claims.agentId);
      const existingSessionId = sessionIdByMatchAgent.get(sessionKey);
      if (existingSessionId !== undefined) {
        const existingSession = sessionsById.get(existingSessionId);
        if (existingSession !== undefined) {
          clearSessionTimer(existingSession);
          existingSession.reconnectDeadlineAtMs = null;
          const existingSocket = existingSession.socket;
          existingSession.socket = null;
          if (
            existingSocket !== null &&
            (existingSocket.readyState === WebSocket.OPEN ||
              existingSocket.readyState === WebSocket.CONNECTING)
          ) {
            existingSocket.close(1012, 'Superseded by new connection');
          }
          sessionsById.delete(existingSession.id);
        }
        sessionIdByMatchAgent.delete(sessionKey);
      }

      let tools: MCPToolDefinition[];
      try {
        tools = await engineClient.getTools(claims.matchId, claims.agentId);
      } catch (error) {
        app.log.error(
          { error, matchId: claims.matchId, agentId: claims.agentId },
          'Failed to load tools from engine',
        );
        socket.close(1013, 'Service unavailable');
        return;
      }

      const session: AgentSession = {
        id: randomUUID(),
        uid: claims.uid,
        matchId: claims.matchId,
        agentId: claims.agentId,
        tools,
        toolsFingerprint: serializeTools(tools),
        socket,
        forfeitTimer: null,
        reconnectDeadlineAtMs: null,
      };

      sessionsById.set(session.id, session);
      sessionIdByMatchAgent.set(sessionKey, session.id);

      app.log.info(
        { sessionId: session.id, matchId: session.matchId, agentId: session.agentId },
        'Session ready',
      );
      sendJson(
        socket,
        {
          type: 'session/ready',
          session_id: session.id,
          reconnect: {
            grace_ms: reconnectGraceMs,
            backoff_initial_ms: RECONNECT_BACKOFF_INITIAL_MS,
            backoff_max_ms: RECONNECT_BACKOFF_MAX_MS,
          },
        },
        app.log,
      );
      sendJson(
        socket,
        {
          type: 'tools/list',
          tools,
        },
        app.log,
      );

      bindSocketHandlers(session);
    },
  );

  app.get(
    '/v1/ws/spectate',
    { websocket: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (connection: any, request) => {
      const socket = connection.socket || (connection as unknown as WebSocket);
      if (!socket) {
        app.log.warn('Spectator WebSocket connection opened but socket is missing');
        return;
      }

      const originHeader =
        typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
      if (!isOriginAllowed(originHeader, allowedOrigins)) {
        app.log.warn({ originHeader }, 'Origin not allowed');
        socket.close(1008, 'Origin not allowed');
        return;
      }

      const requestedProtocols = parseRequestedProtocols(request.headers['sec-websocket-protocol']);
      if (!requestedProtocols.includes(SUPPORTED_WS_PROTOCOL)) {
        app.log.warn({ requestedProtocols }, 'Unsupported protocol');
        socket.close(1002, 'Unsupported protocol');
        return;
      }

      const query = request.query as Record<string, unknown>;
      const matchId = getQueryStringValue(query.match_id);
      if (matchId === null) {
        socket.close(1008, 'match_id is required');
        return;
      }

      let claims: VerifiedFirebaseIdToken | null = null;
      const authorizationHeader =
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined;
      const bearerToken = getBearerToken(authorizationHeader);
      if (bearerToken !== null) {
        try {
          claims = await verifier.verifyIdToken(bearerToken);
        } catch (error) {
          app.log.warn({ error, matchId }, 'Invalid spectator authorization token');
          socket.close(1008, 'Unauthorized spectator');
          return;
        }
      }

      const authorization = await spectatorAccessController.authorize({
        matchId,
        viewerUid: claims?.uid ?? null,
        claims,
      });
      if (!authorization.allowed) {
        socket.close(1008, authorization.reason ?? 'Spectator access denied');
        return;
      }

      const session: SpectatorSession = {
        id: randomUUID(),
        matchId,
        viewerUid: claims?.uid ?? null,
        socket,
      };
      const spectators =
        spectatorSessionsByMatch.get(matchId) ?? new Map<string, SpectatorSession>();
      spectators.set(session.id, session);
      spectatorSessionsByMatch.set(matchId, spectators);

      sendJson(
        socket,
        {
          type: 'spectator/ready',
          session_id: session.id,
          match_id: matchId,
          viewer_uid: session.viewerUid,
        },
        app.log,
      );

      socket.on('message', () => {
        sendJson(socket, READ_ONLY_SPECTATOR_ERROR, app.log);
      });

      socket.on('close', () => {
        const currentSpectators = spectatorSessionsByMatch.get(matchId);
        currentSpectators?.delete(session.id);
        if (currentSpectators?.size === 0) {
          spectatorSessionsByMatch.delete(matchId);
        }
      });

      socket.on('error', (error: Error) => {
        app.log.warn({ error, matchId }, 'Spectator WebSocket connection error');
      });
    },
  );

  app.addHook('onClose', async () => {
    for (const session of sessionsById.values()) {
      clearSessionTimer(session);
      if (session.socket && session.socket.readyState === WebSocket.OPEN) {
        sendJson(
          session.socket,
          {
            type: 'DRAINING',
            reconnect_after_ms: RECONNECT_BACKOFF_INITIAL_MS,
          },
          app.log,
        );
        session.socket.close(1012, 'DRAINING');
      }
    }
    for (const spectators of spectatorSessionsByMatch.values()) {
      for (const spectator of spectators.values()) {
        if (spectator.socket.readyState === WebSocket.OPEN) {
          sendJson(
            spectator.socket,
            {
              type: 'DRAINING',
              reconnect_after_ms: RECONNECT_BACKOFF_INITIAL_MS,
            },
            app.log,
          );
          spectator.socket.close(1012, 'DRAINING');
        }
      }
    }
    sessionsById.clear();
    sessionIdByMatchAgent.clear();
    spectatorSessionsByMatch.clear();
  });

  return app;
};
