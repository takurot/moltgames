import { randomBytes, randomUUID } from 'node:crypto';

import { type Redis } from 'ioredis';

export const DEVICE_AUTH_TTL_SECONDS = 10 * 60;
export const DEVICE_AUTH_POLL_INTERVAL_SECONDS = 5;
const DEVICE_AUTH_KNOWN_TTL_SECONDS = 60 * 60;
const DEVICE_AUTH_KEY_PREFIX = 'device:';
const DEVICE_AUTH_USER_CODE_KEY_PREFIX = 'device-user-code:';
const DEVICE_AUTH_KNOWN_DEVICE_KEY_PREFIX = 'device-known:';
const DEVICE_AUTH_KNOWN_USER_CODE_KEY_PREFIX = 'device-known-user-code:';
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface DeviceFlowClock {
  now(): Date;
}

export const systemDeviceFlowClock: DeviceFlowClock = {
  now: () => new Date(),
};

export type DeviceAuthorizationStatus = 'PENDING' | 'APPROVED' | 'CONSUMED';

export interface DeviceAuthorizationSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  issuedAt: number;
  expiresAt: number;
  interval: number;
  status: DeviceAuthorizationStatus;
  uid?: string;
  idToken?: string;
  refreshToken?: string;
  tokenExpiresIn?: number;
  approvedAt?: number;
  consumedAt?: number;
}

export interface IssueDeviceAuthorizationResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface ActivateDeviceAuthorizationInput {
  userCode: string;
  uid: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
  deviceCode?: string;
}

export interface ExchangeDeviceAuthorizationResult {
  uid: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface DeviceAuthSessionStore {
  save(session: DeviceAuthorizationSession): Promise<void>;
  findByDeviceCode(deviceCode: string): Promise<DeviceAuthorizationSession | null>;
  findByUserCode(userCode: string): Promise<DeviceAuthorizationSession | null>;
  update(session: DeviceAuthorizationSession): Promise<void>;
  hasKnownDeviceCode(deviceCode: string): Promise<boolean>;
  hasKnownUserCode(userCode: string): Promise<boolean>;
}

export type DeviceAuthErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'AUTHORIZATION_PENDING'
  | 'AUTHORIZATION_ALREADY_CONSUMED'
  | 'EXPIRED_TOKEN';

export class DeviceAuthError extends Error {
  readonly code: DeviceAuthErrorCode;

  constructor(code: DeviceAuthErrorCode, message: string) {
    super(message);
    this.name = 'DeviceAuthError';
    this.code = code;
  }
}

export interface DeviceAuthServiceOptions {
  store: DeviceAuthSessionStore;
  verificationUri: string;
  clock?: DeviceFlowClock;
  ttlSeconds?: number;
  intervalSeconds?: number;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const toUnixSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

const cloneSession = (session: DeviceAuthorizationSession): DeviceAuthorizationSession => ({
  ...session,
});

const createUserCode = (): string => {
  const bytes = randomBytes(8);
  let code = '';

  for (let index = 0; index < 8; index += 1) {
    const value = bytes[index];
    if (value === undefined) {
      continue;
    }
    code += USER_CODE_ALPHABET[value % USER_CODE_ALPHABET.length];
  }

  return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
};

const isDeviceAuthorizationSession = (value: unknown): value is DeviceAuthorizationSession => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<DeviceAuthorizationSession>;
  return (
    isNonEmptyString(candidate.deviceCode) &&
    isNonEmptyString(candidate.userCode) &&
    isNonEmptyString(candidate.verificationUri) &&
    typeof candidate.issuedAt === 'number' &&
    Number.isInteger(candidate.issuedAt) &&
    typeof candidate.expiresAt === 'number' &&
    Number.isInteger(candidate.expiresAt) &&
    typeof candidate.interval === 'number' &&
    Number.isInteger(candidate.interval) &&
    (candidate.status === 'PENDING' ||
      candidate.status === 'APPROVED' ||
      candidate.status === 'CONSUMED')
  );
};

export class InMemoryDeviceAuthSessionStore implements DeviceAuthSessionStore {
  readonly #clock: DeviceFlowClock;
  readonly #sessionsByDeviceCode = new Map<string, DeviceAuthorizationSession>();
  readonly #deviceCodeByUserCode = new Map<string, string>();
  readonly #knownDeviceCodes = new Map<string, number>();
  readonly #knownUserCodes = new Map<string, number>();

