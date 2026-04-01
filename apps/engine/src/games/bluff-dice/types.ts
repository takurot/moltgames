import type { MCPToolDefinition } from '@moltgames/mcp-protocol';
import type { TerminationResult } from '../../framework/types.js';

export interface BluffDicePlayerState {
  agentId: string;
  chips: number;
  dice: number[];     // 1-6 values, length = diceCount; empty outside bidding phase
  diceCount: number;  // always public
  bet: number;        // current round bet (0 if not placed); hidden until resolution
  betPlaced: boolean; // public: has this agent placed their bet this round
}

export interface BluffDiceBid {
  count: number;
  face: number;
  bidder: string; // agentId
}

export interface BluffDiceRoundResult {
  round: number;
  bids: BluffDiceBid[];
  callBluffBy: string;
  winner: string;
  loser: string;
  potSize: number;
  revealedDice: Record<string, number[]>;
  actualCount: number;
  bidAtChallenge: { count: number; face: number };
}

export type BluffDicePhase = 'betting' | 'bidding' | 'finished';

export interface BluffDiceState {
  ruleId: string;
  ruleVersion: string;
  toolDefinitions: MCPToolDefinition[];
  seed: number;
  round: number;
  maxRounds: number;
  turn: number;
  turnLimit: number;
  phase: BluffDicePhase;
  diceCount: number;       // from params, stored for rollDice
  maxBetPerRound: number;  // from params, stored for validation
  players: [BluffDicePlayerState, BluffDicePlayerState];
  agentIds: [string, string];
  activeBidder: string | null; // null during betting phase; set to firstBidder when bidding starts
  firstBidder: string;         // who goes first in bidding this round
  lastBidder: string | null;   // agentId of who made the most recent make_bid
  currentBid: BluffDiceBid | null;
  pot: number;
  roundHistory: BluffDiceRoundResult[];
  gameOver: boolean;
  terminationResult: TerminationResult | null;
}
