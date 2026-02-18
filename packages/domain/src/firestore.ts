import type {
  AgentProfile,
  Match,
  MatchParticipant,
  MatchParticipantRole,
  Rating,
  Replay,
  ReplayVisibility,
  TurnEvent,
  User,
} from './types.js';
import { MATCH_PARTICIPANT_ROLES, REPLAY_VISIBILITIES } from './types.js';
import type { MatchStatus } from './match-status.js';
import { isMatchStatus } from './match-status.js';
import {
  isBooleanRecord,
  isJsonValue,
  isNonEmptyString,
  isRecord,
  isStringArray,
  type JsonValue,
} from './value-guards.js';

export interface FirestoreDocumentSnapshot<TStored = unknown> {
  readonly id: string;
  data(): TStored;
}

export interface FirestoreConverter<TModel, TStored> {
  toFirestore(model: TModel): TStored;
  fromFirestore(snapshot: FirestoreDocumentSnapshot): TModel;
}

export interface ValidatedFirestoreConverterOptions<TModel, TStored> {
  serialize: (model: TModel) => TStored;
  parse: (stored: TStored, context: FirestoreParseContext) => TModel;
  validate: (value: unknown) => value is TStored;
}

export interface FirestoreParseContext {
  readonly documentId: string;
}

export const createValidatedFirestoreConverter = <TModel, TStored>(
  options: ValidatedFirestoreConverterOptions<TModel, TStored>,
): FirestoreConverter<TModel, TStored> => ({
  toFirestore: (model) => options.serialize(model),
  fromFirestore: (snapshot) => {
    const payload = snapshot.data();

    if (!options.validate(payload)) {
      throw new Error(`Invalid Firestore payload for document ${snapshot.id}`);
    }

    return options.parse(payload, { documentId: snapshot.id });
  },
});

const matchParticipantRoleSet: ReadonlySet<MatchParticipantRole> = new Set(MATCH_PARTICIPANT_ROLES);
const replayVisibilitySet: ReadonlySet<ReplayVisibility> = new Set(REPLAY_VISIBILITIES);

export interface UserDocument {
  uid: string;
  displayName: string;
  createdAt: string;
  roles: string[];
}

export interface AgentProfileDocument {
  agentId: string;
  ownerUid: string;
  modelProvider: string;
  modelName: string;
  policyFlags: Record<string, boolean>;
}

export interface MatchParticipantDocument {
  uid: string;
  agentId: string;
  role: MatchParticipantRole;
}

export interface MatchDocument {
  matchId: string;
  gameId: string;
  status: MatchStatus;
  participants: MatchParticipantDocument[];
  startedAt?: string;
  endedAt?: string;
  ruleVersion: string;
  region: string;
}

export interface TurnEventDocument {
  eventId: string;
  matchId: string;
  turn: number;
  actor: string;
  action: JsonValue;
  result: JsonValue;
  latencyMs: number;
  timestamp: string;
}

export interface RatingDocument {
  uid: string;
  seasonId: string;
  elo: number;
  matches: number;
  winRate: number;
}

export interface ReplayDocument {
  matchId: string;
  storagePath: string;
  visibility: ReplayVisibility;
  redactionVersion: string;
}

const isOptionalNonEmptyString = (value: unknown): value is string | undefined =>
  value === undefined || isNonEmptyString(value);

const isMatchParticipantDocument = (value: unknown): value is MatchParticipantDocument => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.uid) &&
    isNonEmptyString(value.agentId) &&
    typeof value.role === 'string' &&
    matchParticipantRoleSet.has(value.role as MatchParticipantRole)
  );
};

export const isUserDocument = (value: unknown): value is UserDocument => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.uid) &&
    isNonEmptyString(value.displayName) &&
    isNonEmptyString(value.createdAt) &&
    isStringArray(value.roles)
  );
};

export const isAgentProfileDocument = (value: unknown): value is AgentProfileDocument => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.agentId) &&
    isNonEmptyString(value.ownerUid) &&
    isNonEmptyString(value.modelProvider) &&
    isNonEmptyString(value.modelName) &&
    isBooleanRecord(value.policyFlags)
  );
};

export const isMatchDocument = (value: unknown): value is MatchDocument => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.matchId) &&
    isNonEmptyString(value.gameId) &&
    typeof value.status === 'string' &&
    isMatchStatus(value.status) &&
    Array.isArray(value.participants) &&
    value.participants.every((participant) => isMatchParticipantDocument(participant)) &&
    isOptionalNonEmptyString(value.startedAt) &&
    isOptionalNonEmptyString(value.endedAt) &&
    isNonEmptyString(value.ruleVersion) &&
    isNonEmptyString(value.region)
  );
};

export const isTurnEventDocument = (value: unknown): value is TurnEventDocument => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.eventId) &&
    isNonEmptyString(value.matchId) &&
    typeof value.turn === 'number' &&
    Number.isInteger(value.turn) &&
    value.turn >= 0 &&
    isNonEmptyString(value.actor) &&
    isJsonValue(value.action) &&
    isJsonValue(value.result) &&
    typeof value.latencyMs === 'number' &&
    value.latencyMs >= 0 &&
    isNonEmptyString(value.timestamp)
  );
};

