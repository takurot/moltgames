import { describe, expect, it } from 'vitest';

import {
  COMMON_ERROR_CODES,
  DOMAIN_PACKAGE_NAME,
  MATCH_STATUSES,
  MATCH_TERMINAL_STATUSES,
  canTransitionMatchStatus,
  createValidatedFirestoreConverter,
  getAllowedNextMatchStatuses,
  isTerminalMatchStatus,
  ratingFirestoreConverter,
} from '../../src/index.js';

describe('domain package', () => {
  it('exports package identifier', () => {
    expect(DOMAIN_PACKAGE_NAME).toBe('@moltgames/domain');
  });

  it('contains the expected match statuses', () => {
    expect(MATCH_STATUSES).toEqual([
      'CREATED',
      'WAITING_AGENT_CONNECT',
      'READY',
      'IN_PROGRESS',
      'FINISHED',
      'ABORTED',
      'CANCELLED',
      'ARCHIVED',
    ]);
  });

  it('allows only documented normal path transitions', () => {
    expect(canTransitionMatchStatus('CREATED', 'WAITING_AGENT_CONNECT')).toBe(true);
    expect(canTransitionMatchStatus('WAITING_AGENT_CONNECT', 'READY')).toBe(true);
    expect(canTransitionMatchStatus('READY', 'IN_PROGRESS')).toBe(true);
    expect(canTransitionMatchStatus('IN_PROGRESS', 'FINISHED')).toBe(true);
    expect(canTransitionMatchStatus('FINISHED', 'ARCHIVED')).toBe(true);
  });

  it('allows only documented exceptional transitions', () => {
    expect(canTransitionMatchStatus('IN_PROGRESS', 'ABORTED')).toBe(true);
    expect(canTransitionMatchStatus('WAITING_AGENT_CONNECT', 'CANCELLED')).toBe(true);
    expect(canTransitionMatchStatus('CREATED', 'CANCELLED')).toBe(true);
  });

  it('rejects unsupported transitions and self transitions', () => {
    expect(canTransitionMatchStatus('CREATED', 'READY')).toBe(false);
    expect(canTransitionMatchStatus('READY', 'READY')).toBe(false);
    expect(canTransitionMatchStatus('FINISHED', 'IN_PROGRESS')).toBe(false);
    expect(canTransitionMatchStatus('ABORTED', 'ARCHIVED')).toBe(false);
    expect(canTransitionMatchStatus('CANCELLED', 'CREATED')).toBe(false);
    expect(canTransitionMatchStatus('ARCHIVED', 'FINISHED')).toBe(false);
  });

  it('exposes allowed next states for each status', () => {
    expect(getAllowedNextMatchStatuses('CREATED')).toEqual(['WAITING_AGENT_CONNECT', 'CANCELLED']);
    expect(getAllowedNextMatchStatuses('WAITING_AGENT_CONNECT')).toEqual(['READY', 'CANCELLED']);
    expect(getAllowedNextMatchStatuses('READY')).toEqual(['IN_PROGRESS']);
    expect(getAllowedNextMatchStatuses('IN_PROGRESS')).toEqual(['FINISHED', 'ABORTED']);
    expect(getAllowedNextMatchStatuses('FINISHED')).toEqual(['ARCHIVED']);
    expect(getAllowedNextMatchStatuses('ABORTED')).toEqual([]);
    expect(getAllowedNextMatchStatuses('CANCELLED')).toEqual([]);
    expect(getAllowedNextMatchStatuses('ARCHIVED')).toEqual([]);
  });

  it('marks terminal statuses defined by spec', () => {
    expect(MATCH_TERMINAL_STATUSES).toEqual(['FINISHED', 'ABORTED', 'CANCELLED']);
    expect(isTerminalMatchStatus('FINISHED')).toBe(true);
    expect(isTerminalMatchStatus('ABORTED')).toBe(true);
    expect(isTerminalMatchStatus('CANCELLED')).toBe(true);
    expect(isTerminalMatchStatus('ARCHIVED')).toBe(false);
  });

  it('exports common error codes from spec', () => {
    expect(COMMON_ERROR_CODES).toEqual([
      'VALIDATION_ERROR',
      'TURN_EXPIRED',
      'INVALID_REQUEST',
      'NOT_YOUR_TURN',
      'MATCH_ENDED',
      'SERVICE_UNAVAILABLE',
      'INTERNAL_ERROR',
    ]);
  });

  it('creates typed firestore converter and validates payloads', () => {
    interface UserRecord {
      uid: string;
      displayName: string;
      roles: string[];
    }

    const converter = createValidatedFirestoreConverter<UserRecord, UserRecord>({
      serialize: (model) => ({
        uid: model.uid,
        displayName: model.displayName,
        roles: [...model.roles],
      }),
      parse: (stored) => ({
        uid: stored.uid,
        displayName: stored.displayName,
        roles: [...stored.roles],
      }),
      validate: (value): value is UserRecord => {
        if (typeof value !== 'object' || value === null) {
          return false;
        }

        const candidate = value as Partial<UserRecord>;

        return (
          typeof candidate.uid === 'string' &&
          typeof candidate.displayName === 'string' &&
          Array.isArray(candidate.roles) &&
          candidate.roles.every((role) => typeof role === 'string')
        );
      },
    });

    expect(
      converter.fromFirestore({
        id: 'user-1',
        data: () => ({
          uid: 'u-1',
          displayName: 'alice',
          roles: ['player'],
        }),
      }),
    ).toEqual({
      uid: 'u-1',
      displayName: 'alice',
      roles: ['player'],
    });

    expect(
      converter.toFirestore({
        uid: 'u-2',
        displayName: 'bob',
        roles: ['player', 'admin'],
      }),
    ).toEqual({
      uid: 'u-2',
      displayName: 'bob',
      roles: ['player', 'admin'],
    });

    expect(() =>
      converter.fromFirestore({
        id: 'invalid',
        data: () => ({
          uid: 1,
          displayName: 'broken',
          roles: ['player'],
        }),
      }),
    ).toThrowError('Invalid Firestore payload for document invalid');
  });

  it('rejects rating payloads with non-finite elo', () => {
    expect(() =>
      ratingFirestoreConverter.fromFirestore({
        id: 'rating-1',
        data: () => ({
          uid: 'u-1',
          seasonId: 'season-2026',
          elo: Number.POSITIVE_INFINITY,
          matches: 10,
          winRate: 0.7,
        }),
      }),
    ).toThrowError('Invalid Firestore payload for document rating-1');
  });
});
