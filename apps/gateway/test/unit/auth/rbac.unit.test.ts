import { describe, expect, it } from 'vitest';

import {
  extractRolesFromCustomClaims,
  hasAnyRole,
  hasRole,
  isGatewayRole,
} from '../../../src/auth/rbac.js';

describe('RBAC helpers', () => {
  it('extracts known roles from firebase custom claims', () => {
    const roles = extractRolesFromCustomClaims({
      roles: ['player', 'admin', 'unknown-role'],
    });

    expect(roles).toEqual(['player', 'admin']);
  });

  it('returns an empty role set when claims are malformed', () => {
    expect(extractRolesFromCustomClaims({ roles: 'admin' })).toEqual([]);
    expect(extractRolesFromCustomClaims({})).toEqual([]);
  });

  it('checks role membership', () => {
    expect(isGatewayRole('admin')).toBe(true);
    expect(isGatewayRole('viewer')).toBe(false);
    expect(hasRole(['admin'], 'admin')).toBe(true);
    expect(hasRole(['player'], 'admin')).toBe(false);
    expect(hasAnyRole(['player'], ['moderator', 'player'])).toBe(true);
    expect(hasAnyRole(['player'], ['moderator', 'admin'])).toBe(false);
  });
});
