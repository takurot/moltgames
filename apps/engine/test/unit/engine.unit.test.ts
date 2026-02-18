import { describe, expect, it } from 'vitest';

import { getEngineBootstrapInfo } from '../../src/index.js';

describe('engine bootstrap', () => {
  it('returns service metadata', () => {
    expect(getEngineBootstrapInfo().service).toBe('@moltgames/engine');
  });
});
