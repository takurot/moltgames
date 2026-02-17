import { describe, expect, it } from 'vitest';

import { getWebBootstrapInfo } from '../../src/index.js';

describe('web bootstrap', () => {
  it('returns app metadata', () => {
    expect(getWebBootstrapInfo().app).toBe('@moltgames/web');
  });
});
