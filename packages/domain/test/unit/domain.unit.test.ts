import { describe, expect, it } from 'vitest';

import { DOMAIN_PACKAGE_NAME } from '../../src/index.js';

describe('domain package', () => {
  it('exports package identifier', () => {
    expect(DOMAIN_PACKAGE_NAME).toBe('@moltgames/domain');
  });
});
