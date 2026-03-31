import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { createApp } from '../../../src/app.js';

vi.mock('firebase-admin/app', () => ({
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(),
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => ({})),
}));

const VALID_TOKEN = 'test-admin-token-secret';

async function buildApp() {
  const app = await createApp({
    internalTaskAuthToken: VALID_TOKEN,
  });
  return app;
}

describe('Admin routes – authentication', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /v1/admin/matches/:matchId/flag returns 401 when no auth header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/matches/match-abc/flag',
      payload: { reason: 'suspicious' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/admin/matches/:matchId/flag returns 401 for wrong token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/matches/match-abc/flag',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { reason: 'suspicious' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/admin/matches/flagged returns 401 when no auth header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/matches/flagged',
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/admin/matches/:matchId/review returns 401 for wrong token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/matches/match-abc/review',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { status: 'reviewed' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Admin routes – flag endpoint', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /v1/admin/matches/:matchId/flag returns 200 and stores flag with valid token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/matches/match-xyz/flag',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      payload: { reason: 'anomalous speed detected' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; matchId: string };
    expect(body.status).toBe('ok');
    expect(body.matchId).toBe('match-xyz');
  });

  it('POST /v1/admin/matches/:matchId/flag returns 400 when reason is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/matches/match-xyz/flag',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('Admin routes – flagged list endpoint', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /v1/admin/matches/flagged returns 200 and list with valid token', async () => {
    // Flag a match first
    await app.inject({
      method: 'POST',
      url: '/v1/admin/matches/match-list-1/flag',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      payload: { reason: 'test flag' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/matches/flagged',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; flags: unknown[] };
    expect(body.status).toBe('ok');
    expect(Array.isArray(body.flags)).toBe(true);
  });
});

describe('Admin routes – review endpoint', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /v1/admin/matches/:matchId/review returns 404 when match not flagged', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/matches/nonexistent/review',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      payload: { status: 'reviewed', note: 'looked fine' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('POST /v1/admin/matches/:matchId/review returns 200 and updates flag', async () => {
    // Flag the match first
    await app.inject({
      method: 'POST',
      url: '/v1/admin/matches/match-review-1/flag',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      payload: { reason: 'review test' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/matches/match-review-1/review',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      payload: { status: 'cleared', note: 'false positive' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; flag: { reviewStatus: string } };
    expect(body.status).toBe('ok');
    expect(body.flag.reviewStatus).toBe('cleared');
  });

  it('POST /v1/admin/matches/:matchId/review returns 400 for invalid status', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/admin/matches/match-review-2/flag',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      payload: { reason: 'test' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/matches/match-review-2/review',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      payload: { status: 'invalid-status' },
    });

    expect(res.statusCode).toBe(400);
  });
});
