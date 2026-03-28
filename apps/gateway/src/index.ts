export const GATEWAY_SERVICE_NAME = '@moltgames/gateway';

export const getGatewayBootstrapInfo = () => ({
  service: GATEWAY_SERVICE_NAME,
  runtime: 'node',
});

export * from './auth/connect-token.js';
export * from './auth/device-flow.js';
export * from './auth/firebase-auth.js';
export * from './auth/rbac.js';
export * from './auth/token-api.js';
export * from './matchmaking/queue-service.js';
export * from './notifications/match-lifecycle-webhooks.js';
export * from './spectator/latency-recorder.js';
