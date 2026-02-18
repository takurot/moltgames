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
  ruleVersion: string;
  region: string;
}

export interface TurnEvent {
  eventId: string;
  matchId: string;
  turn: number;
  actor: string;
  action: JsonValue;
  result: JsonValue;
  latencyMs: number;
  timestamp: IsoDateString;
}

export interface Rating {
  uid: string;
  seasonId: string;
  elo: number;
  matches: number;
  winRate: number;
}

export const REPLAY_VISIBILITIES = ['PUBLIC', 'PRIVATE', 'UNLISTED'] as const;

export type ReplayVisibility = (typeof REPLAY_VISIBILITIES)[number];

export interface Replay {
  matchId: string;
  storagePath: string;
  visibility: ReplayVisibility;
  redactionVersion: string;
}
