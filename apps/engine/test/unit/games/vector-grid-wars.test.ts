import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VectorGridWars } from '../../../src/games/vector-grid-wars/index.js';

describe('VectorGridWars', () => {
    let plugin: VectorGridWars;

    beforeEach(() => {
        plugin = new VectorGridWars();
    });

    it('initializes an empty 10x10 grid', () => {
        const state = plugin.initialize(12345);
        expect(state.grid.length).toBe(10);
        expect(state.grid[0].length).toBe(10);
        expect(state.turn).toBe(1);
        expect(state.agent1Id).toBe('agent-1');
        expect(state.agent2Id).toBe('agent-2');
    });

    it('provides correct tools based on turn', () => {
        const state = plugin.initialize(12345);

        // Turn 1 (Agent 1)
        const a1Tools = plugin.getAvailableTools(state, 'agent-1', 'default');
        expect(a1Tools.map(t => t.name)).toEqual(expect.arrayContaining(['get_board', 'place_unit', 'move_unit']));

        // Agent 2 should only see get_board on Agent 1's turn
        const a2Tools = plugin.getAvailableTools(state, 'agent-2', 'default');
        expect(a2Tools.map(t => t.name)).toEqual(['get_board']);

        // Turn 2 (Agent 2)
        state.turn = 2;
        const a2ToolsTurn2 = plugin.getAvailableTools(state, 'agent-2', 'default');
        expect(a2ToolsTurn2.map(t => t.name)).toEqual(expect.arrayContaining(['get_board', 'place_unit', 'move_unit']));
    });

    it('allows placing a unit on an empty cell', () => {
        const state = plugin.initialize(12345);
        const action = {
            tool: 'place_unit',
            request_id: 'req-1',
            args: { x: 5, y: 5, concept: 'Sword' }
        };

        const validation = plugin.validateAction(state, action);
        expect(validation.valid).toBe(true);

        const { state: newState, result } = plugin.applyAction(state, action);
        expect(newState.grid[5][5].owner).toBe('agent-1');
        expect(newState.grid[5][5].concept).toBe('Sword');
        expect(newState.turn).toBe(2);
        expect(result).toEqual({ status: 'placed', x: 5, y: 5, concept: 'Sword' });
    });

    it('prevents placing unit out of bounds or on occupied cell', () => {
        const state = plugin.initialize(12345);
        state.grid[2][2] = { owner: 'agent-2', concept: 'Shield' };

        const oobAction = {
            tool: 'place_unit',
            request_id: 'req-2',
            args: { x: 10, y: 5, concept: 'Sword' }
        };
        expect(plugin.validateAction(state, oobAction).valid).toBe(false);

        const occupiedAction = {
            tool: 'place_unit',
            request_id: 'req-3',
            args: { x: 2, y: 2, concept: 'Sword' }
        };
        expect(plugin.validateAction(state, occupiedAction).valid).toBe(false);
    });

    it('allows moving a unit to an adjacent empty cell', () => {
        const state = plugin.initialize(12345);
        state.grid[2][2] = { owner: 'agent-1', concept: 'Sword' };

        const action = {
            tool: 'move_unit',
            request_id: 'req-4',
            args: { fromX: 2, fromY: 2, toX: 2, toY: 3 }
        };

        const validation = plugin.validateAction(state, action);
        expect(validation.valid).toBe(true);

        const { state: newState } = plugin.applyAction(state, action);
        expect(newState.grid[2][2].owner).toBeNull();
        expect(newState.grid[3][2].owner).toBe('agent-1');
        expect(newState.grid[3][2].concept).toBe('Sword');
    });

    it('prevents moving opponent unit or moving too far', () => {
        const state = plugin.initialize(12345);
        state.grid[2][2] = { owner: 'agent-2', concept: 'Shield' }; // Opponent's

        const stealAction = {
            tool: 'move_unit',
            request_id: 'req-5',
            args: { fromX: 2, fromY: 2, toX: 2, toY: 3 }
        };
        expect(plugin.validateAction(state, stealAction).valid).toBe(false);

        state.grid[5][5] = { owner: 'agent-1', concept: 'Sword' }; // Mine
        const farAction = {
            tool: 'move_unit',
            request_id: 'req-6',
            args: { fromX: 5, fromY: 5, toX: 7, toY: 5 } // distance 2
        };
        expect(plugin.validateAction(state, farAction).valid).toBe(false);
    });

    it('handles get_board as a free action without incrementing turn', () => {
        const state = plugin.initialize(12345);
        const action = {
            tool: 'get_board',
            request_id: 'req-7',
            args: {}
        };

        const { state: newState, result } = plugin.applyAction(state, action);
        expect(newState.turn).toBe(1); // Turn not incremented
        expect((result as any).grid).toBeDefined();
    });

    it('evaluates board via LLC Judge and terminates at max turns', async () => {
        const state = plugin.initialize(12345);
        state.turn = state.maxTurns + 1; // trigger termination

        // Mock LLMJudge inside the plugin
        const evaluateSpy = vi.spyOn(plugin['judge'], 'evaluateBoard').mockResolvedValue({
            agent1Score: 60,
            agent2Score: 40,
            winner: 'agent-1',
            reason: 'Agent 1 wins on technical territory control'
        });

        const termination = await plugin.checkTermination(state);

        expect(evaluateSpy).toHaveBeenCalledWith(state);
        expect(termination).toEqual({
            ended: true,
            winner: 'agent-1',
            reason: 'Agent 1 wins on technical territory control'
        });
    });
});