export const isRatingDocument = (value: unknown): value is RatingDocument => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.uid) &&
    isNonEmptyString(value.seasonId) &&
    typeof value.elo === 'number' &&
    typeof value.matches === 'number' &&
    Number.isInteger(value.matches) &&
    value.matches >= 0 &&
    typeof value.winRate === 'number' &&
    value.winRate >= 0 &&
    value.winRate <= 1
  );
};

export const isReplayDocument = (value: unknown): value is ReplayDocument => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.matchId) &&
    isNonEmptyString(value.storagePath) &&
    typeof value.visibility === 'string' &&
    replayVisibilitySet.has(value.visibility as ReplayVisibility) &&
    isNonEmptyString(value.redactionVersion)
  );
};

export const userFirestoreConverter = createValidatedFirestoreConverter<User, UserDocument>({
  serialize: (model) => ({
    uid: model.uid,
    displayName: model.displayName,
    createdAt: model.createdAt,
    roles: [...model.roles],
  }),
  parse: (stored) => ({
    uid: stored.uid,
    displayName: stored.displayName,
    createdAt: stored.createdAt,
    roles: [...stored.roles],
  }),
  validate: isUserDocument,
});

export const agentProfileFirestoreConverter = createValidatedFirestoreConverter<
  AgentProfile,
  AgentProfileDocument
>({
  serialize: (model) => ({
    agentId: model.agentId,
    ownerUid: model.ownerUid,
    modelProvider: model.modelProvider,
    modelName: model.modelName,
    policyFlags: { ...model.policyFlags },
  }),
  parse: (stored) => ({
    agentId: stored.agentId,
    ownerUid: stored.ownerUid,
    modelProvider: stored.modelProvider,
    modelName: stored.modelName,
    policyFlags: { ...stored.policyFlags },
  }),
  validate: isAgentProfileDocument,
});

const serializeMatchParticipants = (
  participants: readonly MatchParticipant[],
): MatchParticipantDocument[] =>
  participants.map((participant) => ({
    uid: participant.uid,
    agentId: participant.agentId,
    role: participant.role,
  }));

const parseMatchParticipants = (
  participants: readonly MatchParticipantDocument[],
): MatchParticipant[] =>
  participants.map((participant) => ({
    uid: participant.uid,
    agentId: participant.agentId,
    role: participant.role,
  }));

export const matchFirestoreConverter = createValidatedFirestoreConverter<Match, MatchDocument>({
  serialize: (model) => {
    const stored: MatchDocument = {
      matchId: model.matchId,
      gameId: model.gameId,
      status: model.status,
      participants: serializeMatchParticipants(model.participants),
      ruleVersion: model.ruleVersion,
      region: model.region,
    };

    if (model.startedAt !== undefined) {
      stored.startedAt = model.startedAt;
    }

    if (model.endedAt !== undefined) {
      stored.endedAt = model.endedAt;
    }

    return stored;
  },
  parse: (stored) => {
    const parsed: Match = {
      matchId: stored.matchId,
      gameId: stored.gameId,
      status: stored.status,
      participants: parseMatchParticipants(stored.participants),
      ruleVersion: stored.ruleVersion,
      region: stored.region,
    };

    if (stored.startedAt !== undefined) {
      parsed.startedAt = stored.startedAt;
    }

    if (stored.endedAt !== undefined) {
      parsed.endedAt = stored.endedAt;
    }

    return parsed;
  },
  validate: isMatchDocument,
});

export const turnEventFirestoreConverter = createValidatedFirestoreConverter<
  TurnEvent,
  TurnEventDocument
>({
  serialize: (model) => ({
    eventId: model.eventId,
    matchId: model.matchId,
    turn: model.turn,
    actor: model.actor,
    action: model.action,
    result: model.result,
    latencyMs: model.latencyMs,
    timestamp: model.timestamp,
  }),
  parse: (stored) => ({
    eventId: stored.eventId,
    matchId: stored.matchId,
    turn: stored.turn,
    actor: stored.actor,
    action: stored.action,
    result: stored.result,
    latencyMs: stored.latencyMs,
    timestamp: stored.timestamp,
  }),
  validate: isTurnEventDocument,
});

export const ratingFirestoreConverter = createValidatedFirestoreConverter<Rating, RatingDocument>({
  serialize: (model) => ({
    uid: model.uid,
    seasonId: model.seasonId,
    elo: model.elo,
    matches: model.matches,
    winRate: model.winRate,
  }),
  parse: (stored) => ({
    uid: stored.uid,
    seasonId: stored.seasonId,
    elo: stored.elo,
    matches: stored.matches,
    winRate: stored.winRate,
  }),
  validate: isRatingDocument,
});

export const replayFirestoreConverter = createValidatedFirestoreConverter<Replay, ReplayDocument>({
  serialize: (model) => ({
    matchId: model.matchId,
    storagePath: model.storagePath,
    visibility: model.visibility,
    redactionVersion: model.redactionVersion,
  }),
  parse: (stored) => ({
    matchId: stored.matchId,
    storagePath: stored.storagePath,
    visibility: stored.visibility,
    redactionVersion: stored.redactionVersion,
  }),
  validate: isReplayDocument,
});

export const domainFirestoreConverters = {
  user: userFirestoreConverter,
  agentProfile: agentProfileFirestoreConverter,
  match: matchFirestoreConverter,
  turnEvent: turnEventFirestoreConverter,
  rating: ratingFirestoreConverter,
  replay: replayFirestoreConverter,
} as const;
