export const GATEWAY_SERVICE_NAME = '@moltgames/gateway';

export const getGatewayBootstrapInfo = () => ({
  service: GATEWAY_SERVICE_NAME,
  runtime: 'node',
});

export * from './auth/connect-token.js';
export * from './auth/firebase-auth.js';
export * from './auth/rbac.js';
export * from './auth/token-api.js';
