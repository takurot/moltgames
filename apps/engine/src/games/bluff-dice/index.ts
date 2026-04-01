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
  BLUFF_DICE_GET_STATE_SCHEMA,
  BLUFF_DICE_PLACE_BET_SCHEMA,
  BLUFF_DICE_MAKE_BID_SCHEMA,
  BLUFF_DICE_CALL_BLUFF_SCHEMA,
} from '@moltgames/mcp-protocol';
import type { JsonValue } from '@moltgames/domain';
import type { LoadedGameRule } from '@moltgames/rules';

import type {
  BluffDiceBid,
  BluffDicePlayerState,
  BluffDiceRoundResult,
  BluffDiceState,
} from './types.js';

const DEFAULT_RULE: LoadedGameRule = {
  gameId: 'bluff-dice',
  ruleId: 'standard',
  ruleVersion: '1.0.0',
  turnLimit: 120,
  turnTimeoutSeconds: 30,
  tools: [
    {
      name: 'get_state',
      description: 'Get the current game state visible to you.',
      version: '1.0.0',
      inputSchema: BLUFF_DICE_GET_STATE_SCHEMA,
    },
    {
      name: 'place_bet',
      description: 'Place your secret bet for this round (betting phase only).',
      version: '1.0.0',
      inputSchema: BLUFF_DICE_PLACE_BET_SCHEMA,
    },
    {
      name: 'make_bid',
      description: 'Bid on how many dice of a given face value exist across all dice.',
      version: '1.0.0',
      inputSchema: BLUFF_DICE_MAKE_BID_SCHEMA,
    },
    {
      name: 'call_bluff',
      description: 'Challenge the current bid. Triggers resolution and reveals all dice.',
      version: '1.0.0',
      inputSchema: BLUFF_DICE_CALL_BLUFF_SCHEMA,
    },
  ],
  parameters: {
    initialChips: 50,
    maxRounds: 5,
    diceCount: 5,
    maxBetPerRound: 10,
  },
  termination: { type: 'bluff-dice', reason: 'All rounds completed' },
  redactionPolicy: { type: 'hide-opponent-dice-and-bet' },
};

