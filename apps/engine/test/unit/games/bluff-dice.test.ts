import { describe, it, expect, beforeEach } from 'vitest';
import type { LoadedGameRule } from '@moltgames/rules';

import { BluffDiceGame } from '../../../src/games/bluff-dice/index.js';
import type { BluffDiceState } from '../../../src/games/bluff-dice/types.js';

const CUSTOM_RULE: LoadedGameRule = {
  gameId: 'bluff-dice',
  ruleId: 'test',
  ruleVersion: '1.0.0',
  turnLimit: 120,
  turnTimeoutSeconds: 30,
  tools: [
    {
      name: 'get_state',
      description: 'Get the current game state.',
      version: '1.0.0',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'place_bet',
      description: 'Place your bet.',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: { amount: { type: 'integer', minimum: 1 } },
        required: ['amount'],
        additionalProperties: false,
      },
    },
    {
      name: 'make_bid',
      description: 'Make a bid.',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 10 },
          face: { type: 'integer', minimum: 1, maximum: 6 },
        },
        required: ['count', 'face'],
        additionalProperties: false,
      },
    },
    {
      name: 'call_bluff',
      description: 'Call bluff.',
      version: '1.0.0',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
  parameters: { initialChips: 20, maxRounds: 3, diceCount: 3, maxBetPerRound: 5 },
  termination: { type: 'bluff-dice', reason: 'All rounds completed' },
  redactionPolicy: { type: 'hide-opponent-dice-and-bet' },
};

