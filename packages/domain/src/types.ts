import type { MatchStatus } from './match-status.js';
import type { JsonValue } from './value-guards.js';

export type IsoDateString = string;

export type UserRole = string;

export interface User {
  uid: string;
  displayName: string;
  createdAt: IsoDateString;
  roles: readonly UserRole[];
}

export interface AgentProfile {
  agentId: string;
  ownerUid: string;
  modelProvider: string;
  modelName: string;
  policyFlags: Record<string, boolean>;
}

export const MATCH_PARTICIPANT_ROLES = ['PLAYER', 'SPECTATOR'] as const;

export type MatchParticipantRole = (typeof MATCH_PARTICIPANT_ROLES)[number];

export interface MatchParticipant {
  uid: string;
  agentId: string;
  role: MatchParticipantRole;
}

export interface Match {
  matchId: string;
  gameId: string;
  status: MatchStatus;
  participants: readonly MatchParticipant[];
  startedAt?: IsoDateString;
  endedAt?: IsoDateString;
  ruleId: string;
  ruleVersion: string;
  region: string;
}

export const TURN_EVENT_SEATS = ['first', 'second'] as const;
export type TurnEventSeat = (typeof TURN_EVENT_SEATS)[number];

export interface TurnEvent {
  eventId: string;
  matchId: string;
  turn: number;
  actor: string;
  action: JsonValue;
  result: JsonValue;
  actionLatencyMs: number;
  timestamp: IsoDateString;
  // SPEC §11.2 analytics fields
  actionType: string;
  seat: TurnEventSeat;
  ruleVersion: string;
  phase: string;
  scoreDiffBefore: number;
  scoreDiffAfter: number;
}

/** TurnEvent enriched with replay integrity fields (SPEC §11.2). */
export interface RedactedTurnEvent extends TurnEvent {
  isHiddenInfoRedacted: boolean;
  redactionVersion: string;
  eventHash: string;
}

export interface Rating {
  uid: string;
  seasonId: string;
  elo: number;
  matches: number;
  winRate: number;
}

export const SEASON_STATUSES = ['SCHEDULED', 'ACTIVE', 'ARCHIVED'] as const;

export type SeasonStatus = (typeof SEASON_STATUSES)[number];

export interface Season {
  seasonId: string;
  startsAt: IsoDateString;
  endsAt: IsoDateString;
  status: SeasonStatus;
}

export interface LeaderboardEntry {
  uid: string;
  rank: number;
  elo: number;
  matches: number;
  winRate: number;
}

export interface Leaderboard {
  seasonId: string;
  generatedAt: IsoDateString;
  entries: readonly LeaderboardEntry[];
}

export const REPLAY_VISIBILITIES = ['PUBLIC', 'PRIVATE', 'UNLISTED'] as const;

export type ReplayVisibility = (typeof REPLAY_VISIBILITIES)[number];

export interface Replay {
  matchId: string;
  storagePath: string;
  visibility: ReplayVisibility;
  redactionVersion: string;
}
