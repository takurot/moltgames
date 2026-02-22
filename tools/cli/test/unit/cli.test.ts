import { describe, expect, it } from 'vitest';
import { Client } from '../../src/client.js';

describe('CLI Client', () => {
  it('initializes with correct options', () => {
    const client = new Client({
      url: 'ws://localhost:8080/v1/ws',
      token: 'test-token',
    });
    expect(client).toBeDefined();
    expect(client.getAvailableTools()).toEqual([]);
  });
});
