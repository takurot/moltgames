import {
  type Action,
  type ApplyActionResult,
  type GamePlugin,
  type TerminationResult,
  type TurnEventAnalytics,
  type ValidationResult,
} from '../../framework/types.js';
import {
  type MCPToolDefinition,
  DILEMMA_POKER_GET_STATUS_SCHEMA,
  DILEMMA_POKER_NEGOTIATE_SCHEMA,
  DILEMMA_POKER_COMMIT_ACTION_SCHEMA,
} from '@moltgames/mcp-protocol';
import type { JsonValue } from '@moltgames/domain';
import type { LoadedGameRule } from '@moltgames/rules';

export type PlayerActionChoice = 'cooperate' | 'defect' | null;

const DEFAULT_RULE: LoadedGameRule = {
  gameId: 'dilemma-poker',
  ruleId: 'standard',
  ruleVersion: '1.0.0',
  turnLimit: 20,
  turnTimeoutSeconds: 30,
  tools: [
    {
      name: 'get_status',
      description: 'Gets your current status, including chip count and current round.',
      version: '1.0.0',
      inputSchema: DILEMMA_POKER_GET_STATUS_SCHEMA,
    },
    {
      name: 'negotiate',
      description: 'Send a message to the opponent during the negotiation phase.',
      version: '1.0.0',
      inputSchema: DILEMMA_POKER_NEGOTIATE_SCHEMA,
    },
    {
      name: 'commit_action',
      description: 'The final action to take for this round: cooperate or defect.',
      version: '1.0.0',
      inputSchema: DILEMMA_POKER_COMMIT_ACTION_SCHEMA,
    },
  ],
  parameters: {
    initialChips: 0,
    maxRounds: 5,
    negotiationPhaseMessagesPerRound: 2,
  },
  termination: {
    type: 'dilemma-poker',
    maxRounds: 5,
    reason: 'Max rounds reached',
    cooperateCooperate: 3,
    defectDefect: 1,
    cooperateDefect: 0,
    defectCooperate: 5,
  },
  redactionPolicy: {
    type: 'hide-pending-actions',
  },
};

