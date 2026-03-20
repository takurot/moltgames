import { describe, expect, it } from 'vitest';

import {
  COMMON_ERROR_CODES,
  DOMAIN_PACKAGE_NAME,
  leaderboardFirestoreConverter,
  MATCH_STATUSES,
  MATCH_TERMINAL_STATUSES,
  canTransitionMatchStatus,
  createValidatedFirestoreConverter,
  getAllowedNextMatchStatuses,
  isTerminalMatchStatus,
  matchFirestoreConverter,
  ratingFirestoreConverter,
  seasonFirestoreConverter,
  turnEventFirestoreConverter,
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

  it('round-trips leaderboard and season payloads', () => {
    const leaderboard = leaderboardFirestoreConverter.toFirestore({
      seasonId: '2026-q1',
      generatedAt: '2026-03-14T00:00:00.000Z',
      entries: [
        {
          uid: 'user-1',
          rank: 1,
          elo: 1516,
          matches: 1,
          winRate: 1,
        },
        {
          uid: 'user-2',
          rank: 2,
          elo: 1484,
          matches: 1,
          winRate: 0,
        },
      ],
    });

    expect(
      leaderboardFirestoreConverter.fromFirestore({
        id: '2026-q1',
        data: () => leaderboard,
      }),
    ).toEqual({
      seasonId: '2026-q1',
      generatedAt: '2026-03-14T00:00:00.000Z',
      entries: [
        {
          uid: 'user-1',
          rank: 1,
          elo: 1516,
          matches: 1,
          winRate: 1,
        },
        {
          uid: 'user-2',
          rank: 2,
          elo: 1484,
          matches: 1,
          winRate: 0,
        },
      ],
    });

    const season = seasonFirestoreConverter.toFirestore({
      seasonId: '2026-q1',
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-03-31T23:59:59.999Z',
      status: 'ACTIVE',
    });

    expect(
      seasonFirestoreConverter.fromFirestore({
        id: '2026-q1',
        data: () => season,
      }),
    ).toEqual({
      seasonId: '2026-q1',
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-03-31T23:59:59.999Z',
      status: 'ACTIVE',
    });
  });

  it('round-trips match payloads including ruleId', () => {
    const stored = matchFirestoreConverter.toFirestore({
      matchId: 'match-1',
      gameId: 'prompt-injection-arena',
      status: 'READY',
      participants: [
        {
          uid: 'user-1',
          agentId: 'agent-1',
          role: 'PLAYER',
        },
      ],
      ruleId: 'standard',
      ruleVersion: '1.1.0',
      region: 'us-central1',
    });

    expect(stored).toEqual({
      matchId: 'match-1',
      gameId: 'prompt-injection-arena',
      status: 'READY',
      participants: [
        {
          uid: 'user-1',
          agentId: 'agent-1',
          role: 'PLAYER',
        },
      ],
      ruleId: 'standard',
      ruleVersion: '1.1.0',
      region: 'us-central1',
    });

    expect(
      matchFirestoreConverter.fromFirestore({
        id: 'match-1',
        data: () => stored,
      }),
    ).toEqual({
      matchId: 'match-1',
      gameId: 'prompt-injection-arena',
      status: 'READY',
      participants: [
        {
          uid: 'user-1',
          agentId: 'agent-1',
          role: 'PLAYER',
        },
      ],
      ruleId: 'standard',
      ruleVersion: '1.1.0',
      region: 'us-central1',
    });
  });

  it('round-trips turn event payloads with analytics fields', () => {
    const stored = turnEventFirestoreConverter.toFirestore({
      eventId: 'evt-1',
      matchId: 'match-1',
      turn: 3,
      actor: 'agent-1',
      action: { tool: 'negotiate', args: { message: 'hello' } },
      result: { status: 'message_sent' },
      actionLatencyMs: 120,
      timestamp: '2026-03-21T00:00:00.000Z',
      actionType: 'negotiate',
      seat: 'first',
      ruleVersion: '1.2.0',
      phase: 'negotiation',
      scoreDiffBefore: 2,
      scoreDiffAfter: 2,
    });

    expect(stored).toEqual({
      eventId: 'evt-1',
      matchId: 'match-1',
      turn: 3,
      actor: 'agent-1',
      action: { tool: 'negotiate', args: { message: 'hello' } },
      result: { status: 'message_sent' },
      actionLatencyMs: 120,
      timestamp: '2026-03-21T00:00:00.000Z',
      actionType: 'negotiate',
      seat: 'first',
      ruleVersion: '1.2.0',
      phase: 'negotiation',
      scoreDiffBefore: 2,
      scoreDiffAfter: 2,
    });

    expect(
      turnEventFirestoreConverter.fromFirestore({
        id: 'evt-1',
        data: () => stored,
      }),
    ).toEqual({
      eventId: 'evt-1',
      matchId: 'match-1',
      turn: 3,
      actor: 'agent-1',
      action: { tool: 'negotiate', args: { message: 'hello' } },
      result: { status: 'message_sent' },
      actionLatencyMs: 120,
      timestamp: '2026-03-21T00:00:00.000Z',
      actionType: 'negotiate',
      seat: 'first',
      ruleVersion: '1.2.0',
      phase: 'negotiation',
      scoreDiffBefore: 2,
      scoreDiffAfter: 2,
    });
  });
});
