import {
  type Action,
  type ApplyActionResult,
  type GamePlugin,
  type TerminationResult,
  type ValidationResult,
} from '../../framework/types.js';
import {
  type MCPToolDefinition,
  DILEMMA_POKER_GET_STATUS_SCHEMA,
  DILEMMA_POKER_NEGOTIATE_SCHEMA,
  DILEMMA_POKER_COMMIT_ACTION_SCHEMA,
} from '@moltgames/mcp-protocol';
import type { JsonValue } from '@moltgames/domain';

export type PlayerActionChoice = 'cooperate' | 'defect' | null;

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
  turn: number;
  round: number;
  maxRounds: number;
  phase: 'negotiation' | 'action';

  agent1Id: string;
  agent2Id: string;

  players: Record<string, DilemmaPokerPlayerState>;

  negotiationsThisRound: { agentId: string; message: string }[];
  actionsThisRound: Record<string, PlayerActionChoice>;

  history: DilemmaPokerHistoryEntry[];
}

export class DilemmaPoker implements GamePlugin<DilemmaPokerState> {
  gameId = 'dilemma-poker';
  ruleVersion = '1.0.0';
  turnTimeoutSeconds = 30;

  initialize(_seed: number): DilemmaPokerState {
    const agent1Id = 'agent-1';
    const agent2Id = 'agent-2';

    return {
      turn: 1,
      round: 1,
      maxRounds: 5,
      phase: 'negotiation',

      agent1Id,
      agent2Id,

      players: {
        [agent1Id]: { agentId: agent1Id, chips: 0 },
        [agent2Id]: { agentId: agent2Id, chips: 0 },
      },

      negotiationsThisRound: [],
      actionsThisRound: {
        [agent1Id]: null,
        [agent2Id]: null,
      },

      history: [],
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
    const isMyTurn = this.isAgentTurn(state, agentId);
    if (!isMyTurn) return [];

    const tools: MCPToolDefinition[] = [];

    // Always allow getting status
    tools.push({
      name: 'get_status',
      description: 'Gets your current status, including chip count and current round.',
      version: '1.0.0',
      inputSchema: DILEMMA_POKER_GET_STATUS_SCHEMA,
    });

    if (state.phase === 'negotiation') {
      tools.push({
        name: 'negotiate',
        description: 'Send a message to the opponent during the negotiation phase.',
        version: '1.0.0',
        inputSchema: DILEMMA_POKER_NEGOTIATE_SCHEMA,
      });
    } else if (state.phase === 'action') {
      tools.push({
        name: 'commit_action',
        description: 'The final action to take for this round: cooperate or defect.',
        version: '1.0.0',
        inputSchema: DILEMMA_POKER_COMMIT_ACTION_SCHEMA,
      });
    }

    return tools;
  }

  validateAction(state: DilemmaPokerState, action: Action): ValidationResult {
    // We can't strictly validate agentId from `action` object because `action` doesn't contain agentId.
    // However, the engine usually handles `NOT_YOUR_TURN` before calling `validateAction`.
    // We just validate the tool and phase combination here.

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
    const nextState = {
      ...state,
      players: {
        [state.agent1Id]: { ...state.players[state.agent1Id]! },
        [state.agent2Id]: { ...state.players[state.agent2Id]! },
      },
      negotiationsThisRound: [...state.negotiationsThisRound],
      actionsThisRound: { ...state.actionsThisRound },
      history: [...state.history],
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
      nextState.turn++;

      // Check if negotiation phase should end
      if (nextState.negotiationsThisRound.length >= 2) {
        nextState.phase = 'action';
      }

      result = { status: 'message_sent' };
    } else if (action.tool === 'commit_action') {
      nextState.actionsThisRound[currentAgentId] = action.args.action as PlayerActionChoice;
      nextState.turn++;

      // Check if action phase should end
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

      let winner: string | undefined = undefined;
      if (p1Chips > p2Chips) winner = state.agent1Id;
      else if (p2Chips > p1Chips) winner = state.agent2Id;

      const term: TerminationResult = {
        ended: true,
        reason: 'Max rounds reached',
      };
      if (winner) term.winner = winner;
      return term;
    }
    return null;
  }

  redactState(state: DilemmaPokerState): DilemmaPokerState {
    // Hide the opponent's committed action during the action phase
    return {
      ...state,
      actionsThisRound: {
        [state.agent1Id]: state.phase === 'action' ? null : state.actionsThisRound[state.agent1Id]!,
        [state.agent2Id]: state.phase === 'action' ? null : state.actionsThisRound[state.agent2Id]!,
      },
    };
  }

  private isAgentTurn(state: DilemmaPokerState, agentId: string): boolean {
    return this.getCurrentTurnAgentId(state) === agentId;
  }

  private getCurrentTurnAgentId(state: DilemmaPokerState): string {
    // 4 turns per round:
    // Turn 1: Negotiation (agent1)
    // Turn 2: Negotiation (agent2)
    // Turn 3: Action (agent1)
    // Turn 4: Action (agent2)
    // We can swap who goes first each round based on the round number.
    const turnInRound = (state.turn - 1) % 4; // 0, 1, 2, 3

    // Round 1: agent1 is first
    // Round 2: agent2 is first
    const agent1GoesFirst = state.round % 2 === 1;

    const firstAgent = agent1GoesFirst ? state.agent1Id : state.agent2Id;
    const secondAgent = agent1GoesFirst ? state.agent2Id : state.agent1Id;

    if (turnInRound === 0 || turnInRound === 2) {
      return firstAgent;
    } else {
      return secondAgent;
    }
  }

  private resolveRound(state: DilemmaPokerState) {
    const p1Action = state.actionsThisRound[state.agent1Id];
    const p2Action = state.actionsThisRound[state.agent2Id];

    let p1Gain = 0;
    let p2Gain = 0;

    if (p1Action === 'cooperate' && p2Action === 'cooperate') {
      p1Gain = 3;
      p2Gain = 3;
    } else if (p1Action === 'defect' && p2Action === 'defect') {
      p1Gain = 1;
      p2Gain = 1;
    } else if (p1Action === 'cooperate' && p2Action === 'defect') {
      p1Gain = 0;
      p2Gain = 5;
    } else if (p1Action === 'defect' && p2Action === 'cooperate') {
      p1Gain = 5;
      p2Gain = 0;
    }

    state.players[state.agent1Id]!.chips += p1Gain;
    state.players[state.agent2Id]!.chips += p2Gain;

    // Archive history
    state.history.push({
      round: state.round,
      negotiations: [...state.negotiationsThisRound],
      actions: { ...state.actionsThisRound },
      chipChanges: {
        [state.agent1Id]: p1Gain,
        [state.agent2Id]: p2Gain,
      },
    });

    // Reset for next round
    state.round++;
    state.phase = 'negotiation';
    state.negotiationsThisRound = [];
    state.actionsThisRound = {
      [state.agent1Id]: null,
      [state.agent2Id]: null,
    };
  }
}
