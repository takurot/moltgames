import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { hasRole, type GatewayRole } from './rbac.js';

export const CONNECT_TOKEN_TTL_SECONDS = 5 * 60;
export const CONNECT_TOKEN_SESSION_KEY_PREFIX = 'session:';
export const CONNECT_TOKEN_LOOKUP_KEY_PREFIX = 'session-token-id:';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface ConnectTokenClaims {
  tokenId: string;
  uid: string;
  matchId: string;
  agentId: string;
  issuedAt: number;
  expiresAt: number;
}

export type ConnectTokenSessionStatus = 'ISSUED' | 'USED' | 'REVOKED';

export interface ConnectTokenSession extends ConnectTokenClaims {
  connectToken: string;
  status: ConnectTokenSessionStatus;
  usedAt?: number;
  revokedAt?: number;
}

export interface ConnectTokenSessionStore {
  save(session: ConnectTokenSession): Promise<void>;
  findByConnectToken(connectToken: string): Promise<ConnectTokenSession | null>;
  findByTokenId(tokenId: string): Promise<ConnectTokenSession | null>;
  update(session: ConnectTokenSession): Promise<void>;
}

export type ConnectTokenErrorCode =
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_NOT_FOUND'
  | 'TOKEN_ALREADY_USED'
  | 'TOKEN_REVOKED'
  | 'TOKEN_FORBIDDEN';

export class ConnectTokenError extends Error {
  readonly code: ConnectTokenErrorCode;

  constructor(code: ConnectTokenErrorCode, message: string) {
    super(message);
    this.name = 'ConnectTokenError';
    this.code = code;
  }
}

export interface ConnectTokenServiceOptions {
  secret: string;
  store: ConnectTokenSessionStore;
  clock?: Clock;
  ttlSeconds?: number;
}

export interface IssueConnectTokenInput {
  uid: string;
  matchId: string;
  agentId: string;
}

export interface IssueConnectTokenResult {
  tokenId: string;
  connectToken: string;
  issuedAt: number;
  expiresAt: number;
}

export interface RevokeConnectTokenInput {
  tokenId: string;
  requesterUid: string;
  requesterRoles: readonly GatewayRole[];
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const toUnixSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

const encodeBase64Url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

const decodeBase64Url = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');

const cloneSession = (session: ConnectTokenSession): ConnectTokenSession => {
  const copy: ConnectTokenSession = {
    tokenId: session.tokenId,
    uid: session.uid,
    matchId: session.matchId,
    agentId: session.agentId,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    connectToken: session.connectToken,
    status: session.status,
  };

  if (session.usedAt !== undefined) {
    copy.usedAt = session.usedAt;
  }

  if (session.revokedAt !== undefined) {
    copy.revokedAt = session.revokedAt;
  }

  return copy;
};

const isConnectTokenClaims = (value: unknown): value is ConnectTokenClaims => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as Partial<ConnectTokenClaims>;

  return (
    isNonEmptyString(payload.tokenId) &&
    isNonEmptyString(payload.uid) &&
    isNonEmptyString(payload.matchId) &&
    isNonEmptyString(payload.agentId) &&
    typeof payload.issuedAt === 'number' &&
    Number.isInteger(payload.issuedAt) &&
    typeof payload.expiresAt === 'number' &&
    Number.isInteger(payload.expiresAt) &&
    payload.expiresAt >= payload.issuedAt
  );
};

export class InMemoryConnectTokenSessionStore implements ConnectTokenSessionStore {
  readonly #clock: Clock;
  readonly #sessionsByToken = new Map<string, ConnectTokenSession>();
  readonly #tokenById = new Map<string, string>();

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  async save(session: ConnectTokenSession): Promise<void> {
    const key = this.#buildSessionKey(session.connectToken);
    this.#sessionsByToken.set(key, cloneSession(session));
    this.#tokenById.set(this.#buildLookupKey(session.tokenId), session.connectToken);
  }

  async findByConnectToken(connectToken: string): Promise<ConnectTokenSession | null> {
    const key = this.#buildSessionKey(connectToken);
    const session = this.#sessionsByToken.get(key);

    if (session === undefined) {
      return null;
    }

    if (this.#isExpired(session)) {
      this.#deleteSession(session);
      return null;
    }

    return cloneSession(session);
  }

