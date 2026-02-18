import { describe, expect, it } from 'vitest';

import { getGatewayBootstrapInfo } from '../../src/index.js';

describe('gateway bootstrap', () => {
  it('returns service metadata', () => {
    expect(getGatewayBootstrapInfo().service).toBe('@moltgames/gateway');
  });
});