  constructor(clock: DeviceFlowClock = systemDeviceFlowClock) {
    this.#clock = clock;
  }

  async save(session: DeviceAuthorizationSession): Promise<void> {
    this.#sessionsByDeviceCode.set(session.deviceCode, cloneSession(session));
    this.#deviceCodeByUserCode.set(session.userCode, session.deviceCode);
    this.#knownDeviceCodes.set(
      session.deviceCode,
      session.expiresAt + DEVICE_AUTH_KNOWN_TTL_SECONDS,
    );
    this.#knownUserCodes.set(session.userCode, session.expiresAt + DEVICE_AUTH_KNOWN_TTL_SECONDS);
  }

  async findByDeviceCode(deviceCode: string): Promise<DeviceAuthorizationSession | null> {
    this.#cleanupKnownMaps();

    const session = this.#sessionsByDeviceCode.get(deviceCode);
    if (session === undefined) {
      return null;
    }

    if (this.#isExpired(session)) {
      this.#deleteActiveSession(session);
      return null;
    }

    return cloneSession(session);
  }

  async findByUserCode(userCode: string): Promise<DeviceAuthorizationSession | null> {
    this.#cleanupKnownMaps();

    const deviceCode = this.#deviceCodeByUserCode.get(userCode);
    if (deviceCode === undefined) {
      return null;
    }

    return this.findByDeviceCode(deviceCode);
  }

  async update(session: DeviceAuthorizationSession): Promise<void> {
    if (!this.#sessionsByDeviceCode.has(session.deviceCode)) {
      throw new DeviceAuthError('NOT_FOUND', 'Device authorization session was not found');
    }

    this.#sessionsByDeviceCode.set(session.deviceCode, cloneSession(session));
    this.#deviceCodeByUserCode.set(session.userCode, session.deviceCode);
  }

  async hasKnownDeviceCode(deviceCode: string): Promise<boolean> {
    this.#cleanupKnownMaps();
    return this.#knownDeviceCodes.has(deviceCode);
  }

  async hasKnownUserCode(userCode: string): Promise<boolean> {
    this.#cleanupKnownMaps();
    return this.#knownUserCodes.has(userCode);
  }

  #isExpired(session: DeviceAuthorizationSession): boolean {
    return toUnixSeconds(this.#clock.now()) >= session.expiresAt;
  }

  #deleteActiveSession(session: DeviceAuthorizationSession): void {
    this.#sessionsByDeviceCode.delete(session.deviceCode);
    this.#deviceCodeByUserCode.delete(session.userCode);
  }

  #cleanupKnownMaps(): void {
    const now = toUnixSeconds(this.#clock.now());

    for (const [deviceCode, expiresAt] of this.#knownDeviceCodes.entries()) {
      if (now >= expiresAt) {
        this.#knownDeviceCodes.delete(deviceCode);
      }
    }

    for (const [userCode, expiresAt] of this.#knownUserCodes.entries()) {
      if (now >= expiresAt) {
        this.#knownUserCodes.delete(userCode);
      }
    }
  }
}

export class RedisDeviceAuthSessionStore implements DeviceAuthSessionStore {
  readonly #redis: Redis;
  readonly #clock: DeviceFlowClock;

  constructor(redis: Redis, clock: DeviceFlowClock = systemDeviceFlowClock) {
    this.#redis = redis;
    this.#clock = clock;
  }

