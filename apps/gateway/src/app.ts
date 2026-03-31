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
import type { JsonValue, Match, TurnEvent, TurnEventSeat } from '@moltgames/domain';
import WebSocket, { type RawData } from 'ws';

import {
  ConnectTokenError,
  ConnectTokenService,
  createConnectTokenApi,
  DeviceAuthError,
  DeviceAuthService,
  InMemoryConnectTokenSessionStore,
  InMemoryDeviceAuthSessionStore,
  RedisDeviceAuthSessionStore,
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
import {
  FirestoreMatchRepository,
  InMemoryMatchRepository,
  type MatchRepository,
} from './match/repository.js';
import { listMatchesPage, MatchQueueService } from './matchmaking/queue-service.js';
import {
  FirestoreMatchLifecycleWebhookSubscriptionRepository,
  MatchLifecycleWebhookService,
  NoopMatchLifecycleNotifier,
  type MatchLifecycleNotifier,
  type MatchLifecycleWebhookOutcome,
} from './notifications/match-lifecycle-webhooks.js';
import {
  LoggingSpectatorLatencyRecorder,
  type SpectatorLatencyRecorder,
} from './spectator/latency-recorder.js';
import { RedisMatchActionRateLimiter } from './websocket/match-action-rate-limiter.js';
import { sendRestApiError } from './api-error.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerKpiRoutes } from './kpi/routes.js';

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
  matchRepository?: MatchRepository;
  matchLifecycleNotifier?: MatchLifecycleNotifier;
  spectatorLatencyRecorder?: SpectatorLatencyRecorder;
}