const getNumberParameter = (
  source: Record<string, unknown>,
  key: string,
  fallback: number,
): number => {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const getStringParameter = (
  source: Record<string, unknown>,
  key: string,
  fallback: string,
): string => {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
};

const pickTools = (
  tools: readonly MCPToolDefinition[],
  names: readonly string[],
): MCPToolDefinition[] => tools.filter((tool) => names.includes(tool.name));

export interface DilemmaPokerPlayerState {
  agentId: string;
  chips: number;
}

export interface DilemmaPokerHistoryEntry {
  round: number;
  negotiations: { agentId: string; message: string }[];
  actions: Record<string, PlayerActionChoice>;
  chipChanges: Record<string, number>;
}

export interface DilemmaPokerState {
  ruleId: string;
  ruleVersion: string;
  toolDefinitions: MCPToolDefinition[];
  initialChips: number;
  turn: number;
  round: number;
  maxRounds: number;
  negotiationPhaseMessagesPerRound: number;
  terminationReason: string;
  phase: 'negotiation' | 'action';
  agent1Id: string;
  agent2Id: string;
  players: Record<string, DilemmaPokerPlayerState>;
  negotiationsThisRound: { agentId: string; message: string }[];
  actionsThisRound: Record<string, PlayerActionChoice>;
  history: DilemmaPokerHistoryEntry[];
  scoring: {
    cooperateCooperate: number;
    defectDefect: number;
    cooperateDefect: number;
    defectCooperate: number;
  };
}

export class DilemmaPoker implements GamePlugin<DilemmaPokerState> {
  gameId = 'dilemma-poker';
  ruleVersion = '1.0.0';
  turnTimeoutSeconds = 30;

  initialize(_seed: number, rule: LoadedGameRule = DEFAULT_RULE): DilemmaPokerState {
    const parameters = rule.parameters as Record<string, unknown>;
    const termination = rule.termination as Record<string, unknown>;
    const agent1Id = 'agent-1';
    const agent2Id = 'agent-2';
    const initialChips = getNumberParameter(parameters, 'initialChips', 0);
    const negotiationPhaseMessagesPerRound = Math.max(
      1,
      getNumberParameter(parameters, 'negotiationPhaseMessagesPerRound', 2),
    );
    const turnsPerRound = negotiationPhaseMessagesPerRound + 2;

    return {
      ruleId: rule.ruleId,
      ruleVersion: rule.ruleVersion,
      toolDefinitions: [...rule.tools],
      initialChips,
      turn: 1,
      round: 1,
      maxRounds: getNumberParameter(
        parameters,
        'maxRounds',
        getNumberParameter(
          termination,
          'maxRounds',
          Math.max(1, Math.floor(rule.turnLimit / turnsPerRound)),
        ),
      ),
      negotiationPhaseMessagesPerRound,
      terminationReason: getStringParameter(termination, 'reason', 'Max rounds reached'),
      phase: 'negotiation',
      agent1Id,
      agent2Id,
      players: {
        [agent1Id]: { agentId: agent1Id, chips: initialChips },
        [agent2Id]: { agentId: agent2Id, chips: initialChips },
      },
      negotiationsThisRound: [],
      actionsThisRound: {
        [agent1Id]: null,
        [agent2Id]: null,
      },
      history: [],
      scoring: {
        cooperateCooperate: getNumberParameter(termination, 'cooperateCooperate', 3),
        defectDefect: getNumberParameter(termination, 'defectDefect', 1),
        cooperateDefect: getNumberParameter(termination, 'cooperateDefect', 0),
        defectCooperate: getNumberParameter(termination, 'defectCooperate', 5),
      },
    };
  }

  getTurn(state: DilemmaPokerState): number {
    return state.turn;
  }

  consumeTurn(state: DilemmaPokerState): DilemmaPokerState {
    return {
      ...state,
      turn: state.turn + 1,
    };
  }

  getAvailableTools(
    state: DilemmaPokerState,
    agentId: string,
    _phase: string,
  ): MCPToolDefinition[] {
    if (!this.isAgentTurn(state, agentId)) {
      return [];
    }

    const tools = pickTools(state.toolDefinitions, ['get_status']);
    if (state.phase === 'negotiation') {
      return [...tools, ...pickTools(state.toolDefinitions, ['negotiate'])];
    }

    if (state.phase === 'action') {
      return [...tools, ...pickTools(state.toolDefinitions, ['commit_action'])];
    }

    return tools;
  }

  validateAction(state: DilemmaPokerState, action: Action): ValidationResult {
    if (action.tool === 'get_status') {
      return { valid: true };
    }

    if (state.phase === 'negotiation') {
      if (action.tool !== 'negotiate') {
        return {
          valid: false,
          error: 'Only negotiate or get_status is allowed in negotiation phase',
        };
      }

      const message = action.args.message;
      if (typeof message !== 'string' || message.trim().length === 0 || message.length > 500) {
        return {
          valid: false,
          error: 'message must be a non-empty string with maximum length 500',
        };
      }
    } else if (state.phase === 'action') {
      if (action.tool !== 'commit_action') {
        return {
          valid: false,
          error: 'Only commit_action or get_status is allowed in action phase',
        };
      }

      const selectedAction = action.args.action;
      if (selectedAction !== 'cooperate' && selectedAction !== 'defect') {
        return {
          valid: false,
          error: "action must be either 'cooperate' or 'defect'",
        };
      }
    } else {
      return { valid: false, error: 'Invalid phase' };
    }

    return { valid: true };
  }

  applyAction(state: DilemmaPokerState, action: Action): ApplyActionResult<DilemmaPokerState> {
    const nextState: DilemmaPokerState = {
      ...state,
      toolDefinitions: [...state.toolDefinitions],
      players: {
        [state.agent1Id]: { ...state.players[state.agent1Id]! },
        [state.agent2Id]: { ...state.players[state.agent2Id]! },
      },
      negotiationsThisRound: [...state.negotiationsThisRound],
      actionsThisRound: { ...state.actionsThisRound },
      history: [...state.history],
      scoring: { ...state.scoring },
    };

    let result: JsonValue = { status: 'ok' };
    const currentAgentId = this.getCurrentTurnAgentId(state);

    if (action.tool === 'get_status') {
      result = {
        round: nextState.round,
        maxRounds: nextState.maxRounds,
        phase: nextState.phase,
        chips: nextState.players[currentAgentId]!.chips,
        opponentChips:
          nextState.players[currentAgentId === state.agent1Id ? state.agent2Id : state.agent1Id]!
            .chips,
      };
      return { state: nextState, result };
    }

    if (action.tool === 'negotiate') {
      nextState.negotiationsThisRound.push({
        agentId: currentAgentId,
        message: action.args.message as string,
      });
      nextState.turn += 1;

      if (nextState.negotiationsThisRound.length >= nextState.negotiationPhaseMessagesPerRound) {
        nextState.phase = 'action';
      }

      result = { status: 'message_sent' };
    } else if (action.tool === 'commit_action') {
      nextState.actionsThisRound[currentAgentId] = action.args.action as PlayerActionChoice;
      nextState.turn += 1;

      if (
        nextState.actionsThisRound[state.agent1Id] !== null &&
        nextState.actionsThisRound[state.agent2Id] !== null
      ) {
        this.resolveRound(nextState);
      }

      result = { status: 'action_committed' };
    }

    return { state: nextState, result };
  }

  checkTermination(state: DilemmaPokerState): TerminationResult | null {
    if (state.round > state.maxRounds) {
      const p1Chips = state.players[state.agent1Id]!.chips;
      const p2Chips = state.players[state.agent2Id]!.chips;

      let winner: string | undefined;
      if (p1Chips > p2Chips) {
        winner = state.agent1Id;
      } else if (p2Chips > p1Chips) {
        winner = state.agent2Id;
      }

      const term: TerminationResult = {
        ended: true,
        reason: state.terminationReason,
      };
      if (winner) {
        term.winner = winner;
      }
      return term;
    }

    return null;
  }

  getTurnEventAnalytics(
    state: DilemmaPokerState,
    actorId: string,
    _action: Action,
  ): TurnEventAnalytics {
    const opponentId = actorId === state.agent1Id ? state.agent2Id : state.agent1Id;
    const actor = state.players[actorId];
    const opponent = state.players[opponentId];

    return {
      phase: state.phase,
      seat: actorId === state.agent2Id ? 'second' : 'first',
      scoreDiff: actor && opponent ? actor.chips - opponent.chips : 0,
    };
  }

  redactState(state: DilemmaPokerState): DilemmaPokerState {
    return {
      ...state,
      toolDefinitions: [...state.toolDefinitions],
      players: {
        [state.agent1Id]: { ...state.players[state.agent1Id]! },
        [state.agent2Id]: { ...state.players[state.agent2Id]! },
      },
      negotiationsThisRound: [...state.negotiationsThisRound],
      actionsThisRound: {
        [state.agent1Id]: state.phase === 'action' ? null : state.actionsThisRound[state.agent1Id]!,
        [state.agent2Id]: state.phase === 'action' ? null : state.actionsThisRound[state.agent2Id]!,
      },
      history: [...state.history],
      scoring: { ...state.scoring },
    };
  }

  private isAgentTurn(state: DilemmaPokerState, agentId: string): boolean {
    return this.getCurrentTurnAgentId(state) === agentId;
  }

  private getCurrentTurnAgentId(state: DilemmaPokerState): string {
    const turnsPerRound = state.negotiationPhaseMessagesPerRound + 2;
    const turnInRound = (state.turn - 1) % turnsPerRound;
    const agent1GoesFirst = state.round % 2 === 1;

    const firstAgent = agent1GoesFirst ? state.agent1Id : state.agent2Id;
    const secondAgent = agent1GoesFirst ? state.agent2Id : state.agent1Id;

    if (turnInRound === 0 || turnInRound === 2) {
      return firstAgent;
    }

    return secondAgent;
  }

  private resolveRound(state: DilemmaPokerState): void {
    const p1Action = state.actionsThisRound[state.agent1Id];
    const p2Action = state.actionsThisRound[state.agent2Id];

    let p1Gain = 0;
    let p2Gain = 0;

    if (p1Action === 'cooperate' && p2Action === 'cooperate') {
      p1Gain = state.scoring.cooperateCooperate;
      p2Gain = state.scoring.cooperateCooperate;
    } else if (p1Action === 'defect' && p2Action === 'defect') {
      p1Gain = state.scoring.defectDefect;
      p2Gain = state.scoring.defectDefect;
    } else if (p1Action === 'cooperate' && p2Action === 'defect') {
      p1Gain = state.scoring.cooperateDefect;
      p2Gain = state.scoring.defectCooperate;
    } else if (p1Action === 'defect' && p2Action === 'cooperate') {
      p1Gain = state.scoring.defectCooperate;
      p2Gain = state.scoring.cooperateDefect;
    }

    state.players[state.agent1Id]!.chips += p1Gain;
    state.players[state.agent2Id]!.chips += p2Gain;

    state.history.push({
      round: state.round,
      negotiations: [...state.negotiationsThisRound],
      actions: { ...state.actionsThisRound },
      chipChanges: {
        [state.agent1Id]: p1Gain,
        [state.agent2Id]: p2Gain,
      },
    });

    state.round += 1;
    state.phase = 'negotiation';
    state.negotiationsThisRound = [];
    state.actionsThisRound = {
      [state.agent1Id]: null,
      [state.agent2Id]: null,
    };
  }
}
