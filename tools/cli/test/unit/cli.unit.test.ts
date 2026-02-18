import { describe, expect, it } from 'vitest';

import { getCliBootstrapInfo } from '../../src/index.js';

describe('cli bootstrap', () => {
  it('returns cli metadata', () => {
    expect(getCliBootstrapInfo().cli).toBe('@moltgames/cli');
  });
});