  async save(session: DeviceAuthorizationSession): Promise<void> {
    const ttl = this.#calculateTtl(session.expiresAt);
    if (ttl <= 0) {
      return;
    }

    const pipeline = this.#redis.pipeline();
    pipeline.set(this.#sessionKey(session.deviceCode), JSON.stringify(session), 'EX', ttl);
    pipeline.set(this.#userLookupKey(session.userCode), session.deviceCode, 'EX', ttl);
    pipeline.set(
      this.#knownDeviceKey(session.deviceCode),
      '1',
      'EX',
      DEVICE_AUTH_KNOWN_TTL_SECONDS,
    );
    pipeline.set(
      this.#knownUserCodeKey(session.userCode),
      '1',
      'EX',
      DEVICE_AUTH_KNOWN_TTL_SECONDS,
    );
    await pipeline.exec();
  }

  async findByDeviceCode(deviceCode: string): Promise<DeviceAuthorizationSession | null> {
    const raw = await this.#redis.get(this.#sessionKey(deviceCode));
    return this.#parseSession(raw);
  }

  async findByUserCode(userCode: string): Promise<DeviceAuthorizationSession | null> {
    const deviceCode = await this.#redis.get(this.#userLookupKey(userCode));
    if (!deviceCode) {
      return null;
    }

    return this.findByDeviceCode(deviceCode);
  }

  async update(session: DeviceAuthorizationSession): Promise<void> {
    const exists = await this.#redis.exists(this.#sessionKey(session.deviceCode));
    if (!exists) {
      throw new DeviceAuthError('NOT_FOUND', 'Device authorization session was not found');
    }

    const ttl = this.#calculateTtl(session.expiresAt);
    const pipeline = this.#redis.pipeline();
    if (ttl <= 0) {
      pipeline.del(this.#sessionKey(session.deviceCode));
      pipeline.del(this.#userLookupKey(session.userCode));
    } else {
      pipeline.set(this.#sessionKey(session.deviceCode), JSON.stringify(session), 'EX', ttl);
      pipeline.set(this.#userLookupKey(session.userCode), session.deviceCode, 'EX', ttl);
    }
    pipeline.expire(this.#knownDeviceKey(session.deviceCode), DEVICE_AUTH_KNOWN_TTL_SECONDS);
    pipeline.expire(this.#knownUserCodeKey(session.userCode), DEVICE_AUTH_KNOWN_TTL_SECONDS);
    await pipeline.exec();
  }

  async hasKnownDeviceCode(deviceCode: string): Promise<boolean> {
    return (await this.#redis.exists(this.#knownDeviceKey(deviceCode))) === 1;
  }

  async hasKnownUserCode(userCode: string): Promise<boolean> {
    return (await this.#redis.exists(this.#knownUserCodeKey(userCode))) === 1;
  }

  #calculateTtl(expiresAt: number): number {
    return Math.max(0, expiresAt - toUnixSeconds(this.#clock.now()));
  }

  #parseSession(raw: string | null): DeviceAuthorizationSession | null {
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return isDeviceAuthorizationSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  #sessionKey(deviceCode: string): string {
    return `${DEVICE_AUTH_KEY_PREFIX}${deviceCode}`;
  }

  #userLookupKey(userCode: string): string {
    return `${DEVICE_AUTH_USER_CODE_KEY_PREFIX}${userCode}`;
  }

  #knownDeviceKey(deviceCode: string): string {
    return `${DEVICE_AUTH_KNOWN_DEVICE_KEY_PREFIX}${deviceCode}`;
  }

  #knownUserCodeKey(userCode: string): string {
    return `${DEVICE_AUTH_KNOWN_USER_CODE_KEY_PREFIX}${userCode}`;
  }
}

export class DeviceAuthService {
  readonly #store: DeviceAuthSessionStore;
  readonly #verificationUri: string;
  readonly #clock: DeviceFlowClock;
  readonly #ttlSeconds: number;
  readonly #intervalSeconds: number;

  constructor(options: DeviceAuthServiceOptions) {
    if (!isNonEmptyString(options.verificationUri)) {
      throw new Error('verificationUri must be a non-empty string');
    }

    this.#store = options.store;
    this.#verificationUri = options.verificationUri;
    this.#clock = options.clock ?? systemDeviceFlowClock;
    this.#ttlSeconds = options.ttlSeconds ?? DEVICE_AUTH_TTL_SECONDS;
    this.#intervalSeconds = options.intervalSeconds ?? DEVICE_AUTH_POLL_INTERVAL_SECONDS;
  }

  async issueAuthorization(): Promise<IssueDeviceAuthorizationResult> {
    const issuedAt = toUnixSeconds(this.#clock.now());
    const expiresAt = issuedAt + this.#ttlSeconds;
    let userCode = createUserCode();

    while (await this.#store.hasKnownUserCode(userCode)) {
      userCode = createUserCode();
    }

    const session: DeviceAuthorizationSession = {
      deviceCode: randomUUID(),
      userCode,
      verificationUri: this.#verificationUri,
      issuedAt,
      expiresAt,
      interval: this.#intervalSeconds,
      status: 'PENDING',
    };

    await this.#store.save(session);

    return {
      deviceCode: session.deviceCode,
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      expiresIn: this.#ttlSeconds,
      interval: session.interval,
    };
  }

  async activateAuthorization(input: ActivateDeviceAuthorizationInput): Promise<void> {
    this.#validateActivationInput(input);

    const session = await this.#store.findByUserCode(input.userCode);
    if (session === null) {
      if (await this.#store.hasKnownUserCode(input.userCode)) {
        throw new DeviceAuthError('EXPIRED_TOKEN', 'Device authorization session is expired');
      }
      throw new DeviceAuthError('NOT_FOUND', 'Device authorization session was not found');
    }

    this.#assertNotExpired(session);

    if (input.deviceCode !== undefined && input.deviceCode !== session.deviceCode) {
      throw new DeviceAuthError('INVALID_REQUEST', 'deviceCode does not match the userCode');
    }

    if (session.status === 'CONSUMED') {
      throw new DeviceAuthError(
        'AUTHORIZATION_ALREADY_CONSUMED',
        'Device authorization session was already consumed',
      );
    }

    await this.#store.update({
      ...session,
      status: 'APPROVED',
      uid: input.uid,
      idToken: input.idToken,
      refreshToken: input.refreshToken,
      tokenExpiresIn: input.expiresIn,
      approvedAt: toUnixSeconds(this.#clock.now()),
    });
  }

  async exchangeToken(deviceCode: string): Promise<ExchangeDeviceAuthorizationResult> {
    if (!isNonEmptyString(deviceCode)) {
      throw new DeviceAuthError('INVALID_REQUEST', 'deviceCode is required');
    }

    const session = await this.#store.findByDeviceCode(deviceCode);
    if (session === null) {
      if (await this.#store.hasKnownDeviceCode(deviceCode)) {
        throw new DeviceAuthError('EXPIRED_TOKEN', 'Device authorization session is expired');
      }
      throw new DeviceAuthError('NOT_FOUND', 'Device authorization session was not found');
    }

    this.#assertNotExpired(session);

    if (session.status === 'PENDING') {
      throw new DeviceAuthError('AUTHORIZATION_PENDING', 'Device authorization is still pending');
    }

    if (session.status === 'CONSUMED') {
      throw new DeviceAuthError(
        'AUTHORIZATION_ALREADY_CONSUMED',
        'Device authorization session was already consumed',
      );
    }

    if (
      !isNonEmptyString(session.uid) ||
      !isNonEmptyString(session.idToken) ||
      !isNonEmptyString(session.refreshToken) ||
      typeof session.tokenExpiresIn !== 'number'
    ) {
      throw new DeviceAuthError(
        'INVALID_REQUEST',
        'Approved device authorization session is missing token details',
      );
    }

    await this.#store.update({
      ...session,
      status: 'CONSUMED',
      consumedAt: toUnixSeconds(this.#clock.now()),
    });

    return {
      uid: session.uid,
      idToken: session.idToken,
      refreshToken: session.refreshToken,
      expiresIn: session.tokenExpiresIn,
      tokenType: 'Bearer',
    };
  }

  #validateActivationInput(input: ActivateDeviceAuthorizationInput): void {
    if (
      !isNonEmptyString(input.userCode) ||
      !isNonEmptyString(input.uid) ||
      !isNonEmptyString(input.idToken) ||
      !isNonEmptyString(input.refreshToken) ||
      !Number.isInteger(input.expiresIn) ||
      input.expiresIn <= 0
    ) {
      throw new DeviceAuthError(
        'INVALID_REQUEST',
        'userCode, uid, idToken, refreshToken, and expiresIn are required',
      );
    }
  }

  #assertNotExpired(session: DeviceAuthorizationSession): void {
    if (toUnixSeconds(this.#clock.now()) >= session.expiresAt) {
      throw new DeviceAuthError('EXPIRED_TOKEN', 'Device authorization session is expired');
    }
  }
}
