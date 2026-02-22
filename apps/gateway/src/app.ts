import { randomUUID } from 'node:crypto';

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
import type { JsonValue } from '@moltgames/domain';
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

class MockFirebaseVerifier implements FirebaseIdTokenVerifier {
  async verifyIdToken(_idToken: string): Promise<VerifiedFirebaseIdToken> {
    return {
      uid: 'test-user',
      providerId: 'google.com',
      customClaims: {},
    };
  }
}

export interface AppOptions {
  redis?: Redis;
  verifier?: FirebaseIdTokenVerifier;
  engineClient?: GatewayEngineClient;
  reconnectGraceMs?: number;
}

export interface GatewayEngineClient {
  getTools(matchId: string, agentId: string): Promise<MCPToolDefinition[]>;
  callTool(
    matchId: string,
    request: {
      tool: string;
      request_id: string;
      args: Record<string, JsonValue>;
    },
  ): Promise<ToolCallResponse>;
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

const SUPPORTED_WS_PROTOCOL = 'moltgame.v1';
const DEFAULT_ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8081';
const DEFAULT_RECONNECT_GRACE_MS = 20_000;
const RECONNECT_BACKOFF_INITIAL_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 8_000;

const toSessionLookupKey = (matchId: string, agentId: string): string => `${matchId}:${agentId}`;

const createDefaultEngineClient = (): GatewayEngineClient => {
  const client = new EngineClient({ engineUrl: DEFAULT_ENGINE_URL });

  return {
    getTools: async (matchId, _agentId) => {
      const response = await client.post<{ status: 'ok'; tools: unknown[] }>(
        `/matches/${encodeURIComponent(matchId)}/tools`,
        {},
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
      client.post<ToolCallResponse>(`/matches/${encodeURIComponent(matchId)}/action`, request),
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

const serializeTools = (tools: MCPToolDefinition[]): string => JSON.stringify(tools);

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
  const app = Fastify({
    logger: loggerOptions,
    trustProxy: true,
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

  await app.register(rateLimit, {
    max: 5,
    timeWindow: 10000,
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      if (auth && auth.startsWith('Bearer ')) {
        return auth.substring(7);
      }
      return req.ip;
    },
  });

  await app.register(websocket);

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
    if (process.env.NODE_ENV === 'test' || process.env.MOCK_AUTH === 'true') {
      verifier = new MockFirebaseVerifier();
    } else {
      if (getApps().length === 0) {
        initializeApp();
      }
      verifier = new FirebaseAuthVerifier(getAuth());
    }
  }

  const store =
    process.env.NODE_ENV === 'test' && !options.redis
      ? new InMemoryConnectTokenSessionStore()
      : new RedisConnectTokenSessionStore(redis);

  const service = new ConnectTokenService({
    store,
    secret: process.env.CONNECT_TOKEN_SECRET || 'dev-secret',
  });

  const api = createConnectTokenApi({
    connectTokenService: service,
    idTokenVerifier: verifier,
  });
  const engineClient = options.engineClient ?? createDefaultEngineClient();
  const reconnectGraceMs = options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;

  const sessionsById = new Map<string, AgentSession>();
  const sessionIdByMatchAgent = new Map<string, string>();

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

        const response = await engineClient.callTool(
          session.matchId,
          request as {
            tool: string;
            request_id: string;
            args: Record<string, JsonValue>;
          },
        );

        const normalizedResponse = isToolCallResponse(response)
          ? response
          : mapRuntimeErrorToToolResponse(request.request_id, new Error('Invalid engine response'));

        sendJson(socket, normalizedResponse, app.log);
        
        // Notify all agents in this match that the state/tools might have changed
        await notifyMatchSessionsOfChange(session.matchId);
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
    sessionsById.clear();
    sessionIdByMatchAgent.clear();
  });

  return app;
};
