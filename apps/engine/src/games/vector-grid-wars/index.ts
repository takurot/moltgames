import {
    type Action,
    type ApplyActionResult,
    type GamePlugin,
    type TerminationResult,
    type ValidationResult,
} from '../../framework/types.js';
import type { MCPToolDefinition } from '@moltgames/mcp-protocol';
import type { JsonValue } from '@moltgames/domain';
import { LLMJudge } from './judge.js';

export interface Cell {
    owner: string | null;
    concept: string | null;
}

export interface VectorGridWarsState {
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

    initialize(_seed: number): VectorGridWarsState {
        const grid: Cell[][] = Array.from({ length: 10 }, () =>
            Array.from({ length: 10 }, () => ({ owner: null, concept: null }))
        );

        return {
            grid,
            agent1Id: 'agent-1',
            agent2Id: 'agent-2',
            turn: 1,
            maxTurns: 30, // 15 moves per player
            gameOver: false,
            terminationResult: null
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

        // Always allow getting the board state
        tools.push({
            name: 'get_board',
            description: 'Get the current state of the 10x10 board containing owners and concepts',
            version: '1.0.0',
            inputSchema: {
                type: 'object',
                properties: {},
                required: [],
            },
        });

        if ((isP1Turn && isP1) || (isP2Turn && isP2)) {
            tools.push({
                name: 'place_unit',
                description: 'Place a new unit on an empty cell with a semantic concept (e.g., "Fire Wall", "Defense Tower")',
                version: '1.0.0',
                inputSchema: {
                    type: 'object',
                    properties: {
                        x: { type: 'integer', minimum: 0, maximum: 9 },
                        y: { type: 'integer', minimum: 0, maximum: 9 },
                        concept: { type: 'string', minLength: 1, maxLength: 50 },
                    },
                    required: ['x', 'y', 'concept'],
                },
            });

            tools.push({
                name: 'move_unit',
                description: 'Move an existing unit you own to an adjacent empty cell (horizontal or vertical, distance 1)',
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
                },
            });
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

            if (!this.inBounds(x, y)) {
                return { valid: false, error: 'Target position out of bounds' };
            }
            if (typeof concept !== 'string' || concept.trim() === '') {
                return { valid: false, error: 'Invalid concept' };
            }
            const cell = state.grid[y]?.[x];
            if (!cell || cell.owner !== null) {
                return { valid: false, error: 'Target cell is already occupied or invalid' };
            }
            return { valid: true };
        }

        if (action.tool === 'move_unit') {
            const fromX = typeof action.args.fromX === 'number' ? action.args.fromX : -1;
            const fromY = typeof action.args.fromY === 'number' ? action.args.fromY : -1;
            const toX = typeof action.args.toX === 'number' ? action.args.toX : -1;
            const toY = typeof action.args.toY === 'number' ? action.args.toY : -1;

            if (!this.inBounds(fromX, fromY) || !this.inBounds(toX, toY)) {
                return { valid: false, error: 'Position out of bounds' };
            }

            const sourceCell = state.grid[fromY]?.[fromX];
            if (!sourceCell || sourceCell.owner !== currentPlayerId) {
                return { valid: false, error: 'You do not own the unit at the source position or it is invalid' };
            }

            const targetCell = state.grid[toY]?.[toX];
            if (!targetCell || targetCell.owner !== null) {
                return { valid: false, error: 'Target cell is already occupied or invalid' };
            }

            const dx = Math.abs(toX - fromX);
            const dy = Math.abs(toY - fromY);
            if ((dx === 1 && dy === 0) || (dx === 0 && dy === 1)) {
                return { valid: true };
            } else {
                return { valid: false, error: 'Units can only move to adjacent cells (distance 1, no diagonal)' };
            }
        }

        return { valid: false, error: 'Unknown validation failure' };
    }

    applyAction(
        state: VectorGridWarsState,
        action: Action,
    ): ApplyActionResult<VectorGridWarsState> {
        if (action.tool === 'get_board') {
            // get_board does not consume a turn natively, but the engine protocol treats it as an action.
            // So we will just return the board and NOT increment the turn.
            // Wait, processAction increments turn ? No, engine does plugin.getTurn(newState).
            // If we don't increment turn, get_board is a free action but consumes an action API call.
            // Let's implement it as a free action (turn doesn't advance).
            return {
                state,
                result: {
                    grid: state.grid as unknown as JsonValue
                }
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
                    concept: concept.trim()
                };
            }
            result = { status: 'placed', x, y, concept };
            nextState.turn++;
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
            nextState.turn++;
        }

        return { state: nextState, result };
    }

    async checkTermination(state: VectorGridWarsState): Promise<TerminationResult | null> {
        if (state.terminationResult) {
            return state.terminationResult;
        }

        if (state.turn > state.maxTurns) {
            // Evaluate board using LLMJudge
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

            // Mutate state so the engine persists the termination result and avoids repeated LLM calls
            state.gameOver = true;
            state.terminationResult = termination;

            return termination;
        }

        return null;
    }

    private inBounds(x: number, y: number): boolean {
        return x >= 0 && x < 10 && y >= 0 && y < 10;
    }

    private cloneState(state: VectorGridWarsState): VectorGridWarsState {
        return {
            ...state,
            grid: state.grid.map(row => row.map(cell => ({ ...cell }))),
        };
    }
}
