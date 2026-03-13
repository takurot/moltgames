import { describe, it, expect, beforeEach } from 'vitest';
import type { LoadedGameRule } from '@moltgames/rules';

import { DilemmaPoker } from '../../../src/games/dilemma-poker/index.js';

describe('DilemmaPoker', () => {
  let plugin: DilemmaPoker;
  const agent1 = 'agent-1';
  const agent2 = 'agent-2';

  beforeEach(() => {
    plugin = new DilemmaPoker();
  });

  it('should initialize correctly', () => {
    const state = plugin.initialize(123);
    expect(state.phase).toBe('negotiation');
    expect(state.turn).toBe(1);
    expect(state.round).toBe(1);
    expect(state.negotiationPhaseMessagesPerRound).toBe(2);
    expect(state.players[agent1].chips).toBe(0);
    expect(state.players[agent2].chips).toBe(0);
  });

  it('should honor a custom negotiation phase length from the loaded rule', () => {
    const customRule: LoadedGameRule = {
      gameId: 'dilemma-poker',
      ruleId: 'long-negotiation',
      ruleVersion: '2.0.0',
      turnLimit: 18,
      turnTimeoutSeconds: 30,
      tools: [
        {
          name: 'get_status',
          description: 'Gets your current status, including chip count and current round.',
          version: '1.0.0',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'negotiate',
          description: 'Send a message to the opponent during the negotiation phase.',
          version: '1.0.0',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', minLength: 1, maxLength: 500 },
            },
            required: ['message'],
            additionalProperties: false,
          },
        },
        {
          name: 'commit_action',
          description: 'The final action to take for this round: cooperate or defect.',
          version: '1.0.0',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['cooperate', 'defect'],
              },
            },
            required: ['action'],
            additionalProperties: false,
          },
        },
      ],
      parameters: {
        initialChips: 0,
        maxRounds: 3,
        negotiationPhaseMessagesPerRound: 4,
      },
      termination: {
        type: 'dilemma-poker',
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

    let state = plugin.initialize(123, customRule);
    expect(state.negotiationPhaseMessagesPerRound).toBe(4);

    for (const [requestId, message] of [
      ['1', 'hello'],
      ['2', 'hi'],
      ['3', 'deal?'],
    ] as const) {
      state = plugin.applyAction(state, {
        tool: 'negotiate',
        request_id: requestId,
        args: { message },
      }).state;
      expect(state.phase).toBe('negotiation');
    }

    expect(
      plugin
        .getAvailableTools(state, agent2, 'negotiation')
        .some((tool) => tool.name === 'negotiate'),
    ).toBe(true);

    state = plugin.applyAction(state, {
      tool: 'negotiate',
      request_id: '4',
      args: { message: 'let us see' },
    }).state;

    expect(state.phase).toBe('action');
    expect(state.turn).toBe(5);
  });

  it('should manage turn order: agent1 -> agent2 -> agent1 -> agent2 correctly in round 1', () => {
    let state = plugin.initialize(123);

    // Turn 1: agent1
    let tools = plugin.getAvailableTools(state, agent1, 'negotiation');
    expect(tools.some((t) => t.name === 'negotiate')).toBe(true);
    expect(plugin.getAvailableTools(state, agent2, 'negotiation').length).toBe(0);

    const action1Result = plugin.applyAction(state, {
      tool: 'negotiate',
      request_id: '1',
      args: { message: 'hello' },
    });
    state = action1Result.state;
    expect(state.turn).toBe(2);

    // Turn 2: agent2
    expect(plugin.getAvailableTools(state, agent1, 'negotiation').length).toBe(0);
    tools = plugin.getAvailableTools(state, agent2, 'negotiation');
    expect(tools.some((t) => t.name === 'negotiate')).toBe(true);

    const action2Result = plugin.applyAction(state, {
      tool: 'negotiate',
      request_id: '2',
      args: { message: 'hi' },
    });
    state = action2Result.state;

    // Switch to action phase Let's check
    expect(state.phase).toBe('action');
    expect(state.turn).toBe(3);

    // Turn 3: agent1 acts
    tools = plugin.getAvailableTools(state, agent1, 'action');
    expect(tools.some((t) => t.name === 'commit_action')).toBe(true);

    const action3Result = plugin.applyAction(state, {
      tool: 'commit_action',
      request_id: '3',
      args: { action: 'cooperate' },
    });
    state = action3Result.state;

    // Turn 4: agent2 acts
    tools = plugin.getAvailableTools(state, agent2, 'action');
    expect(tools.some((t) => t.name === 'commit_action')).toBe(true);

    const action4Result = plugin.applyAction(state, {
      tool: 'commit_action',
      request_id: '4',
      args: { action: 'defect' },
    });
    state = action4Result.state;

    // Switch to next round
    expect(state.round).toBe(2);
    expect(state.phase).toBe('negotiation');

    // Check chips
    // agent1 cooperated, agent2 defected.
    // agent1 gains 0, agent2 gains 5
    expect(state.players[agent1].chips).toBe(0);
    expect(state.players[agent2].chips).toBe(5);

    // Confirm history is updated
    expect(state.history.length).toBe(1);
    expect(state.history[0].actions['agent-1']).toBe('cooperate');
    expect(state.history[0].actions['agent-2']).toBe('defect');
  });

  it('should alternate starting agent based on round number', () => {
    let state = plugin.initialize(123);
    // Fast forward to turn 5 (start of round 2)
    state.round = 2;
    state.turn = 5;
    state.phase = 'negotiation';

    // Round 2 start should be agent2
    let tools = plugin.getAvailableTools(state, agent2, 'negotiation');
    expect(tools.some((t) => t.name === 'negotiate')).toBe(true);
    expect(plugin.getAvailableTools(state, agent1, 'negotiation').length).toBe(0);
  });

  it('should check termination round correctly', () => {
    let state = plugin.initialize(123);
    state.round = 6;
    state.turn = 21;
    state.players[agent1].chips = 10;
    state.players[agent2].chips = 5;

    const term = plugin.checkTermination(state);
    expect(term).not.toBeNull();
    expect(term?.ended).toBe(true);
    expect(term?.winner).toBe(agent1);
    expect(term?.reason).toBe('Max rounds reached');
  });

  it('should handle draw when chips are equal', () => {
    let state = plugin.initialize(123);
    state.round = 6;
    state.turn = 21;
    state.players[agent1].chips = 10;
    state.players[agent2].chips = 10;

    const term = plugin.checkTermination(state);
    expect(term).not.toBeNull();
    expect(term?.ended).toBe(true);
    expect(term?.winner).toBeUndefined(); // draw
  });

  it('should properly redact state during action phase', () => {
    let state = plugin.initialize(123);
    state.phase = 'action';
    state.actionsThisRound[agent1] = 'cooperate';

    const redacted = plugin.redactState?.(state) ?? state;

    expect(redacted.actionsThisRound[agent1]).toBeNull();
    expect(redacted.actionsThisRound[agent2]).toBeNull();

    // Just to be sure, in negotiation phase it doesn't really matter for currentRound since they are reset anyway,
    // but we can check if it leaves history alone.
    expect(redacted.history).toEqual(state.history);
  });

  it('should not consume turn when get_status is called', () => {
    let state = plugin.initialize(123);

    const statusResult = plugin.applyAction(state, {
      tool: 'get_status',
      request_id: 'status-1',
      args: {},
    });
    state = statusResult.state;

    expect(state.turn).toBe(1);
    expect(state.phase).toBe('negotiation');
    expect(
      plugin.getAvailableTools(state, agent1, 'negotiation').some((t) => t.name === 'negotiate'),
    ).toBe(true);
    expect(plugin.getAvailableTools(state, agent2, 'negotiation').length).toBe(0);
  });

  it('should validate action args', () => {
    let state = plugin.initialize(123);

    const invalidNegotiate = plugin.validateAction(state, {
      tool: 'negotiate',
      request_id: 'v-1',
      args: { message: '' },
    });
    expect(invalidNegotiate.valid).toBe(false);

    state.phase = 'action';
    const invalidCommit = plugin.validateAction(state, {
      tool: 'commit_action',
      request_id: 'v-2',
      args: { action: 'all-in' },
    });
    expect(invalidCommit.valid).toBe(false);
  });
});