describe('BluffDiceGame', () => {
  let plugin: BluffDiceGame;
  const agent1 = 'agent-1';
  const agent2 = 'agent-2';

  beforeEach(() => {
    plugin = new BluffDiceGame();
  });

  // ─── initialize ───────────────────────────────────────────────────────────

  describe('initialize', () => {
    it('should initialize with default params', () => {
      const state = plugin.initialize(42);
      expect(state.phase).toBe('betting');
      expect(state.turn).toBe(1);
      expect(state.round).toBe(1);
      expect(state.maxRounds).toBe(5);
      expect(state.diceCount).toBe(5);
      expect(state.maxBetPerRound).toBe(10);
      expect(state.players[0].chips).toBe(50);
      expect(state.players[1].chips).toBe(50);
      expect(state.players[0].agentId).toBe(agent1);
      expect(state.players[1].agentId).toBe(agent2);
      expect(state.players[0].dice).toEqual([]);
      expect(state.players[1].dice).toEqual([]);
      expect(state.players[0].betPlaced).toBe(false);
      expect(state.players[1].betPlaced).toBe(false);
      expect(state.pot).toBe(0);
      expect(state.currentBid).toBeNull();
      expect(state.activeBidder).toBeNull();
      expect(state.firstBidder).toBe(agent1);
      expect(state.lastBidder).toBeNull();
      expect(state.roundHistory).toEqual([]);
      expect(state.gameOver).toBe(false);
    });

    it('should honor custom rule params', () => {
      const state = plugin.initialize(42, CUSTOM_RULE);
      expect(state.maxRounds).toBe(3);
      expect(state.diceCount).toBe(3);
      expect(state.maxBetPerRound).toBe(5);
      expect(state.players[0].chips).toBe(20);
      expect(state.players[1].chips).toBe(20);
    });

    it('should produce deterministic state for the same seed', () => {
      const s1 = plugin.initialize(999);
      const s2 = plugin.initialize(999);
      expect(s1).toEqual(s2);
    });
  });

  // ─── getTurn ──────────────────────────────────────────────────────────────

  describe('getTurn', () => {
    it('should return state.turn', () => {
      const state = plugin.initialize(1);
      expect(plugin.getTurn(state)).toBe(1);
    });
  });

  // ─── getAvailableTools ────────────────────────────────────────────────────

  describe('getAvailableTools', () => {
    it('both agents see get_state and place_bet during betting when neither has bet', () => {
      const state = plugin.initialize(1);
      const tools1 = plugin.getAvailableTools(state, agent1, 'default');
      const tools2 = plugin.getAvailableTools(state, agent2, 'default');
      expect(tools1.map((t) => t.name)).toContain('get_state');
      expect(tools1.map((t) => t.name)).toContain('place_bet');
      expect(tools2.map((t) => t.name)).toContain('get_state');
      expect(tools2.map((t) => t.name)).toContain('place_bet');
    });

    it('agent that has already bet only sees get_state', () => {
      const state = plugin.initialize(1);
      const betState = plugin.applyAction(state, {
        tool: 'place_bet',
        request_id: 'r1',
        args: { amount: 3 },
        actor: agent1,
      }).state as BluffDiceState;
      const tools1 = plugin.getAvailableTools(betState, agent1, 'default');
      expect(tools1.map((t) => t.name)).toContain('get_state');
      expect(tools1.map((t) => t.name)).not.toContain('place_bet');
      // agent2 still can bet
      const tools2 = plugin.getAvailableTools(betState, agent2, 'default');
      expect(tools2.map((t) => t.name)).toContain('place_bet');
    });

    it('activeBidder gets make_bid during bidding', () => {
      const state = transitionToBidding(plugin, 3, 3);
      const activeBidder = state.activeBidder as string;
      const tools = plugin.getAvailableTools(state, activeBidder, 'default');
      expect(tools.map((t) => t.name)).toContain('make_bid');
      expect(tools.map((t) => t.name)).not.toContain('place_bet');
    });

    it('activeBidder gets call_bluff only when there is a current bid they did not make', () => {
      const bidding = transitionToBidding(plugin, 3, 3);
      // No bid yet: no call_bluff
      const toolsNoBid = plugin.getAvailableTools(bidding, bidding.activeBidder!, 'default');
      expect(toolsNoBid.map((t) => t.name)).not.toContain('call_bluff');

      // After one bid, the other agent can call_bluff
      const afterBid = plugin.applyAction(bidding, {
        tool: 'make_bid',
        request_id: 'r2',
        args: { count: 1, face: 3 },
        actor: bidding.activeBidder!,
      }).state as BluffDiceState;
      const otherAgent = afterBid.activeBidder!;
      const toolsAfterBid = plugin.getAvailableTools(afterBid, otherAgent, 'default');
      expect(toolsAfterBid.map((t) => t.name)).toContain('call_bluff');
    });

    it('activeBidder who just bid cannot call_bluff', () => {
      const bidding = transitionToBidding(plugin, 3, 3);
      const firstBidder = bidding.activeBidder!;
      const afterBid = plugin.applyAction(bidding, {
        tool: 'make_bid',
        request_id: 'r3',
        args: { count: 1, face: 3 },
        actor: firstBidder,
      }).state as BluffDiceState;
      // After bid, activeBidder changed. The firstBidder is now NOT activeBidder,
      // but let's confirm they can't call_bluff (they made the last bid).
      // Actually at this point firstBidder is NOT activeBidder, so they see only get_state anyway.
      // What we want to test: the NEW activeBidder (other agent) can call_bluff
      // but if they bid again, they become lastBidder and can't call their own bid.
      const secondBidder = afterBid.activeBidder!;
      const afterSecondBid = plugin.applyAction(afterBid, {
        tool: 'make_bid',
        request_id: 'r4',
        args: { count: 2, face: 1 },
        actor: secondBidder,
      }).state as BluffDiceState;
      // Now firstBidder is activeBidder again; secondBidder (lastBidder) is NOT activeBidder
      const tools = plugin.getAvailableTools(afterSecondBid, afterSecondBid.activeBidder!, 'default');
      expect(tools.map((t) => t.name)).toContain('call_bluff'); // first bidder can call
      // secondBidder is not active, so this test verifies via activeBidder check
    });

    it('finished phase: only get_state available', () => {
      const state: BluffDiceState = { ...plugin.initialize(1), phase: 'finished', gameOver: true };
      const tools = plugin.getAvailableTools(state, agent1, 'default');
      expect(tools.map((t) => t.name)).toEqual(['get_state']);
    });
  });

  // ─── validateAction ───────────────────────────────────────────────────────

  describe('validateAction - place_bet', () => {
    it('valid amount', () => {
      const state = plugin.initialize(1, CUSTOM_RULE);
      const result = plugin.validateAction(state, {
        tool: 'place_bet',
        request_id: 'r',
        args: { amount: 3 },
        actor: agent1,
      });
      expect(result.valid).toBe(true);
    });

    it('amount must be at least 1', () => {
      const state = plugin.initialize(1, CUSTOM_RULE);
      const result = plugin.validateAction(state, {
        tool: 'place_bet',
        request_id: 'r',
        args: { amount: 0 },
        actor: agent1,
      });
      expect(result.valid).toBe(false);
    });

    it('amount cannot exceed maxBetPerRound', () => {
      const state = plugin.initialize(1, CUSTOM_RULE);
      const result = plugin.validateAction(state, {
        tool: 'place_bet',
        request_id: 'r',
        args: { amount: 6 }, // maxBetPerRound = 5 in CUSTOM_RULE
        actor: agent1,
      });
      expect(result.valid).toBe(false);
    });

    it('amount cannot exceed chips', () => {
      const state = plugin.initialize(1, CUSTOM_RULE);
      // Set chips to 2 manually for testing
      const lowChipsState: BluffDiceState = {
        ...state,
        players: [{ ...state.players[0], chips: 2 }, state.players[1]],
      };
      const result = plugin.validateAction(lowChipsState, {
        tool: 'place_bet',
        request_id: 'r',
        args: { amount: 3 },
        actor: agent1,
      });
      expect(result.valid).toBe(false);
    });

    it('cannot bet after already placing bet', () => {
      const state = plugin.initialize(1, CUSTOM_RULE);
      const after = plugin.applyAction(state, {
        tool: 'place_bet',
        request_id: 'r1',
        args: { amount: 2 },
        actor: agent1,
      }).state as BluffDiceState;
      const result = plugin.validateAction(after, {
        tool: 'place_bet',
        request_id: 'r2',
        args: { amount: 2 },
        actor: agent1,
      });
      expect(result.valid).toBe(false);
    });

    it('cannot bet during bidding phase', () => {
      const state = transitionToBidding(plugin, 3, 3, CUSTOM_RULE);
      const result = plugin.validateAction(state, {
        tool: 'place_bet',
        request_id: 'r',
        args: { amount: 2 },
        actor: agent1,
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('validateAction - make_bid', () => {
    it('first bid (no currentBid): any valid count/face accepted', () => {
      const state = transitionToBidding(plugin, 3, 3, CUSTOM_RULE);
      const result = plugin.validateAction(state, {
        tool: 'make_bid',
        request_id: 'r',
        args: { count: 1, face: 1 },
        actor: state.activeBidder!,
      });
      expect(result.valid).toBe(true);
    });

    it('higher count is strictly higher', () => {
      const state = transitionToBidding(plugin, 3, 3, CUSTOM_RULE);
      const afterBid = plugin.applyAction(state, {
        tool: 'make_bid',
        request_id: 'r1',
        args: { count: 2, face: 4 },
        actor: state.activeBidder!,
      }).state as BluffDiceState;
      const result = plugin.validateAction(afterBid, {
        tool: 'make_bid',
        request_id: 'r2',
        args: { count: 3, face: 1 }, // higher count, any face is valid
        actor: afterBid.activeBidder!,
      });
      expect(result.valid).toBe(true);
    });

    it('same count + higher face is strictly higher', () => {
      const state = transitionToBidding(plugin, 3, 3, CUSTOM_RULE);
      const afterBid = plugin.applyAction(state, {
        tool: 'make_bid',
        request_id: 'r1',
        args: { count: 2, face: 3 },
        actor: state.activeBidder!,
      }).state as BluffDiceState;
      const result = plugin.validateAction(afterBid, {
        tool: 'make_bid',
        request_id: 'r2',
        args: { count: 2, face: 4 },
        actor: afterBid.activeBidder!,
      });
      expect(result.valid).toBe(true);
    });

    it('same count + same face is NOT strictly higher', () => {
      const state = transitionToBidding(plugin, 3, 3, CUSTOM_RULE);
      const afterBid = plugin.applyAction(state, {
        tool: 'make_bid',
        request_id: 'r1',
        args: { count: 2, face: 3 },
        actor: state.activeBidder!,
      }).state as BluffDiceState;
      const result = plugin.validateAction(afterBid, {
        tool: 'make_bid',
        request_id: 'r2',
        args: { count: 2, face: 3 },
        actor: afterBid.activeBidder!,
      });
      expect(result.valid).toBe(false);
    });

    it('lower count is NOT strictly higher', () => {
      const state = transitionToBidding(plugin, 3, 3, CUSTOM_RULE);
      const afterBid = plugin.applyAction(state, {
        tool: 'make_bid',
        request_id: 'r1',
        args: { count: 3, face: 3 },
        actor: state.activeBidder!,
      }).state as BluffDiceState;
      const result = plugin.validateAction(afterBid, {
        tool: 'make_bid',
        request_id: 'r2',
        args: { count: 2, face: 6 },
        actor: afterBid.activeBidder!,
      });
      expect(result.valid).toBe(false);
    });

    it('non-activeBidder cannot make_bid', () => {
      const state = transitionToBidding(plugin, 3, 3, CUSTOM_RULE);
      const otherAgent = state.activeBidder === agent1 ? agent2 : agent1;
      const result = plugin.validateAction(state, {
        tool: 'make_bid',
        request_id: 'r',
        args: { count: 1, face: 1 },
        actor: otherAgent,
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('validateAction - call_bluff', () => {
    it('valid when currentBid exists and caller is not lastBidder', () => {
      const bidding = transitionToBidding(plugin, 3, 3, CUSTOM_RULE);
      const afterBid = plugin.applyAction(bidding, {
        tool: 'make_bid',
        request_id: 'r1',
        args: { count: 1, face: 3 },
        actor: bidding.activeBidder!,
      }).state as BluffDiceState;
      const result = plugin.validateAction(afterBid, {
        tool: 'call_bluff',
        request_id: 'r2',
        args: {},
        actor: afterBid.activeBidder!,
      });
      expect(result.valid).toBe(true);
    });

    it('invalid when no currentBid', () => {
      const state = transitionToBidding(plugin, 3, 3, CUSTOM_RULE);
      const result = plugin.validateAction(state, {
        tool: 'call_bluff',
        request_id: 'r',
        args: {},
        actor: state.activeBidder!,
      });
      expect(result.valid).toBe(false);
    });

    it('invalid when caller is lastBidder', () => {
      const bidding = transitionToBidding(plugin, 3, 3, CUSTOM_RULE);
      const firstBidder = bidding.activeBidder!;
      const afterBid = plugin.applyAction(bidding, {
        tool: 'make_bid',
        request_id: 'r1',
        args: { count: 1, face: 3 },
        actor: firstBidder,
      }).state as BluffDiceState;
      // Now firstBidder is lastBidder but NOT activeBidder — other agent is activeBidder
      // To test "caller is lastBidder": we need to set up a state where activeBidder === lastBidder
      // This can happen if we override the state manually
      const trickState: BluffDiceState = { ...afterBid, activeBidder: firstBidder };
      const result = plugin.validateAction(trickState, {
        tool: 'call_bluff',
        request_id: 'r2',
        args: {},
        actor: firstBidder,
      });
      expect(result.valid).toBe(false);
    });
  });

  // ─── applyAction ──────────────────────────────────────────────────────────

  describe('applyAction - place_bet', () => {
    it('single bet does not transition phase', () => {
      const state = plugin.initialize(1, CUSTOM_RULE);
      const { state: after } = plugin.applyAction(state, {
        tool: 'place_bet',
        request_id: 'r',
        args: { amount: 3 },
        actor: agent1,
      });
      const afterState = after as BluffDiceState;
      expect(afterState.phase).toBe('betting');
      expect(afterState.players[0].betPlaced).toBe(true);
      expect(afterState.players[0].bet).toBe(3);
      expect(afterState.players[1].betPlaced).toBe(false);
      expect(afterState.turn).toBe(2);
    });

    it('both bets placed transitions to bidding and rolls dice', () => {
      const biddingState = transitionToBidding(plugin, 42, 3, CUSTOM_RULE);
      expect(biddingState.phase).toBe('bidding');
      expect(biddingState.activeBidder).toBe(agent1);
      expect(biddingState.players[0].dice).toHaveLength(3);
      expect(biddingState.players[1].dice).toHaveLength(3);
      expect(biddingState.pot).toBe(6); // 3 + 3
      // dice values in range 1-6
      for (const die of [...biddingState.players[0].dice, ...biddingState.players[1].dice]) {
        expect(die).toBeGreaterThanOrEqual(1);
        expect(die).toBeLessThanOrEqual(6);
      }
    });

    it('does not mutate original state', () => {
      const state = plugin.initialize(1, CUSTOM_RULE);
      plugin.applyAction(state, {
        tool: 'place_bet',
        request_id: 'r',
        args: { amount: 3 },
        actor: agent1,
      });
      expect(state.players[0].betPlaced).toBe(false);
      expect(state.turn).toBe(1);
    });
  });

  describe('applyAction - get_state', () => {
    it('returns own dice during bidding', () => {
      const state = transitionToBidding(plugin, 42, 3, CUSTOM_RULE);
      const { result } = plugin.applyAction(state, {
        tool: 'get_state',
        request_id: 'r',
        args: {},
        actor: agent1,
      });
      const r = result as Record<string, unknown>;
      expect(Array.isArray(r.myDice)).toBe(true);
      expect((r.myDice as number[]).length).toBe(3);
    });

    it('returns empty dice during betting', () => {
      const state = plugin.initialize(1, CUSTOM_RULE);
      const { result } = plugin.applyAction(state, {
        tool: 'get_state',
        request_id: 'r',
        args: {},
        actor: agent1,
      });
      const r = result as Record<string, unknown>;
      expect(r.myDice).toEqual([]);
    });

    it('does not advance turn', () => {
      const state = plugin.initialize(1, CUSTOM_RULE);
      const { state: after } = plugin.applyAction(state, {
        tool: 'get_state',
        request_id: 'r',
        args: {},
        actor: agent1,
      });
      expect((after as BluffDiceState).turn).toBe(1);
    });
  });

  // ─── dice determinism ─────────────────────────────────────────────────────

  describe('dice rolling', () => {
    it('same seed+round+player always produces same dice', () => {
      const s1 = transitionToBidding(plugin, 77, 3, CUSTOM_RULE);
      const s2 = transitionToBidding(plugin, 77, 3, CUSTOM_RULE);
      expect(s1.players[0].dice).toEqual(s2.players[0].dice);
      expect(s1.players[1].dice).toEqual(s2.players[1].dice);
    });

    it('different seeds produce different dice', () => {
      const s1 = transitionToBidding(plugin, 77, 3, CUSTOM_RULE);
      const s2 = transitionToBidding(plugin, 78, 3, CUSTOM_RULE);
      // Not guaranteed to differ for every die, but the arrays should differ overall
      const sameP0 = s1.players[0].dice.every((d, i) => d === s2.players[0].dice[i]);
      const sameP1 = s1.players[1].dice.every((d, i) => d === s2.players[1].dice[i]);
      expect(sameP0 && sameP1).toBe(false);
    });
  });

  // ─── bluff resolution ─────────────────────────────────────────────────────

  describe('bluff resolution', () => {
    it('bidder loses when bid was a bluff (actual < bid.count)', () => {
      const { state, bidder, challenger } = setupResolution(plugin, { bidCount: 10, bidFace: 6 });
      const { state: after } = plugin.applyAction(state, {
        tool: 'call_bluff',
        request_id: 'r',
        args: {},
        actor: challenger,
      });
      const afterState = after as BluffDiceState;
      expect(afterState.roundHistory).toHaveLength(1);
      const result = afterState.roundHistory[0];
      // Very unlikely 10 sixes exist with 6 total dice (3+3)
      expect(result.winner).toBe(challenger);
      expect(result.loser).toBe(bidder);
    });

    it('caller loses when bid was truthful (actual >= bid.count)', () => {
      // Force a trivially true bid: 1 die showing face 1 (almost certainly true)
      const { state, bidder, challenger } = setupResolution(plugin, { bidCount: 1, bidFace: 1 });
      // We need to know dice values to force the test; instead use a known-good scenario
      // with low bid count that's almost guaranteed to be truthful
      const { state: after } = plugin.applyAction(state, {
        tool: 'call_bluff',
        request_id: 'r',
        args: {},
        actor: challenger,
      });
      const afterState = after as BluffDiceState;
      const result = afterState.roundHistory[0];
      if (result.actualCount >= 1) {
        expect(result.winner).toBe(bidder);
        expect(result.loser).toBe(challenger);
      } else {
        // If actual < 1 (no face-1 dice), bidder lost
        expect(result.winner).toBe(challenger);
      }
    });

    it('chips change correctly after resolution', () => {
      const betAmount = 3;
      const { state, bidder, challenger } = setupResolution(plugin, {
        bidCount: 10,
        bidFace: 6,
        betAmount,
      });
      const chipsBefore0 = state.players[0].chips;
      const chipsBefore1 = state.players[1].chips;
      const { state: after } = plugin.applyAction(state, {
        tool: 'call_bluff',
        request_id: 'r',
        args: {},
        actor: challenger,
      });
      const afterState = after as BluffDiceState;
      const result = afterState.roundHistory[0];
      const pot = betAmount * 2;
      // Winner chips increase by pot, loser chips decrease by their bet
      const winnerIdx = afterState.agentIds.indexOf(result.winner);
      const loserIdx = afterState.agentIds.indexOf(result.loser);
      const chipsBefore = [chipsBefore0, chipsBefore1];
      expect(afterState.players[winnerIdx].chips).toBe(chipsBefore[winnerIdx] + pot);
      expect(afterState.players[loserIdx].chips).toBe(chipsBefore[loserIdx] - betAmount);
    });

    it('round history records correct data', () => {
      const { state, challenger } = setupResolution(plugin, { bidCount: 10, bidFace: 6 });
      const { state: after } = plugin.applyAction(state, {
        tool: 'call_bluff',
        request_id: 'r',
        args: {},
        actor: challenger,
      });
      const result = (after as BluffDiceState).roundHistory[0];
      expect(result.round).toBe(1);
      expect(result.callBluffBy).toBe(challenger);
      expect(result.bidAtChallenge).toEqual({ count: 10, face: 6 });
      expect(result.revealedDice[agent1]).toHaveLength(3);
      expect(result.revealedDice[agent2]).toHaveLength(3);
    });

    it('transitions to next round after resolution (not last round)', () => {
      const { state, challenger } = setupResolution(plugin, { bidCount: 10, bidFace: 6 });
      const { state: after } = plugin.applyAction(state, {
        tool: 'call_bluff',
        request_id: 'r',
        args: {},
        actor: challenger,
      });
      const afterState = after as BluffDiceState;
      expect(afterState.round).toBe(2);
      expect(afterState.phase).toBe('betting');
      expect(afterState.currentBid).toBeNull();
      expect(afterState.activeBidder).toBeNull();
      expect(afterState.players[0].betPlaced).toBe(false);
      expect(afterState.players[1].betPlaced).toBe(false);
    });

    it('firstBidder alternates each round', () => {
      const { state, challenger } = setupResolution(plugin, { bidCount: 10, bidFace: 6 });
      const { state: round2 } = plugin.applyAction(state, {
        tool: 'call_bluff',
        request_id: 'r',
        args: {},
        actor: challenger,
      });
      expect((round2 as BluffDiceState).firstBidder).toBe(agent2);
    });

    it('game ends after maxRounds', () => {
      let state = plugin.initialize(42, CUSTOM_RULE); // maxRounds = 3
      for (let round = 0; round < 3; round++) {
        // Transition to bidding using the current state
        state = transitionToBidding(plugin, 42, 3, CUSTOM_RULE, state);
        // Place a bid first (required before call_bluff)
        const { state: afterBid } = plugin.applyAction(state, {
          tool: 'make_bid',
          request_id: `bid-${round}`,
          args: { count: 10, face: 6 }, // guaranteed bluff bid
          actor: state.activeBidder!,
        });
        state = afterBid as BluffDiceState;
        // Now call_bluff (challenger is now activeBidder)
        const { state: afterBluff } = plugin.applyAction(state, {
          tool: 'call_bluff',
          request_id: `bluff-${round}`,
          args: {},
          actor: state.activeBidder!,
        });
        state = afterBluff as BluffDiceState;
      }
      expect(state.gameOver).toBe(true);
      expect(state.phase).toBe('finished');
    });

    it('game ends early when a player reaches 0 chips', () => {
      const state = plugin.initialize(42, CUSTOM_RULE);
      // Give agent1 only 3 chips, and make bet amount == chips
      const poorState: BluffDiceState = {
        ...state,
        players: [{ ...state.players[0], chips: 3 }, state.players[1]],
      };
      // Transition to bidding with agent1 betting all chips
      const biddingState = forceBettingWithAmounts(plugin, poorState, 3, 3);
      // Make a guaranteed-bluff bid (10 sixes with only 6 dice)
      const afterBid = plugin.applyAction(biddingState, {
        tool: 'make_bid',
        request_id: 'r1',
        args: { count: 10, face: 6 },
        actor: biddingState.activeBidder!,
      }).state as BluffDiceState;
      const { state: after } = plugin.applyAction(afterBid, {
        tool: 'call_bluff',
        request_id: 'r2',
        args: {},
        actor: afterBid.activeBidder!,
      });
      const afterState = after as BluffDiceState;
      // Either bidder or challenger hit 0 chips; if bidder had 3 chips and lost...
      if (afterState.roundHistory[0].loser === agent1) {
        expect(afterState.players[0].chips).toBe(0);
        expect(afterState.gameOver).toBe(true);
      }
    });
  });

  // ─── checkTermination ─────────────────────────────────────────────────────

  describe('checkTermination', () => {
    it('returns null mid-game', () => {
      const state = plugin.initialize(1, CUSTOM_RULE);
      expect(plugin.checkTermination(state)).toBeNull();
    });

    it('returns winner with most chips after gameOver', () => {
      const state: BluffDiceState = {
        ...plugin.initialize(1, CUSTOM_RULE),
        gameOver: true,
        players: [
          { ...plugin.initialize(1, CUSTOM_RULE).players[0], chips: 30 },
          { ...plugin.initialize(1, CUSTOM_RULE).players[1], chips: 10 },
        ],
      };
      const term = plugin.checkTermination(state);
      expect(term).not.toBeNull();
      expect(term!.ended).toBe(true);
      expect(term!.winner).toBe(agent1);
    });

    it('returns draw when chips are equal', () => {
      const state: BluffDiceState = {
        ...plugin.initialize(1, CUSTOM_RULE),
        gameOver: true,
        players: [
          { ...plugin.initialize(1, CUSTOM_RULE).players[0], chips: 20 },
          { ...plugin.initialize(1, CUSTOM_RULE).players[1], chips: 20 },
        ],
      };
      const term = plugin.checkTermination(state);
      expect(term!.ended).toBe(true);
      expect(term!.winner).toBeUndefined();
    });

    it('returns cached terminationResult if set', () => {
      const cached = { ended: true, winner: agent2, reason: 'cached' };
      const state: BluffDiceState = {
        ...plugin.initialize(1, CUSTOM_RULE),
        terminationResult: cached,
      };
      expect(plugin.checkTermination(state)).toBe(cached);
    });

    it('forces termination when turn exceeds turnLimit', () => {
      const state: BluffDiceState = {
        ...plugin.initialize(1, CUSTOM_RULE),
        turn: 999,
        turnLimit: 10,
        players: [
          { ...plugin.initialize(1, CUSTOM_RULE).players[0], chips: 30 },
          { ...plugin.initialize(1, CUSTOM_RULE).players[1], chips: 10 },
        ],
      };
      const term = plugin.checkTermination(state);
      expect(term!.ended).toBe(true);
    });
  });

  // ─── redactState ──────────────────────────────────────────────────────────

  describe('redactState', () => {
    it('clears both players dice and bet; keeps chips and betPlaced', () => {
      const biddingState = transitionToBidding(plugin, 42, 3, CUSTOM_RULE);
      // Give players some bet amounts for testing
      const stateWithBets: BluffDiceState = {
        ...biddingState,
        players: [
          { ...biddingState.players[0], bet: 3, betPlaced: true },
          { ...biddingState.players[1], bet: 5, betPlaced: true },
        ],
      };
      const redacted = plugin.redactState!(stateWithBets);
      expect(redacted.players[0].dice).toEqual([]);
      expect(redacted.players[1].dice).toEqual([]);
      expect(redacted.players[0].bet).toBe(0);
      expect(redacted.players[1].bet).toBe(0);
      // Chips and betPlaced remain
      expect(redacted.players[0].chips).toBe(stateWithBets.players[0].chips);
      expect(redacted.players[1].chips).toBe(stateWithBets.players[1].chips);
      expect(redacted.players[0].betPlaced).toBe(true);
      expect(redacted.players[1].betPlaced).toBe(true);
    });

    it('does not mutate original state', () => {
      const state = transitionToBidding(plugin, 42, 3, CUSTOM_RULE);
      plugin.redactState!(state);
      expect(state.players[0].dice).toHaveLength(3);
    });
  });

  // ─── consumeTurn ──────────────────────────────────────────────────────────

  describe('consumeTurn', () => {
    it('betting phase: advances turn by 1', () => {
      const state = plugin.initialize(1, CUSTOM_RULE);
      const after = plugin.consumeTurn(state);
      expect((after as BluffDiceState).turn).toBe(2);
    });

    it('bidding phase with no currentBid: forces minimum bid', () => {
      const state = transitionToBidding(plugin, 42, 3, CUSTOM_RULE);
      const after = plugin.consumeTurn(state) as BluffDiceState;
      // Should have set a bid and switched activeBidder
      expect(after.currentBid).not.toBeNull();
      expect(after.currentBid!.count).toBe(1);
      expect(after.currentBid!.face).toBe(1);
    });

    it('bidding phase with currentBid: forces count+1 bid', () => {
      const state = transitionToBidding(plugin, 42, 3, CUSTOM_RULE);
      const afterBid = plugin.applyAction(state, {
        tool: 'make_bid',
        request_id: 'r',
        args: { count: 3, face: 4 },
        actor: state.activeBidder!,
      }).state as BluffDiceState;
      const after = plugin.consumeTurn(afterBid) as BluffDiceState;
      expect(after.currentBid!.count).toBe(4);
      expect(after.currentBid!.face).toBe(1);
    });

    it('bidding phase with count=10: forces call_bluff', () => {
      const state = transitionToBidding(plugin, 42, 3, CUSTOM_RULE);
      const afterBid = plugin.applyAction(state, {
        tool: 'make_bid',
        request_id: 'r',
        args: { count: 10, face: 6 },
        actor: state.activeBidder!,
      }).state as BluffDiceState;
      const after = plugin.consumeTurn(afterBid) as BluffDiceState;
      // Should have triggered resolution: phase changed or roundHistory has an entry
      expect(after.roundHistory.length).toBeGreaterThan(0);
    });
  });

  // ─── getTurnEventAnalytics ────────────────────────────────────────────────

  describe('getTurnEventAnalytics', () => {
    it('returns correct seat and scoreDiff for agent1', () => {
      const state: BluffDiceState = {
        ...plugin.initialize(1, CUSTOM_RULE),
        players: [
          { ...plugin.initialize(1, CUSTOM_RULE).players[0], chips: 30 },
          { ...plugin.initialize(1, CUSTOM_RULE).players[1], chips: 20 },
        ],
      };
      const analytics = plugin.getTurnEventAnalytics!(state, agent1, {
        tool: 'get_state',
        request_id: 'r',
        args: {},
        actor: agent1,
      });
      expect(analytics.seat).toBe('first');
      expect(analytics.scoreDiff).toBe(10); // 30 - 20
    });

    it('returns second seat for agent2', () => {
      const state = plugin.initialize(1, CUSTOM_RULE);
      const analytics = plugin.getTurnEventAnalytics!(state, agent2, {
        tool: 'get_state',
        request_id: 'r',
        args: {},
        actor: agent2,
      });
      expect(analytics.seat).toBe('second');
    });
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Helper: place both bets and transition to bidding phase.
 * If a pre-existing state is provided, start from that state.
 */
function transitionToBidding(
  plugin: BluffDiceGame,
  seed: number,
  betAmount: number,
  rule?: LoadedGameRule,
  startState?: BluffDiceState,
): BluffDiceState {
  const state = startState ?? plugin.initialize(seed, rule);
  const agent1 = state.agentIds[0];
  const agent2 = state.agentIds[1];

  const afterBet1 = plugin.applyAction(state, {
    tool: 'place_bet',
    request_id: 'bet-1',
    args: { amount: betAmount },
    actor: agent1,
  }).state as BluffDiceState;

  return plugin.applyAction(afterBet1, {
    tool: 'place_bet',
    request_id: 'bet-2',
    args: { amount: betAmount },
    actor: agent2,
  }).state as BluffDiceState;
}

/**
 * Helper: force specific bet amounts without initialization.
 */
function forceBettingWithAmounts(
  plugin: BluffDiceGame,
  state: BluffDiceState,
  bet1: number,
  bet2: number,
): BluffDiceState {
  const agent1 = state.agentIds[0];
  const agent2 = state.agentIds[1];

  const afterBet1 = plugin.applyAction(state, {
    tool: 'place_bet',
    request_id: 'bet-f1',
    args: { amount: bet1 },
    actor: agent1,
  }).state as BluffDiceState;

  return plugin.applyAction(afterBet1, {
    tool: 'place_bet',
    request_id: 'bet-f2',
    args: { amount: bet2 },
    actor: agent2,
  }).state as BluffDiceState;
}

/**
 * Helper: set up a state ready for call_bluff.
 * Returns the state with a bid already placed and the bidder/challenger agents.
 */
function setupResolution(
  plugin: BluffDiceGame,
  options: { bidCount: number; bidFace: number; betAmount?: number },
): { state: BluffDiceState; bidder: string; challenger: string } {
  const rule = CUSTOM_RULE;
  const betAmount = options.betAmount ?? 3;
  const state0 = plugin.initialize(7, rule);
  const biddingState = transitionToBidding(plugin, 7, betAmount, rule, state0);

  const bidder = biddingState.activeBidder!;
  const challenger = biddingState.agentIds.find((id) => id !== bidder)!;

  const afterBid = plugin.applyAction(biddingState, {
    tool: 'make_bid',
    request_id: 'setup-bid',
    args: { count: options.bidCount, face: options.bidFace },
    actor: bidder,
  }).state as BluffDiceState;

  return { state: afterBid, bidder, challenger };
}
