import { isRecord } from '@moltgames/domain';

export const GATEWAY_ROLES = ['admin', 'moderator', 'player'] as const;

export type GatewayRole = (typeof GATEWAY_ROLES)[number];

const gatewayRoleSet: ReadonlySet<GatewayRole> = new Set(GATEWAY_ROLES);

export const isGatewayRole = (value: unknown): value is GatewayRole =>
  typeof value === 'string' && gatewayRoleSet.has(value as GatewayRole);

export const extractRolesFromCustomClaims = (customClaims: unknown): GatewayRole[] => {
  if (!isRecord(customClaims) || !Array.isArray(customClaims.roles)) {
    return [];
  }

  return customClaims.roles.filter((role): role is GatewayRole => isGatewayRole(role));
};

export const hasRole = (roles: readonly GatewayRole[], requiredRole: GatewayRole): boolean =>
  roles.includes(requiredRole);

export const hasAnyRole = (
  roles: readonly GatewayRole[],
  requiredRoles: readonly GatewayRole[],
): boolean => requiredRoles.some((requiredRole) => hasRole(roles, requiredRole));
