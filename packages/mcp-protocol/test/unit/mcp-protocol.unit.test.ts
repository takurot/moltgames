import { describe, expect, it } from 'vitest';

import { getProtocolMetadata } from '../../src/index.js';

describe('mcp-protocol package', () => {
  it('resolves protocol metadata', () => {
    expect(getProtocolMetadata()).toEqual({
      protocolPackage: '@moltgames/mcp-protocol',
    });
  });
});
