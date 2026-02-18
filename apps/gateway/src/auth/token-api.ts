import { isNonEmptyString, isRecord } from '@moltgames/domain';

import { ConnectTokenError, ConnectTokenService } from './connect-token.js';
import { type FirebaseIdTokenVerifier, isFirebaseAuthProviderId } from './firebase-auth.js';
import { extractRolesFromCustomClaims } from './rbac.js';

export const issueConnectTokenRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['matchId', 'agentId'],
  properties: {
    matchId: { type: 'string', minLength: 1 },
    agentId: { type: 'string', minLength: 1 },
  },
} as const;

export const issueConnectTokenResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tokenId', 'connectToken', 'issuedAt', 'expiresAt'],
  properties: {
    tokenId: { type: 'string', minLength: 1 },
    connectToken: { type: 'string', minLength: 1 },
    issuedAt: { type: 'integer', minimum: 0 },
    expiresAt: { type: 'integer', minimum: 0 },
  },
} as const;

export interface IssueConnectTokenRequest {
  matchId: string;
  agentId: string;
}

export interface ConnectTokenApiDependencies {
  connectTokenService: ConnectTokenService;
  idTokenVerifier: FirebaseIdTokenVerifier;
}

export interface ConnectTokenApi {
  handle(request: Request): Promise<Response>;
}

interface AuthContext {
  uid: string;
  roles: ReturnType<typeof extractRolesFromCustomClaims>;
}

type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'SERVICE_UNAVAILABLE';

const isIssueConnectTokenRequest = (value: unknown): value is IssueConnectTokenRequest => {
  if (!isRecord(value)) {
    return false;
  }

  const keys = Object.keys(value);

  if (keys.length !== 2 || !keys.includes('matchId') || !keys.includes('agentId')) {
    return false;
  }

  return isNonEmptyString(value.matchId) && isNonEmptyString(value.agentId);
};

const parseBearerToken = (authorizationHeader: string | null): string | null => {
  if (authorizationHeader === null) {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });

const errorResponse = (status: number, code: ApiErrorCode, message: string): Response =>
  jsonResponse(status, {
    error: {
      code,
      message,
      retryable: false,
    },
  });

const mapConnectTokenError = (error: ConnectTokenError): Response => {
  switch (error.code) {
    case 'TOKEN_FORBIDDEN':
      return errorResponse(403, 'FORBIDDEN', error.message);
    case 'TOKEN_NOT_FOUND':
      return errorResponse(404, 'NOT_FOUND', error.message);
    case 'TOKEN_INVALID':
    case 'TOKEN_EXPIRED':
    case 'TOKEN_ALREADY_USED':
    case 'TOKEN_REVOKED':
      return errorResponse(400, 'INVALID_REQUEST', error.message);
  }
};

const authenticate = async (
  request: Request,
  verifier: FirebaseIdTokenVerifier,
): Promise<AuthContext> => {
  const idToken = parseBearerToken(request.headers.get('authorization'));

  if (idToken === null) {
    throw new ConnectTokenApiAuthError('UNAUTHORIZED', 'Authorization header is missing');
  }

  let verifiedToken;

  try {
    verifiedToken = await verifier.verifyIdToken(idToken);
  } catch {
    throw new ConnectTokenApiAuthError('UNAUTHORIZED', 'Invalid Firebase ID token');
  }

  if (!isFirebaseAuthProviderId(verifiedToken.providerId)) {
    throw new ConnectTokenApiAuthError('UNAUTHORIZED', 'Unsupported authentication provider');
  }

  return {
    uid: verifiedToken.uid,
    roles: extractRolesFromCustomClaims(verifiedToken.customClaims),
  };
};

class ConnectTokenApiAuthError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'ConnectTokenApiAuthError';
    this.code = code;
  }
}

const parseIssueRequestBody = async (request: Request): Promise<IssueConnectTokenRequest> => {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new ConnectTokenApiAuthError('INVALID_REQUEST', 'Request body must be valid JSON');
  }

  if (!isIssueConnectTokenRequest(body)) {
    throw new ConnectTokenApiAuthError('INVALID_REQUEST', 'matchId and agentId are required');
  }

  return body;
};

const extractTokenIdFromPath = (pathname: string): string | null => {
  const match = pathname.match(/^\/v1\/tokens\/([^/]+)$/);
  const tokenId = match?.[1];

  if (!isNonEmptyString(tokenId)) {
    return null;
  }

  return tokenId;
};

export const createConnectTokenApi = (
  dependencies: ConnectTokenApiDependencies,
): ConnectTokenApi => ({
  handle: async (request) => {
    const url = new URL(request.url);

    try {
      if (request.method === 'POST' && url.pathname === '/v1/tokens') {
        const authContext = await authenticate(request, dependencies.idTokenVerifier);
        const issueRequest = await parseIssueRequestBody(request);
        const result = await dependencies.connectTokenService.issueToken({
          uid: authContext.uid,
          matchId: issueRequest.matchId,
          agentId: issueRequest.agentId,
        });

        return jsonResponse(201, result);
      }

      if (request.method === 'DELETE') {
        const tokenId = extractTokenIdFromPath(url.pathname);

        if (tokenId !== null) {
          const authContext = await authenticate(request, dependencies.idTokenVerifier);
          await dependencies.connectTokenService.revokeToken({
            tokenId,
            requesterUid: authContext.uid,
            requesterRoles: authContext.roles,
          });

          return new Response(null, { status: 204 });
        }
      }
    } catch (error) {
      if (error instanceof ConnectTokenApiAuthError) {
        const status = error.code === 'UNAUTHORIZED' ? 401 : 400;
        return errorResponse(status, error.code, error.message);
      }

      if (error instanceof ConnectTokenError) {
        return mapConnectTokenError(error);
      }

      return errorResponse(503, 'SERVICE_UNAVAILABLE', 'Service unavailable');
    }

    return errorResponse(404, 'NOT_FOUND', 'Endpoint not found');
  },
});