  async findByTokenId(tokenId: string): Promise<ConnectTokenSession | null> {
    const lookupKey = this.#buildLookupKey(tokenId);
    const connectToken = this.#tokenById.get(lookupKey);

    if (connectToken === undefined) {
      return null;
    }

    return this.findByConnectToken(connectToken);
  }

  async update(session: ConnectTokenSession): Promise<void> {
    const key = this.#buildSessionKey(session.connectToken);

    if (!this.#sessionsByToken.has(key)) {
      throw new ConnectTokenError(
        'TOKEN_NOT_FOUND',
        `Connect token ${session.tokenId} was not found`,
      );
    }

    this.#sessionsByToken.set(key, cloneSession(session));
    this.#tokenById.set(this.#buildLookupKey(session.tokenId), session.connectToken);
  }

  #isExpired(session: ConnectTokenSession): boolean {
    const now = toUnixSeconds(this.#clock.now());
    return now >= session.expiresAt;
  }

  #deleteSession(session: ConnectTokenSession): void {
    this.#sessionsByToken.delete(this.#buildSessionKey(session.connectToken));
    this.#tokenById.delete(this.#buildLookupKey(session.tokenId));
  }

  #buildSessionKey(connectToken: string): string {
    return `${CONNECT_TOKEN_SESSION_KEY_PREFIX}${connectToken}`;
  }

  #buildLookupKey(tokenId: string): string {
    return `${CONNECT_TOKEN_LOOKUP_KEY_PREFIX}${tokenId}`;
  }
}

export class ConnectTokenService {
  readonly #secret: string;
  readonly #store: ConnectTokenSessionStore;
  readonly #clock: Clock;
  readonly #ttlSeconds: number;