const getNumberParameter = (
  source: Record<string, unknown>,
  key: string,
  fallback: number,
): number => {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const pickTools = (
  tools: readonly MCPToolDefinition[],
  names: readonly string[],
): MCPToolDefinition[] => tools.filter((tool) => names.includes(tool.name));

export class BluffDiceGame implements GamePlugin<BluffDiceState> {
  readonly gameId = 'bluff-dice';
  readonly ruleVersion = '1.0.0';

  initialize(seed: number, rule?: LoadedGameRule): BluffDiceState {
    const activeRule = rule ?? DEFAULT_RULE;
    const params = activeRule.parameters as Record<string, unknown>;

    const initialChips = getNumberParameter(params, 'initialChips', 50);
    const maxRounds = getNumberParameter(params, 'maxRounds', 5);
    const diceCount = getNumberParameter(params, 'diceCount', 5);
    const maxBetPerRound = getNumberParameter(params, 'maxBetPerRound', 10);
    const turnLimit = activeRule.turnLimit ?? 120;

    const makePlayer = (agentId: string): BluffDicePlayerState => ({
      agentId,
      chips: initialChips,
      dice: [],
      diceCount,
      bet: 0,
      betPlaced: false,
    });

    return {
      ruleId: activeRule.ruleId,
      ruleVersion: activeRule.ruleVersion,
      toolDefinitions: [...activeRule.tools],
      seed,
      round: 1,
      maxRounds,
      turn: 1,
      turnLimit,
      phase: 'betting',
      diceCount,
      maxBetPerRound,
      players: [makePlayer('agent-1'), makePlayer('agent-2')],
      agentIds: ['agent-1', 'agent-2'],
      activeBidder: null,
      firstBidder: 'agent-1',
      lastBidder: null,
      currentBid: null,
      pot: 0,
      roundHistory: [],
      gameOver: false,
      terminationResult: null,
    };
  }

  getTurn(state: BluffDiceState): number {
    return state.turn;
  }

  consumeTurn(state: BluffDiceState): BluffDiceState {
    if (state.phase === 'betting') {
      return { ...state, turn: state.turn + 1 };
    }

    if (state.phase === 'bidding') {
      const activeBidder = state.activeBidder ?? state.firstBidder;
      // If there's no current bid or count < 10: force minimum valid bid
      if (state.currentBid === null) {
        return this.applyMakeBid(state, activeBidder, { count: 1, face: 1 });
      }
      if (state.currentBid.count < 10) {
        return this.applyMakeBid(state, activeBidder, { count: state.currentBid.count + 1, face: 1 });
      }
      // count === 10: no valid bid possible, force call_bluff
      return this.applyCallBluff(state, activeBidder);
    }

    return { ...state, turn: state.turn + 1 };
  }

  getAvailableTools(state: BluffDiceState, agentId: string, _phase: string): MCPToolDefinition[] {
    const tools = state.toolDefinitions;

    if (state.phase === 'finished') {
      return pickTools(tools, ['get_state']);
    }

    if (state.phase === 'betting') {
      const playerIdx = state.agentIds.indexOf(agentId);
      if (playerIdx === -1) return pickTools(tools, ['get_state']);
      const player = state.players[playerIdx] as BluffDicePlayerState | undefined;
      if (!player) return pickTools(tools, ['get_state']);
      if (!player.betPlaced) {
        return pickTools(tools, ['get_state', 'place_bet']);
      }
      return pickTools(tools, ['get_state']);
    }

    if (state.phase === 'bidding') {
      if (agentId !== state.activeBidder) {
        return pickTools(tools, ['get_state']);
      }
      const available = ['get_state', 'make_bid'];
      if (state.currentBid !== null && state.lastBidder !== agentId) {
        available.push('call_bluff');
      }
      return pickTools(tools, available);
    }

    return pickTools(tools, ['get_state']);
  }

  validateAction(state: BluffDiceState, action: Action): ValidationResult {
    const { tool, args, actor } = action;

    if (tool === 'get_state') {
      return { valid: true };
    }

    if (tool === 'place_bet') {
      if (state.phase !== 'betting') {
        return { valid: false, error: 'place_bet is only allowed during the betting phase.' };
      }
      const playerIdx = state.agentIds.indexOf(actor ?? '');
      if (playerIdx === -1) {
        return { valid: false, error: 'Unknown actor.' };
      }
      const player = state.players[playerIdx] as BluffDicePlayerState | undefined;
      if (!player) {
        return { valid: false, error: 'Unknown actor.' };
      }
      if (player.betPlaced) {
        return { valid: false, error: 'You have already placed your bet this round.' };
      }
      const amount = args.amount;
      if (typeof amount !== 'number' || !Number.isInteger(amount)) {
        return { valid: false, error: 'amount must be an integer.', retryable: true };
      }
      const maxBet = Math.min(player.chips, state.maxBetPerRound);
      if (amount < 1 || amount > maxBet) {
        return {
          valid: false,
          error: `amount must be between 1 and ${maxBet} (your chips: ${player.chips}, maxBetPerRound: ${state.maxBetPerRound}).`,
          retryable: true,
        };
      }
      return { valid: true };
    }

    if (tool === 'make_bid') {
      if (state.phase !== 'bidding') {
        return { valid: false, error: 'make_bid is only allowed during the bidding phase.' };
      }
      if (actor !== state.activeBidder) {
        return { valid: false, error: 'It is not your turn to bid.' };
      }
      const count = args.count;
      const face = args.face;
      if (
        typeof count !== 'number' ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 10 ||
        typeof face !== 'number' ||
        !Number.isInteger(face) ||
        face < 1 ||
        face > 6
      ) {
        return {
          valid: false,
          error: 'count must be 1-10 and face must be 1-6.',
          retryable: true,
        };
      }
      if (state.currentBid !== null && !this.isBidHigher(state.currentBid, { count, face, bidder: actor })) {
        return {
          valid: false,
          error: `Your bid must be strictly higher than the current bid (count: ${state.currentBid.count}, face: ${state.currentBid.face}).`,
          retryable: true,
        };
      }
      return { valid: true };
    }

    if (tool === 'call_bluff') {
      if (state.phase !== 'bidding') {
        return { valid: false, error: 'call_bluff is only allowed during the bidding phase.' };
      }
      if (actor !== state.activeBidder) {
        return { valid: false, error: 'It is not your turn.' };
      }
      if (state.currentBid === null) {
        return { valid: false, error: 'There is no bid to challenge. You must bid first.' };
      }
      if (state.lastBidder === actor) {
        return { valid: false, error: 'You cannot challenge your own bid.' };
      }
      return { valid: true };
    }

    return { valid: false, error: `Unknown tool: ${tool}` };
  }

  applyAction(state: BluffDiceState, action: Action): ApplyActionResult<BluffDiceState> {
    const { tool, args, actor } = action;

    if (tool === 'get_state') {
      const result = this.buildStateResult(state, actor ?? '');
      return { state, result };
    }

    if (tool === 'place_bet') {
      const amount = args.amount as number;
      const newState = this.applyPlaceBet(state, actor ?? '', amount);
      return { state: newState, result: { status: 'bet_placed', amount } };
    }

    if (tool === 'make_bid') {
      const count = args.count as number;
      const face = args.face as number;
      const newState = this.applyMakeBid(state, actor ?? '', { count, face });
      return { state: newState, result: { status: 'bid_made', count, face } };
    }

    if (tool === 'call_bluff') {
      const newState = this.applyCallBluff(state, actor ?? '');
      const history = newState.roundHistory;
      const lastResult = history[history.length - 1];
      return {
        state: newState,
        result: lastResult
          ? ({
              status: 'resolved',
              winner: lastResult.winner ?? null,
              loser: lastResult.loser,
              actualCount: lastResult.actualCount,
              bidAtChallenge: lastResult.bidAtChallenge as unknown as JsonValue,
              revealedDice: lastResult.revealedDice as unknown as JsonValue,
            } as JsonValue)
          : { status: 'resolved' },
      };
    }

    return { state, result: null };
  }

  checkTermination(state: BluffDiceState): TerminationResult | null {
    if (state.terminationResult !== null) {
      return state.terminationResult;
    }

    if (state.gameOver) {
      return this.computeTermination(state);
    }

    if (state.turn > state.turnLimit) {
      return this.computeTermination(state);
    }

    return null;
  }

  getTurnEventAnalytics(state: BluffDiceState, actorId: string, _action: Action): TurnEventAnalytics {
    const playerIdx = state.agentIds.indexOf(actorId);
    const opponentIdx = playerIdx === 0 ? 1 : 0;
    const myChips = state.players[playerIdx]?.chips ?? 0;
    const opponentChips = state.players[opponentIdx]?.chips ?? 0;

    return {
      phase: state.phase,
      seat: playerIdx === 1 ? 'second' : 'first',
      scoreDiff: myChips - opponentChips,
    };
  }

  redactState(state: BluffDiceState): BluffDiceState {
    return {
      ...state,
      players: [
        { ...state.players[0], dice: [], bet: 0 },
        { ...state.players[1], dice: [], bet: 0 },
      ],
    };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private applyPlaceBet(state: BluffDiceState, agentId: string, amount: number): BluffDiceState {
    const playerIdx = state.agentIds.indexOf(agentId);
    const existingPlayer = state.players[playerIdx] as BluffDicePlayerState;
    const updatedPlayer: BluffDicePlayerState = {
      ...existingPlayer,
      bet: amount,
      betPlaced: true,
    };
    const players: [BluffDicePlayerState, BluffDicePlayerState] =
      playerIdx === 0
        ? [updatedPlayer, state.players[1]]
        : [state.players[0], updatedPlayer];

    const bothBet = players[0].betPlaced && players[1].betPlaced;

    if (!bothBet) {
      return { ...state, players, turn: state.turn + 1 };
    }

    // Both bets placed: roll dice and transition to bidding
    const dice0 = this.rollDice(state.seed, state.round, 0, state.diceCount);
    const dice1 = this.rollDice(state.seed, state.round, 1, state.diceCount);
    const pot = players[0].bet + players[1].bet;

    const biddingPlayers: [BluffDicePlayerState, BluffDicePlayerState] = [
      { ...players[0], dice: dice0 },
      { ...players[1], dice: dice1 },
    ];

    return {
      ...state,
      players: biddingPlayers,
      phase: 'bidding',
      activeBidder: state.firstBidder,
      pot,
      turn: state.turn + 1,
    };
  }

  private applyMakeBid(
    state: BluffDiceState,
    agentId: string,
    bid: { count: number; face: number },
  ): BluffDiceState {
    const opponentIdx = state.agentIds.indexOf(agentId) === 0 ? 1 : 0;
    const newBid: BluffDiceBid = { ...bid, bidder: agentId };

    return {
      ...state,
      currentBid: newBid,
      lastBidder: agentId,
      activeBidder: state.agentIds[opponentIdx],
      turn: state.turn + 1,
    };
  }

  private applyCallBluff(state: BluffDiceState, challenger: string): BluffDiceState {
    return this.resolveBluff(state, challenger);
  }

  private resolveBluff(state: BluffDiceState, challenger: string): BluffDiceState {
    const bid = state.currentBid!;
    const bidder = bid.bidder;

    // Count actual occurrences of bid.face across all dice
    const allDice = [...state.players[0].dice, ...state.players[1].dice];
    const actualCount = allDice.filter((d) => d === bid.face).length;

    // If actual >= bid.count, bid was truthful → challenger loses; else bidder loses
    const bidWasTrue = actualCount >= bid.count;
    const winner = bidWasTrue ? bidder : challenger;
    const loser = bidWasTrue ? challenger : bidder;

    const winnerIdx = state.agentIds.indexOf(winner);
    const loserIdx = state.agentIds.indexOf(loser);

    const loserPlayer = state.players[loserIdx] as BluffDicePlayerState;
    const winnerPlayer = state.players[winnerIdx] as BluffDicePlayerState;
    const loserBet = loserPlayer.bet;
    const updatedLoser: BluffDicePlayerState = {
      ...loserPlayer,
      chips: Math.max(0, loserPlayer.chips - loserBet),
    };
    const updatedWinner: BluffDicePlayerState = {
      ...winnerPlayer,
      chips: winnerPlayer.chips + state.pot,
    };
    const updatedPlayers: [BluffDicePlayerState, BluffDicePlayerState] =
      winnerIdx === 0
        ? [updatedWinner, updatedLoser]
        : [updatedLoser, updatedWinner];

    // Check if game ends
    const loserHitZero = updatedLoser.chips === 0;

    const revealedDice: Record<string, number[]> = {
      [state.agentIds[0]]: [...state.players[0].dice],
      [state.agentIds[1]]: [...state.players[1].dice],
    };

    const roundResult: BluffDiceRoundResult = {
      round: state.round,
      bids: this.collectBidHistory(state),
      callBluffBy: challenger,
      winner,
      loser,
      potSize: state.pot,
      revealedDice,
      actualCount,
      bidAtChallenge: { count: bid.count, face: bid.face },
    };

    const roundHistory = [...state.roundHistory, roundResult];
    const turn = state.turn + 1;

    const lastRound = state.round >= state.maxRounds;
    const gameOver = lastRound || loserHitZero;

    if (gameOver) {
      const terminationResult = this.computeTerminationFromPlayers(updatedPlayers, state.agentIds, 'All rounds completed');
      return {
        ...state,
        players: updatedPlayers,
        roundHistory,
        turn,
        phase: 'finished',
        gameOver: true,
        terminationResult,
        currentBid: null,
        activeBidder: null,
        lastBidder: null,
      };
    }

    return this.startNewRound({
      ...state,
      players: updatedPlayers,
      roundHistory,
      turn,
    });
  }

  private startNewRound(state: BluffDiceState): BluffDiceState {
    const newRound = state.round + 1;
    // Alternate firstBidder each round (0-indexed modulo: round 1 → agent-1, round 2 → agent-2, ...)
    const firstBidder = state.agentIds[(newRound - 1) % 2] as string;

    const resetPlayers: [BluffDicePlayerState, BluffDicePlayerState] = [
      { ...state.players[0], bet: 0, betPlaced: false, dice: [] },
      { ...state.players[1], bet: 0, betPlaced: false, dice: [] },
    ];

    return {
      ...state,
      round: newRound,
      phase: 'betting',
      players: resetPlayers,
      activeBidder: null,
      firstBidder,
      lastBidder: null,
      currentBid: null,
      pot: 0,
    };
  }

  private rollDice(seed: number, round: number, playerIndex: number, count: number): number[] {
    return Array.from({ length: count }, (_, i) => {
      const raw = Math.abs(Math.sin(seed + round * 1000 + playerIndex * 100 + i)) * 10000;
      return (Math.floor(raw) % 6) + 1;
    });
  }

  private isBidHigher(current: BluffDiceBid, proposed: BluffDiceBid): boolean {
    return proposed.count > current.count || (proposed.count === current.count && proposed.face > current.face);
  }

  private computeTermination(state: BluffDiceState): TerminationResult {
    return this.computeTerminationFromPlayers(state.players, state.agentIds, 'All rounds completed');
  }

  private computeTerminationFromPlayers(
    players: [BluffDicePlayerState, BluffDicePlayerState],
    agentIds: [string, string],
    reason: string,
  ): TerminationResult {
    const chips0 = players[0].chips;
    const chips1 = players[1].chips;

    if (chips0 === chips1) {
      return { ended: true, reason };
    }

    const winner = chips0 > chips1 ? agentIds[0] : agentIds[1];
    return { ended: true, winner, reason };
  }

  private buildStateResult(state: BluffDiceState, agentId: string): JsonValue {
    const playerIdx = state.agentIds.indexOf(agentId);
    const opponentIdx = playerIdx === 0 ? 1 : 0;
    const myPlayer = state.players[playerIdx];
    const opponentPlayer = state.players[opponentIdx];

    return {
      round: state.round,
      maxRounds: state.maxRounds,
      phase: state.phase,
      pot: state.pot,
      currentBid: state.currentBid as JsonValue,
      activeBidder: state.activeBidder,
      myChips: myPlayer?.chips ?? 0,
      myDice: state.phase === 'bidding' ? [...(myPlayer?.dice ?? [])] : [],
      myBetPlaced: myPlayer?.betPlaced ?? false,
      opponentBetPlaced: opponentPlayer?.betPlaced ?? false,
      opponentDiceCount: opponentPlayer?.diceCount ?? 0,
      opponentChips: opponentPlayer?.chips ?? 0,
      roundHistory: state.roundHistory.slice(-3) as unknown as JsonValue,
    };
  }

  private collectBidHistory(state: BluffDiceState): BluffDiceBid[] {
    // The engine does not store bid history in state by default.
    // We only have the current bid at resolution time.
    return state.currentBid !== null ? [{ ...state.currentBid }] : [];
  }
}