export interface GatewayEngineClient {
  startMatch?(
    matchId: string,
    request: {
      gameId: string;
      seed: number;
    },
  ): Promise<void>;
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

interface QueueRequestBody {
  gameId: string;
  agentId: string;
  ratingRange?: {
    min: number;
    max: number;
  };
}

const SUPPORTED_WS_PROTOCOL = 'moltgame.v1';
const DEFAULT_ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8081';
const DEFAULT_RECONNECT_GRACE_MS = 20_000;
const RECONNECT_BACKOFF_INITIAL_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 8_000;
const WS_ACTION_RATE_LIMIT_WINDOW_MS = 10_000;
const WS_ACTION_RATE_LIMIT_MAX = 20;
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
    startMatch: async (matchId, request) => {
      await client.post(`/matches/${encodeURIComponent(matchId)}/start`, request);
    },
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

const parsePositiveIntegerQueryValue = (value: string | null, fallback: number): number | null => {
  if (value === null) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
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
  const deviceAuthStore =
    process.env.NODE_ENV === 'test' && !options.redis
      ? new InMemoryDeviceAuthSessionStore()
      : new RedisDeviceAuthSessionStore(redis);

  const service = new ConnectTokenService({
    store,
    secret: secret || 'dev-secret',
  });
  const deviceAuthService = new DeviceAuthService({
    store: deviceAuthStore,
    verificationUri: process.env.DEVICE_AUTH_VERIFICATION_URI ?? 'https://moltgame.com/activate',
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
  const matchActionRateLimiter = new RedisMatchActionRateLimiter(
    redis,
    WS_ACTION_RATE_LIMIT_WINDOW_MS,
    WS_ACTION_RATE_LIMIT_MAX,
  );

  const matchRepository: MatchRepository =
    options.matchRepository ??
    (isTestOrNoFirebase ? new InMemoryMatchRepository() : new FirestoreMatchRepository());
  const matchLifecycleNotifier =
    options.matchLifecycleNotifier ??
    (isTestOrNoFirebase
      ? new NoopMatchLifecycleNotifier()
      : new MatchLifecycleWebhookService({
          subscriptionRepository: new FirestoreMatchLifecycleWebhookSubscriptionRepository(),
          log: app.log,
        }));
  const spectatorLatencyRecorder =
    options.spectatorLatencyRecorder ?? new LoggingSpectatorLatencyRecorder(app.log);
  const matchQueueService = new MatchQueueService({
    redis,
    ratingRepository,
    matchRepository,
    engineClient,
  });

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

      void matchActionRateLimiter.clear(session.matchId).catch((error: unknown) => {
        app.log.warn(
          { error, matchId: session.matchId },
          'Failed to clear websocket action rate limit state after forfeit',
        );
      });

      // Transition match status to ABORTED (Issue #38)
      matchRepository.updateStatus(session.matchId, 'ABORTED').catch((err: unknown) => {
        app.log.warn(
          { error: err, matchId: session.matchId },
          'Failed to update match status to ABORTED',
        );
      });
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

  const region = process.env.REGION ?? 'us-central1';

  const notifyMatchStarted = (match: Match): void => {
    void matchLifecycleNotifier.notifyMatchStarted(match).catch((error: unknown) => {
      app.log.warn({ error, matchId: match.matchId }, 'Failed to notify match.start webhooks');
    });
  };

  const notifyMatchEnded = (match: Match, outcome: MatchLifecycleWebhookOutcome): void => {
    void matchLifecycleNotifier.notifyMatchEnded(match, outcome).catch((error: unknown) => {
      app.log.warn({ error, matchId: match.matchId }, 'Failed to notify match.end webhooks');
    });
  };

  const updateMatchOnConnect = async (session: AgentSession): Promise<void> => {
    const { matchId, uid, agentId } = session;

    const existing = await matchRepository.get(matchId);
    const newParticipant = { uid, agentId, role: 'PLAYER' as const };

    if (existing === null) {
      // First agent connecting — create the match record
      const meta = await engineClient.getMatchMeta(matchId);
      const gameId = meta?.gameId ?? 'unknown';
      const ruleVersion = meta?.ruleVersion ?? 'unknown';
      await matchRepository.save({
        matchId,
        gameId,
        status: 'WAITING_AGENT_CONNECT',
        participants: [newParticipant],
        ruleId: gameId,
        ruleVersion,
        region,
      });
      return;
    }

    // Add participant if not already present
    const alreadyListed = existing.participants.some((p) => p.agentId === agentId);
    const participants = alreadyListed
      ? existing.participants
      : [...existing.participants, newParticipant];

    const connectedCount = Array.from(sessionsById.values()).filter(
      (s) => s.matchId === matchId,
    ).length;

    const shouldStartMatch =
      connectedCount >= 2 &&
      (existing.status === 'CREATED' ||
        existing.status === 'WAITING_AGENT_CONNECT' ||
        existing.status === 'READY');

    if (shouldStartMatch) {
      // Both agents connected for the first time — transition to IN_PROGRESS
      const startedMatch: Match = {
        ...existing,
        participants,
        status: 'IN_PROGRESS',
        startedAt: existing.startedAt ?? new Date().toISOString(),
      };
      await matchRepository.save(startedMatch);
      notifyMatchStarted(startedMatch);
    } else {
      const nextStatus =
        connectedCount === 1 && existing.status === 'CREATED'
          ? ('WAITING_AGENT_CONNECT' as const)
          : existing.status;

      // Reconnects and non-starting updates should preserve the existing lifecycle fields.
      await matchRepository.save({ ...existing, participants, status: nextStatus });
    }
  };

  const broadcastToSpectators = (matchId: string, payload: unknown): number => {
    const spectators = spectatorSessionsByMatch.get(matchId);
    if (!spectators) {
      return 0;
    }

    let count = 0;
    for (const session of spectators.values()) {
      sendJson(session.socket, payload, app.log);
      count += 1;
    }

    return count;
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
    const broadcastStartedAtMs = Date.now();
    const spectatorCount = broadcastToSpectators(matchId, {
      type: 'match/event',
      event: redactedEvent,
      sent_at: new Date(broadcastStartedAtMs).toISOString(),
    });
    const broadcastCompletedAtMs = Date.now();

    if (spectatorCount > 0) {
      const eventTimestampMs = Date.parse(event.timestamp);
      const latencyMs = Number.isNaN(eventTimestampMs)
        ? Math.max(0, broadcastCompletedAtMs - broadcastStartedAtMs)
        : Math.max(0, broadcastCompletedAtMs - eventTimestampMs);
      await spectatorLatencyRecorder.record({
        matchId,
        eventId: event.eventId,
        spectatorCount,
        latencyMs,
        fanOutDurationMs: Math.max(0, broadcastCompletedAtMs - broadcastStartedAtMs),
        targetLatencyMs: 200,
        withinTarget: latencyMs <= 200,
        eventTimestamp: event.timestamp,
        recordedAt: new Date(broadcastCompletedAtMs).toISOString(),
      });
    }
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

        let isToolAvailable = session.tools.some((tool) => tool.name === request.tool);
        if (!isToolAvailable) {
          // Refresh once before rejecting to avoid stale tool caches immediately after turn changes.
          await refreshToolsAndNotify(session);
          isToolAvailable = session.tools.some((tool) => tool.name === request.tool);
        }
        if (!isToolAvailable) {
          const response: ToolCallResponse = {
            request_id: request.request_id,
            status: 'error',
            error: {
              code: 'NOT_YOUR_TURN',
              message: 'Tool is not available for this session',
              retryable: true,
            },
          };
          sendJson(socket, response, app.log);
          return;
        }

        if (!(await matchActionRateLimiter.allow(session.matchId))) {
          const response: ToolCallResponse = {
            request_id: request.request_id,
            status: 'error',
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'WebSocket action rate limit exceeded',
              retryable: true,
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
          void matchActionRateLimiter.clear(session.matchId).catch((error: unknown) => {
            app.log.warn(
              { error, matchId: session.matchId },
              'Failed to clear websocket action rate limit state after match end',
            );
          });

          // Transition match status to FINISHED (Issue #38)
          matchRepository
            .updateStatus(session.matchId, 'FINISHED', { endedAt })
            .catch((err: unknown) => {
              app.log.warn(
                { error: err, matchId: session.matchId },
                'Failed to update match status to FINISHED',
              );
            });

          const persistedMatch = await matchRepository
            .get(session.matchId)
            .catch((error: unknown) => {
              app.log.warn(
                { error, matchId: session.matchId },
                'Failed to load match after finish',
              );
              return null;
            });
          if (persistedMatch !== null) {
            notifyMatchEnded(
              {
                ...persistedMatch,
                status: 'FINISHED',
                endedAt,
              },
              {
                winnerAgentId: termination.winner,
                winnerUid,
                reason: termination.reason,
              },
            );
          }

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

  const authenticateRestRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<VerifiedFirebaseIdToken | null> => {
    const authorizationHeader =
      typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined;
    const bearerToken = getBearerToken(authorizationHeader);

    if (bearerToken === null) {
      sendRestApiError(reply, 401, 'UNAUTHORIZED', 'Authorization header is missing');
      return null;
    }

    try {
      return await verifier.verifyIdToken(bearerToken);
    } catch {
      sendRestApiError(reply, 401, 'UNAUTHORIZED', 'Invalid Firebase ID token');
      return null;
    }
  };

  const allowQueueMutation = async (uid: string): Promise<boolean> => {
    const key = `moltgames:queue-rate:${uid}`;
    const pipeline = redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, 60);
    const results = await pipeline.exec();
    const count = results?.[0]?.[1] as number | null;
    return (count ?? 1) <= 10;
  };

  app.post('/v1/tokens', handleConnectTokenRequest);
  app.delete('/v1/tokens/:tokenId', handleConnectTokenRequest);

  // KPI measurement routes (PR-18b)
  registerKpiRoutes(app);

  app.post('/v1/auth/device', async (_request, reply) => {
    const result = await deviceAuthService.issueAuthorization();
    reply.status(201).send({
      device_code: result.deviceCode,
      user_code: result.userCode,
      verification_uri: result.verificationUri,
      expires_in: result.expiresIn,
      interval: result.interval,
    });
  });

  app.post<{
    Body: { device_code?: string };
  }>('/v1/auth/device/token', async (request, reply) => {
    const deviceCode =
      typeof request.body?.device_code === 'string' ? request.body.device_code : null;

    if (deviceCode === null || deviceCode.length === 0) {
      sendRestApiError(reply, 400, 'INVALID_REQUEST', 'device_code is required');
      return;
    }

    try {
      const result = await deviceAuthService.exchangeToken(deviceCode);
      return {
        id_token: result.idToken,
        refresh_token: result.refreshToken,
        expires_in: result.expiresIn,
        token_type: result.tokenType,
      };
    } catch (error) {
      if (error instanceof DeviceAuthError) {
        switch (error.code) {
          case 'AUTHORIZATION_PENDING':
            sendRestApiError(reply, 428, error.code, error.message, true);
            return;
          case 'AUTHORIZATION_ALREADY_CONSUMED':
            sendRestApiError(reply, 400, error.code, error.message);
            return;
          case 'EXPIRED_TOKEN':
            sendRestApiError(reply, 410, error.code, error.message);
            return;
          case 'NOT_FOUND':
            sendRestApiError(reply, 404, error.code, error.message);
            return;
          case 'INVALID_REQUEST':
            sendRestApiError(reply, 400, error.code, error.message);
            return;
        }
      }

      request.log.error({ error }, 'Failed to exchange device auth token');
      sendRestApiError(reply, 503, 'SERVICE_UNAVAILABLE', 'Service unavailable', true);
    }
  });

  app.post<{
    Body: {
      userCode?: string;
      refreshToken?: string;
      expiresIn?: number;
    };
  }>('/v1/auth/device/activate', async (request, reply) => {
    const claims = await authenticateRestRequest(request, reply);
    if (claims === null) {
      return;
    }

    const { userCode, refreshToken, expiresIn } = request.body ?? {};

    if (
      typeof userCode !== 'string' ||
      typeof refreshToken !== 'string' ||
      typeof expiresIn !== 'number' ||
      !Number.isInteger(expiresIn)
    ) {
      sendRestApiError(
        reply,
        400,
        'INVALID_REQUEST',
        'userCode, refreshToken, and expiresIn are required',
      );
      return;
    }

    // idToken is guaranteed non-null here: authenticateRestRequest already verified the bearer token.
    const idToken = getBearerToken(request.headers.authorization as string) as string;

    try {
      await deviceAuthService.activateAuthorization({
        userCode,
        uid: claims.uid,
        idToken,
        refreshToken,
        expiresIn,
      });
      reply.status(204).send();
    } catch (error) {
      if (error instanceof DeviceAuthError) {
        switch (error.code) {
          case 'NOT_FOUND':
            sendRestApiError(reply, 404, error.code, error.message);
            return;
          case 'EXPIRED_TOKEN':
            sendRestApiError(reply, 410, error.code, error.message);
            return;
          case 'AUTHORIZATION_ALREADY_CONSUMED':
          case 'INVALID_REQUEST':
            sendRestApiError(reply, 400, error.code, error.message);
            return;
          case 'AUTHORIZATION_PENDING':
            sendRestApiError(reply, 428, error.code, error.message, true);
            return;
        }
      }

      request.log.error({ error }, 'Failed to activate device auth session');
      sendRestApiError(reply, 503, 'SERVICE_UNAVAILABLE', 'Service unavailable', true);
    }
  });

  app.post<{ Body: QueueRequestBody }>('/v1/matches/queue', async (request, reply) => {
    const claims = await authenticateRestRequest(request, reply);
    if (claims === null) {
      return;
    }

    if (!(await allowQueueMutation(claims.uid))) {
      sendRestApiError(reply, 429, 'RATE_LIMITED', 'Queue rate limit exceeded', true);
      return;
    }

    try {
      const status = await matchQueueService.enqueue({
        uid: claims.uid,
        gameId: request.body.gameId,
        agentId: request.body.agentId,
        ...(request.body.ratingRange === undefined
          ? {}
          : { ratingRange: request.body.ratingRange }),
      });

      reply.status(status.status === 'MATCHED' ? 201 : 202).send(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to enqueue match request';
      sendRestApiError(reply, 400, 'INVALID_REQUEST', message);
    }
  });

  app.delete('/v1/matches/queue', async (request, reply) => {
    const claims = await authenticateRestRequest(request, reply);
    if (claims === null) {
      return;
    }

    const query = request.query as Record<string, unknown>;
    const gameId = getQueryStringValue(query.gameId);
    if (gameId === null) {
      sendRestApiError(reply, 400, 'INVALID_REQUEST', 'gameId is required');
      return;
    }

    await matchQueueService.leave(claims.uid, gameId);
    reply.status(204).send();
  });

  app.get('/v1/matches/queue/status', async (request, reply) => {
    const claims = await authenticateRestRequest(request, reply);
    if (claims === null) {
      return;
    }

    const query = request.query as Record<string, unknown>;
    const gameId = getQueryStringValue(query.gameId);
    if (gameId === null) {
      sendRestApiError(reply, 400, 'INVALID_REQUEST', 'gameId is required');
      return;
    }

    const status = await matchQueueService.getStatus(claims.uid, gameId);
    if (status === null) {
      sendRestApiError(reply, 404, 'NOT_FOUND', 'Queue entry was not found');
      return;
    }

    return status;
  });

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

  app.get('/v1/matches', async (request, reply) => {
    const claims = await authenticateRestRequest(request, reply);
    if (claims === null) {
      return;
    }

    const query = request.query as Record<string, unknown>;
    const agentId = getQueryStringValue(query.agentId) ?? undefined;
    const cursor = getQueryStringValue(query.cursor) ?? undefined;
    const limitValue = parsePositiveIntegerQueryValue(getQueryStringValue(query.limit), 100);

    if (limitValue === null || limitValue > 100) {
      sendRestApiError(reply, 400, 'INVALID_REQUEST', 'limit must be between 1 and 100');
      return;
    }

    try {
      const matches = await matchRepository.listByParticipant(claims.uid, agentId);
      return listMatchesPage(matches, limitValue, cursor);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list matches';
      if (message === 'Invalid cursor') {
        sendRestApiError(reply, 400, 'INVALID_REQUEST', message);
        return;
      }

      request.log.error({ error }, 'Failed to list matches');
      sendRestApiError(reply, 500, 'INTERNAL_ERROR', 'Failed to list matches');
    }
  });

  app.get<{ Params: { matchId: string } }>('/v1/matches/:matchId', async (request, reply) => {
    const { matchId } = request.params;
    const match = await matchRepository.get(matchId);
    if (match === null) {
      reply.status(404).send({ status: 'error', message: 'Match not found' });
      return;
    }
    return { status: 'ok', match };
  });

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

      // Update match status in repository
      void updateMatchOnConnect(session).catch((err: unknown) => {
        app.log.warn(
          { error: err, matchId: session.matchId },
          'Failed to update match status on agent connect',
        );
      });

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

  const adminRouteRedis = process.env.NODE_ENV === 'test' && !options.redis ? undefined : redis;
  await registerAdminRoutes(app, {
    ...(internalTaskAuthToken !== undefined ? { internalTaskAuthToken } : {}),
    ...(adminRouteRedis !== undefined ? { redis: adminRouteRedis } : {}),
  });

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

export type { MatchLifecycleNotifier } from './notifications/match-lifecycle-webhooks.js';
export type { SpectatorLatencyRecorder } from './spectator/latency-recorder.js';
