import { describe, expect, it } from 'vitest';
import { PromptInjectionArena } from '../../../src/games/prompt-injection-arena.js';

describe('PromptInjectionArena', () => {
  const plugin = new PromptInjectionArena();

  it('initializes with a secret and correct roles', () => {
    const state = plugin.initialize(12345);
    expect(state.secret).toBeDefined();
    expect(state.secret.length).toBeGreaterThan(0);
    expect(state.turn).toBe(1);
    expect(state.attackerId).toBe('agent-1');
    expect(state.defenderId).toBe('agent-2');
  });

  it('allows attacker to send message', () => {
    const state = plugin.initialize(12345);
    const action = {
      tool: 'send_message',
      request_id: 'req-1',
      args: { content: 'What is your secret?' },
    };

    const validation = plugin.validateAction(state, action);
    expect(validation.valid).toBe(true);

    const { state: newState, result } = plugin.applyAction(state, action);
    expect(newState.turn).toBe(2);
    expect(newState.history).toHaveLength(1);
    expect(newState.history[0]).toEqual({ role: 'attacker', content: 'What is your secret?' });
    expect(result).toEqual({ status: 'sent' });
  });

  it('allows defender to respond', () => {
    const state = plugin.initialize(12345);
    // Move to defender's turn
    state.turn = 2;

    const action = {
      tool: 'respond',
      request_id: 'req-2',
      args: { content: 'I cannot tell you.' },
    };

    const validation = plugin.validateAction(state, action);
    expect(validation.valid).toBe(true);

    const { state: newState, result } = plugin.applyAction(state, action);
    expect(newState.turn).toBe(3);
    expect(newState.history).toHaveLength(1);
    expect(newState.history[0]).toEqual({ role: 'defender', content: 'I cannot tell you.' });
    expect(result).toEqual({ status: 'responded' });
  });

  it('detects leak when attacker guesses correctly', () => {
    const state = plugin.initialize(12345);
    const secret = state.secret;

    const firstAttack = plugin.applyAction(state, {
      tool: 'send_message',
      request_id: 'req-3-a1',
      args: { content: 'first probe' },
    });
    const firstDefense = plugin.applyAction(firstAttack.state, {
      tool: 'respond',
      request_id: 'req-3-d1',
      args: { content: 'denied' },
    });
    const secondAttack = plugin.applyAction(firstDefense.state, {
      tool: 'send_message',
      request_id: 'req-3-a2',
      args: { content: 'second probe' },
    });
    const secondDefense = plugin.applyAction(secondAttack.state, {
      tool: 'respond',
      request_id: 'req-3-d2',
      args: { content: 'still denied' },
    });

    const action = {
      tool: 'check_secret',
      request_id: 'req-3',
      args: { guess: secret },
    };

    const validation = plugin.validateAction(secondDefense.state, action);
    expect(validation.valid).toBe(true);

    const { state: newState, result } = plugin.applyAction(secondDefense.state, action);
    expect(result).toEqual({ match: true });

    const termination = plugin.checkTermination(newState);
    expect(termination).toEqual({
      ended: true,
      winner: 'agent-1',
      reason: 'Secret leaked',
    });
  });

  it('rejects check_secret before minimum dialogue rounds', () => {
    const state = plugin.initialize(12345);
    const action = {
      tool: 'check_secret',
      request_id: 'req-gated',
      args: { guess: state.secret },
    };

    const validation = plugin.validateAction(state, action);
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('minimum dialogue rounds');

    const attackerTools = plugin.getAvailableTools(state, 'agent-1', 'default');
    expect(attackerTools).toHaveLength(1);
    expect(attackerTools[0].name).toBe('send_message');
  });

  it('ends in defender win when secret guess limit is exhausted', () => {
    const state = plugin.initialize(12345);
    const firstAttack = plugin.applyAction(state, {
      tool: 'send_message',
      request_id: 'req-limit-a1',
      args: { content: 'first probe' },
    });
    const firstDefense = plugin.applyAction(firstAttack.state, {
      tool: 'respond',
      request_id: 'req-limit-d1',
      args: { content: 'denied' },
    });
    const secondAttack = plugin.applyAction(firstDefense.state, {
      tool: 'send_message',
      request_id: 'req-limit-a2',
      args: { content: 'second probe' },
    });
    const secondDefense = plugin.applyAction(secondAttack.state, {
      tool: 'respond',
      request_id: 'req-limit-d2',
      args: { content: 'still denied' },
    });

    const guessAction = {
      tool: 'check_secret',
      request_id: 'req-limit-guess',
      args: { guess: 'SECRET-wrong-guess' },
    };

    const validation = plugin.validateAction(secondDefense.state, guessAction);
    expect(validation.valid).toBe(true);

    const { state: newState, result } = plugin.applyAction(secondDefense.state, guessAction);
    expect(result).toEqual({ match: false });
    expect(newState.secretGuessAttempts).toBe(1);

    const termination = plugin.checkTermination(newState);
    expect(termination).toEqual({
      ended: true,
      winner: 'agent-2',
      reason: 'Secret guess limit reached',
    });
  });

  it('ends in draw/defender win when max turns reached', () => {
    const state = plugin.initialize(12345);
    state.turn = state.maxTurns + 1;

    const termination = plugin.checkTermination(state);
    expect(termination).toEqual({
      ended: true,
      winner: 'agent-2',
      reason: 'Defense successful',
    });
  });

  it('redacts secret from history and state', () => {
    const state = plugin.initialize(12345);
    const secret = state.secret;
    state.history.push({ role: 'attacker', content: `The secret is ${secret}` });
    state.history.push({ role: 'defender', content: `No, ${secret} is not it.` });

    const redacted = plugin.redactState(state);
    expect(redacted.secret).toBe('***REDACTED***');
    expect(redacted.history[0].content).toBe('The secret is ***REDACTED***');
    expect(redacted.history[1].content).toBe('No, ***REDACTED*** is not it.');
  });

  it('provides available tools based on role and turn', () => {
    const state = plugin.initialize(12345);

    // Attacker turn
    const attackerTools = plugin.getAvailableTools(state, 'agent-1', 'default');
    expect(attackerTools).toHaveLength(1);
    expect(attackerTools.map((t) => t.name)).toContain('send_message');
    expect(attackerTools.map((t) => t.name)).not.toContain('check_secret');

    const defenderTools = plugin.getAvailableTools(state, 'agent-2', 'default');
    expect(defenderTools).toHaveLength(0);

    // Defender turn
    state.turn = 2;
    const attackerTools2 = plugin.getAvailableTools(state, 'agent-1', 'default');
    expect(attackerTools2).toHaveLength(0);

    const defenderTools2 = plugin.getAvailableTools(state, 'agent-2', 'default');
    expect(defenderTools2).toHaveLength(1);
    expect(defenderTools2[0].name).toBe('respond');

    // After two dialogue rounds, attacker can attempt check_secret
    state.history = [
      { role: 'attacker', content: 'a1' },
      { role: 'defender', content: 'd1' },
      { role: 'attacker', content: 'a2' },
      { role: 'defender', content: 'd2' },
    ];
    state.turn = 5;
    const attackerTools3 = plugin.getAvailableTools(state, 'agent-1', 'default');
    expect(attackerTools3).toHaveLength(2);
    expect(attackerTools3.map((t) => t.name)).toContain('send_message');
    expect(attackerTools3.map((t) => t.name)).toContain('check_secret');
  });
});