  constructor(options: ConnectTokenServiceOptions) {
    if (!isNonEmptyString(options.secret)) {
      throw new Error('ConnectTokenService secret must be a non-empty string');
    }

    this.#secret = options.secret;
    this.#store = options.store;
    this.#clock = options.clock ?? systemClock;
    this.#ttlSeconds = options.ttlSeconds ?? CONNECT_TOKEN_TTL_SECONDS;

    if (!Number.isInteger(this.#ttlSeconds) || this.#ttlSeconds <= 0) {
      throw new Error('ConnectTokenService ttlSeconds must be a positive integer');
    }
  }

  async issueToken(input: IssueConnectTokenInput): Promise<IssueConnectTokenResult> {
    if (
      !isNonEmptyString(input.uid) ||
      !isNonEmptyString(input.matchId) ||
      !isNonEmptyString(input.agentId)
    ) {
      throw new ConnectTokenError('TOKEN_INVALID', 'uid, matchId and agentId are required');
    }

    const issuedAt = toUnixSeconds(this.#clock.now());
    const claims: ConnectTokenClaims = {
      tokenId: randomUUID(),
      uid: input.uid,
      matchId: input.matchId,
      agentId: input.agentId,
      issuedAt,
      expiresAt: issuedAt + this.#ttlSeconds,
    };

    const connectToken = this.#signClaims(claims);
    const session: ConnectTokenSession = {
      ...claims,
      connectToken,
      status: 'ISSUED',
    };

    await this.#store.save(session);

    return {
      tokenId: claims.tokenId,
      connectToken,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    };
  }

  async verifyToken(connectToken: string): Promise<ConnectTokenSession> {
    const session = await this.#resolveActiveSession(connectToken);
    return session;
  }

  async consumeToken(connectToken: string): Promise<ConnectTokenSession> {
    const session = await this.#resolveActiveSession(connectToken);
    const usedAt = toUnixSeconds(this.#clock.now());
    const consumedSession: ConnectTokenSession = {
      ...session,
      status: 'USED',
      usedAt,
    };

    await this.#store.update(consumedSession);
    return consumedSession;
  }

  async revokeToken(input: RevokeConnectTokenInput): Promise<void> {
    const session = await this.#store.findByTokenId(input.tokenId);

    if (session === null) {
      throw new ConnectTokenError(
        'TOKEN_NOT_FOUND',
        `Connect token ${input.tokenId} was not found`,
      );
    }

    const isOwner = input.requesterUid === session.uid;
    const isAdmin = hasRole(input.requesterRoles, 'admin');

    if (!isOwner && !isAdmin) {
      throw new ConnectTokenError('TOKEN_FORBIDDEN', 'Only token owner or admin can revoke token');
    }

    if (session.status === 'REVOKED') {
      return;
    }

    const revokedAt = toUnixSeconds(this.#clock.now());
    const revokedSession: ConnectTokenSession = {
      ...session,
      status: 'REVOKED',
      revokedAt,
    };

    await this.#store.update(revokedSession);
  }

  async #resolveActiveSession(connectToken: string): Promise<ConnectTokenSession> {
    const claims = this.#parseAndVerifySignedToken(connectToken);
    const now = toUnixSeconds(this.#clock.now());

    if (now >= claims.expiresAt) {
      throw new ConnectTokenError('TOKEN_EXPIRED', 'Connect token is expired');
    }

    const session = await this.#store.findByConnectToken(connectToken);

    if (session === null) {
      throw new ConnectTokenError('TOKEN_NOT_FOUND', 'Connect token session was not found');
    }

    if (
      session.tokenId !== claims.tokenId ||
      session.uid !== claims.uid ||
      session.matchId !== claims.matchId ||
      session.agentId !== claims.agentId ||
      session.issuedAt !== claims.issuedAt ||
      session.expiresAt !== claims.expiresAt
    ) {
      throw new ConnectTokenError('TOKEN_INVALID', 'Connect token payload mismatch');
    }

    if (session.status === 'REVOKED') {
      throw new ConnectTokenError('TOKEN_REVOKED', 'Connect token was revoked');
    }

    if (session.status === 'USED') {
      throw new ConnectTokenError('TOKEN_ALREADY_USED', 'Connect token was already used');
    }

    if (now >= session.expiresAt) {
      throw new ConnectTokenError('TOKEN_EXPIRED', 'Connect token is expired');
    }

    return session;
  }

  #signClaims(claims: ConnectTokenClaims): string {
    const payloadSegment = encodeBase64Url(JSON.stringify(claims));
    const signatureSegment = this.#signPayloadSegment(payloadSegment);
    return `${payloadSegment}.${signatureSegment}`;
  }

  #parseAndVerifySignedToken(connectToken: string): ConnectTokenClaims {
    if (!isNonEmptyString(connectToken)) {
      throw new ConnectTokenError('TOKEN_INVALID', 'Connect token must be non-empty');
    }

    const segments = connectToken.split('.');

    if (segments.length !== 2) {
      throw new ConnectTokenError('TOKEN_INVALID', 'Connect token has an invalid format');
    }

    const [payloadSegment, signatureSegment] = segments;

    if (payloadSegment === undefined || signatureSegment === undefined) {
      throw new ConnectTokenError('TOKEN_INVALID', 'Connect token has an invalid format');
    }

    const expectedSignatureSegment = this.#signPayloadSegment(payloadSegment);

    const expectedBuffer = Buffer.from(expectedSignatureSegment, 'base64url');
    const actualBuffer = Buffer.from(signatureSegment, 'base64url');

    if (
      expectedBuffer.length !== actualBuffer.length ||
      !timingSafeEqual(expectedBuffer, actualBuffer)
    ) {
      throw new ConnectTokenError('TOKEN_INVALID', 'Connect token signature is invalid');
    }

    let decodedPayload: unknown;

    try {
      decodedPayload = JSON.parse(decodeBase64Url(payloadSegment));
    } catch {
      throw new ConnectTokenError('TOKEN_INVALID', 'Connect token payload is not valid JSON');
    }

    if (!isConnectTokenClaims(decodedPayload)) {
      throw new ConnectTokenError('TOKEN_INVALID', 'Connect token payload is invalid');
    }

    return decodedPayload;
  }

  #signPayloadSegment(payloadSegment: string): string {
    return createHmac('sha256', this.#secret).update(payloadSegment).digest('base64url');
  }
}
