import {
  type Action,
  type ApplyActionResult,
  type GamePlugin,
  type TerminationResult,
  type ValidationResult,
} from '../../framework/types.js';
import type { MCPToolDefinition } from '@moltgames/mcp-protocol';
import type { JsonValue } from '@moltgames/domain';
import type { LoadedGameRule } from '@moltgames/rules';

import { LLMJudge } from './judge.js';

const DEFAULT_RULE: LoadedGameRule = {
  gameId: 'vector-grid-wars',
  ruleId: 'standard',
  ruleVersion: '1.0.0',
  turnLimit: 30,
  turnTimeoutSeconds: 30,
  tools: [
    {
      name: 'get_board',
      description: 'Get the current state of the 10x10 board containing owners and concepts',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: 'place_unit',
      description:
        'Place a new unit on an empty cell with a semantic concept (e.g., "Fire Wall", "Defense Tower")',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'integer', minimum: 0, maximum: 9 },
          y: { type: 'integer', minimum: 0, maximum: 9 },
          concept: { type: 'string', minLength: 1, maxLength: 50 },
        },
        required: ['x', 'y', 'concept'],
        additionalProperties: false,
      },
    },
    {
      name: 'move_unit',
      description:
        'Move an existing unit you own to an adjacent empty cell (horizontal or vertical, distance 1)',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          fromX: { type: 'integer', minimum: 0, maximum: 9 },
          fromY: { type: 'integer', minimum: 0, maximum: 9 },
          toX: { type: 'integer', minimum: 0, maximum: 9 },
          toY: { type: 'integer', minimum: 0, maximum: 9 },
        },
        required: ['fromX', 'fromY', 'toX', 'toY'],
        additionalProperties: false,
      },
    },
  ],
  parameters: {
    gridSize: 10,
    conceptMaxLength: 50,
  },
  termination: {
    type: 'vector-grid-wars',
    judgeRuns: 2,
  },
  redactionPolicy: {
    type: 'none',
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

const pickTools = (
  tools: readonly MCPToolDefinition[],
  names: readonly string[],
): MCPToolDefinition[] => tools.filter((tool) => names.includes(tool.name));

export interface Cell {
  owner: string | null;
  concept: string | null;
}

export interface VectorGridWarsState {
  ruleId: string;
  ruleVersion: string;
  toolDefinitions: MCPToolDefinition[];
  gridSize: number;
  conceptMaxLength: number;
  grid: Cell[][];
  agent1Id: string;
  agent2Id: string;
  turn: number;
  maxTurns: number;
  gameOver: boolean;
  terminationResult: TerminationResult | null;
}

export class VectorGridWars implements GamePlugin<VectorGridWarsState> {
  gameId = 'vector-grid-wars';
  ruleVersion = '1.0.0';
  turnTimeoutSeconds = 30;

  private judge = new LLMJudge();

  initialize(_seed: number, rule: LoadedGameRule = DEFAULT_RULE): VectorGridWarsState {
    const parameters = rule.parameters as Record<string, unknown>;
    const gridSize = getNumberParameter(parameters, 'gridSize', 10);
    const conceptMaxLength = getNumberParameter(parameters, 'conceptMaxLength', 50);
    const grid: Cell[][] = Array.from({ length: gridSize }, () =>
      Array.from({ length: gridSize }, () => ({ owner: null, concept: null })),
    );

    return {
      ruleId: rule.ruleId,
      ruleVersion: rule.ruleVersion,
      toolDefinitions: [...rule.tools],
      gridSize,
      conceptMaxLength,
      grid,
      agent1Id: 'agent-1',
      agent2Id: 'agent-2',
      turn: 1,
      maxTurns: rule.turnLimit,
      gameOver: false,
      terminationResult: null,
    };
  }

  getTurn(state: VectorGridWarsState): number {
    return state.turn;
  }

  consumeTurn(state: VectorGridWarsState): VectorGridWarsState {
    return {
      ...state,
      turn: state.turn + 1,
    };
  }

  getAvailableTools(
    state: VectorGridWarsState,
    agentId: string,
    _phase: string,
  ): MCPToolDefinition[] {
    const isP1Turn = state.turn % 2 === 1;
    const isP1 = agentId === state.agent1Id;
    const isP2Turn = state.turn % 2 === 0;
    const isP2 = agentId === state.agent2Id;

    const tools: MCPToolDefinition[] = [];
    tools.push(...pickTools(state.toolDefinitions, ['get_board']));

    if ((isP1Turn && isP1) || (isP2Turn && isP2)) {
      tools.push(...pickTools(state.toolDefinitions, ['place_unit', 'move_unit']));
    }

    return tools;
  }

  validateAction(state: VectorGridWarsState, action: Action): ValidationResult {
    const isP1Turn = state.turn % 2 === 1;
    const currentPlayerId = isP1Turn ? state.agent1Id : state.agent2Id;

    if (action.tool === 'get_board') {
      return { valid: true };
    }

    if (state.gameOver || state.turn > state.maxTurns) {
      return { valid: false, error: 'Game is over' };
    }

    if (action.tool !== 'place_unit' && action.tool !== 'move_unit') {
      return { valid: false, error: 'Invalid tool' };
    }

    if (action.tool === 'place_unit') {
      const x = typeof action.args.x === 'number' ? action.args.x : -1;
      const y = typeof action.args.y === 'number' ? action.args.y : -1;
      const concept = typeof action.args.concept === 'string' ? action.args.concept : '';

      if (!this.inBounds(x, y, state.gridSize)) {
        return { valid: false, error: 'Target position out of bounds' };
      }
      if (typeof concept !== 'string' || concept.trim() === '') {
        return { valid: false, error: 'Invalid concept' };
      }
      if (concept.length > state.conceptMaxLength) {
        return { valid: false, error: 'Concept exceeds maximum length' };
      }
      const cell = state.grid[y]?.[x];
      if (!cell || cell.owner !== null) {
        return { valid: false, error: 'Target cell is already occupied or invalid' };
      }
      return { valid: true };
    }

    const fromX = typeof action.args.fromX === 'number' ? action.args.fromX : -1;
    const fromY = typeof action.args.fromY === 'number' ? action.args.fromY : -1;
    const toX = typeof action.args.toX === 'number' ? action.args.toX : -1;
    const toY = typeof action.args.toY === 'number' ? action.args.toY : -1;

    if (!this.inBounds(fromX, fromY, state.gridSize) || !this.inBounds(toX, toY, state.gridSize)) {
      return { valid: false, error: 'Position out of bounds' };
    }

    const sourceCell = state.grid[fromY]?.[fromX];
    if (!sourceCell || sourceCell.owner !== currentPlayerId) {
      return {
        valid: false,
        error: 'You do not own the unit at the source position or it is invalid',
      };
    }

    const targetCell = state.grid[toY]?.[toX];
    if (!targetCell || targetCell.owner !== null) {
      return { valid: false, error: 'Target cell is already occupied or invalid' };
    }

    const dx = Math.abs(toX - fromX);
    const dy = Math.abs(toY - fromY);
    if ((dx === 1 && dy === 0) || (dx === 0 && dy === 1)) {
      return { valid: true };
    }

    return {
      valid: false,
      error: 'Units can only move to adjacent cells (distance 1, no diagonal)',
    };
  }

  applyAction(state: VectorGridWarsState, action: Action): ApplyActionResult<VectorGridWarsState> {
    if (action.tool === 'get_board') {
      return {
        state,
        result: {
          grid: state.grid as unknown as JsonValue,
        },
      };
    }

    const nextState = this.cloneState(state);
    const isP1Turn = state.turn % 2 === 1;
    const currentPlayerId = isP1Turn ? state.agent1Id : state.agent2Id;
    let result: JsonValue = { status: 'ok' };

    if (action.tool === 'place_unit') {
      const x = typeof action.args.x === 'number' ? action.args.x : -1;
      const y = typeof action.args.y === 'number' ? action.args.y : -1;
      const concept = typeof action.args.concept === 'string' ? action.args.concept : '';

      const row = nextState.grid[y];
      if (row && row[x]) {
        row[x] = {
          owner: currentPlayerId,
          concept: concept.trim(),
        };
      }
      result = { status: 'placed', x, y, concept };
      nextState.turn += 1;
    } else if (action.tool === 'move_unit') {
      const fromX = typeof action.args.fromX === 'number' ? action.args.fromX : -1;
      const fromY = typeof action.args.fromY === 'number' ? action.args.fromY : -1;
      const toX = typeof action.args.toX === 'number' ? action.args.toX : -1;
      const toY = typeof action.args.toY === 'number' ? action.args.toY : -1;

      const sourceRow = nextState.grid[fromY];
      const targetRow = nextState.grid[toY];
      if (sourceRow && sourceRow[fromX] && targetRow && targetRow[toX]) {
        const unit = sourceRow[fromX];
        sourceRow[fromX] = { owner: null, concept: null };
        targetRow[toX] = { ...unit } as Cell;
      }
      result = { status: 'moved', fromX, fromY, toX, toY };
      nextState.turn += 1;
    }

    return { state: nextState, result };
  }

  async checkTermination(state: VectorGridWarsState): Promise<TerminationResult | null> {
    if (state.terminationResult) {
      return state.terminationResult;
    }

    if (state.turn > state.maxTurns) {
      const evalResult = await this.judge.evaluateBoard(state);

      const termination: TerminationResult = {
        ended: true,
      };

      if (evalResult.winner) {
        termination.winner = evalResult.winner;
      }

      if (evalResult.reason) {
        termination.reason = evalResult.reason;
      }

      state.gameOver = true;
      state.terminationResult = termination;

      return termination;
    }

    return null;
  }

  private inBounds(x: number, y: number, size: number): boolean {
    return x >= 0 && x < size && y >= 0 && y < size;
  }

  private cloneState(state: VectorGridWarsState): VectorGridWarsState {
    return {
      ...state,
      toolDefinitions: [...state.toolDefinitions],
      grid: state.grid.map((row) => row.map((cell) => ({ ...cell }))),
    };
  }
}
