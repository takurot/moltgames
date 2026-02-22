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
    
    const action = {
      tool: 'check_secret',
      request_id: 'req-3',
      args: { guess: secret },
    };

    const validation = plugin.validateAction(state, action);
    expect(validation.valid).toBe(true);

    const { state: newState, result } = plugin.applyAction(state, action);
    expect(result).toEqual({ match: true });
    
    const termination = plugin.checkTermination(newState);
    expect(termination).toEqual({
      ended: true,
      winner: 'agent-1',
      reason: 'Secret leaked',
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

  it('provides available tools', () => {
    const state = plugin.initialize(12345);
    const tools = plugin.getAvailableTools(state, 'default');
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toContain('send_message');
    expect(tools.map((t) => t.name)).toContain('respond');
    expect(tools.map((t) => t.name)).toContain('check_secret');
  });
});
