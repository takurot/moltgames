import { describe, expect, it } from 'vitest';

import {
  DeviceAuthError,
  DeviceAuthService,
  InMemoryDeviceAuthSessionStore,
  type DeviceFlowClock,
} from '../../../src/auth/device-flow.js';

class FixedClock implements DeviceFlowClock {
  #epochMs: number;

  constructor(iso8601: string) {
    this.#epochMs = new Date(iso8601).getTime();
  }

  now(): Date {
    return new Date(this.#epochMs);
  }

  advanceSeconds(seconds: number): void {
    this.#epochMs += seconds * 1000;
  }
}

describe('device auth service', () => {
  it('issues a pending device authorization session', async () => {
    const clock = new FixedClock('2026-03-28T00:00:00.000Z');
    const service = new DeviceAuthService({
      clock,
      store: new InMemoryDeviceAuthSessionStore(clock),
      verificationUri: 'https://moltgame.com/activate',
    });

    const session = await service.issueAuthorization();

    expect(session.deviceCode).toBeTypeOf('string');
    expect(session.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(session.verificationUri).toBe('https://moltgame.com/activate');
    expect(session.expiresIn).toBe(600);
    expect(session.interval).toBe(5);
  });

  it('returns pending until activation completes and then exchanges tokens once', async () => {
    const clock = new FixedClock('2026-03-28T00:00:00.000Z');
    const service = new DeviceAuthService({
      clock,
      store: new InMemoryDeviceAuthSessionStore(clock),
      verificationUri: 'https://moltgame.com/activate',
    });

    const session = await service.issueAuthorization();

    await expect(service.exchangeToken(session.deviceCode)).rejects.toMatchObject<DeviceAuthError>({
      code: 'AUTHORIZATION_PENDING',
    });

    await service.activateAuthorization({
      deviceCode: session.deviceCode,
      userCode: session.userCode,
      uid: 'user-1',
      idToken: 'firebase-id-token',
      refreshToken: 'firebase-refresh-token',
      expiresIn: 3600,
    });

    await expect(service.exchangeToken(session.deviceCode)).resolves.toEqual({
      uid: 'user-1',
      idToken: 'firebase-id-token',
      refreshToken: 'firebase-refresh-token',
      expiresIn: 3600,
      tokenType: 'Bearer',
    });

    await expect(service.exchangeToken(session.deviceCode)).rejects.toMatchObject<DeviceAuthError>({
      code: 'AUTHORIZATION_ALREADY_CONSUMED',
    });
  });

  it('rejects activation and exchange after the device code expires', async () => {
    const clock = new FixedClock('2026-03-28T00:00:00.000Z');
    const service = new DeviceAuthService({
      clock,
      store: new InMemoryDeviceAuthSessionStore(clock),
      verificationUri: 'https://moltgame.com/activate',
    });

    const session = await service.issueAuthorization();
    clock.advanceSeconds(601);

    await expect(
      service.activateAuthorization({
        deviceCode: session.deviceCode,
        userCode: session.userCode,
        uid: 'user-1',
        idToken: 'firebase-id-token',
        refreshToken: 'firebase-refresh-token',
        expiresIn: 3600,
      }),
    ).rejects.toMatchObject<DeviceAuthError>({
      code: 'EXPIRED_TOKEN',
    });

    await expect(service.exchangeToken(session.deviceCode)).rejects.toMatchObject<DeviceAuthError>({
      code: 'EXPIRED_TOKEN',
    });
  });
});
