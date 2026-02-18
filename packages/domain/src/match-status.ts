export const MATCH_STATUSES = [
  'CREATED',
  'WAITING_AGENT_CONNECT',
  'READY',
  'IN_PROGRESS',
  'FINISHED',
  'ABORTED',
  'CANCELLED',
  'ARCHIVED',
] as const;

export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const MATCH_TERMINAL_STATUSES = ['FINISHED', 'ABORTED', 'CANCELLED'] as const;

export type MatchTerminalStatus = (typeof MATCH_TERMINAL_STATUSES)[number];

const MATCH_STATUS_TRANSITIONS: Record<MatchStatus, readonly MatchStatus[]> = {
  CREATED: ['WAITING_AGENT_CONNECT', 'CANCELLED'],
  WAITING_AGENT_CONNECT: ['READY', 'CANCELLED'],
  READY: ['IN_PROGRESS'],
  IN_PROGRESS: ['FINISHED', 'ABORTED'],
  FINISHED: ['ARCHIVED'],
  ABORTED: [],
  CANCELLED: [],
  ARCHIVED: [],
};

const matchStatusSet: ReadonlySet<MatchStatus> = new Set(MATCH_STATUSES);
const terminalMatchStatusSet: ReadonlySet<MatchTerminalStatus> = new Set(MATCH_TERMINAL_STATUSES);

export const isMatchStatus = (value: unknown): value is MatchStatus =>
  typeof value === 'string' && matchStatusSet.has(value as MatchStatus);

export const getAllowedNextMatchStatuses = (status: MatchStatus): readonly MatchStatus[] =>
  MATCH_STATUS_TRANSITIONS[status];

export const canTransitionMatchStatus = (from: MatchStatus, to: MatchStatus): boolean =>
  MATCH_STATUS_TRANSITIONS[from].includes(to);

export const isTerminalMatchStatus = (status: MatchStatus): status is MatchTerminalStatus =>
  terminalMatchStatusSet.has(status as MatchTerminalStatus);
