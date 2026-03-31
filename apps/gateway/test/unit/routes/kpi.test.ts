import { describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { KpiSnapshot } from '@moltgames/domain';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildApp = async () => {
  process.env.NODE_ENV = 'test';
  return createApp();
};

// ---------------------------------------------------------------------------
// GET /v1/kpi/summary
// ---------------------------------------------------------------------------

describe('GET /v1/kpi/summary', () => {
  it('returns 200 with an array of KpiSnapshot objects', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/kpi/summary?gameId=prompt-injection-arena&days=7',
    });

    expect(res.statusCode).toBe(200);

    const body = res.json<{ status: string; snapshots: KpiSnapshot[] }>();
    expect(body.status).toBe('ok');
    expect(Array.isArray(body.snapshots)).toBe(true);

    await app.close();
  });

  it('returns 400 when days is not a positive integer', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/kpi/summary?gameId=prompt-injection-arena&days=abc',
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when days is zero', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/kpi/summary?gameId=prompt-injection-arena&days=0',
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('accepts optional ruleVersion query param', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/kpi/summary?gameId=prompt-injection-arena&days=7&ruleVersion=1.0.0',
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/kpi/diff
// ---------------------------------------------------------------------------

describe('GET /v1/kpi/diff', () => {
  it('returns 200 with a KpiDiff object', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/kpi/diff?gameId=prompt-injection-arena&ruleVersionA=1.0.0&ruleVersionB=1.1.0',
    });

    expect(res.statusCode).toBe(200);

    const body = res.json<{ status: string; diff: unknown }>();
    expect(body.status).toBe('ok');
    expect(body.diff).toBeDefined();

    await app.close();
  });

  it('returns 400 when gameId is missing', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/kpi/diff?ruleVersionA=1.0.0&ruleVersionB=1.1.0',
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when ruleVersionA is missing', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/kpi/diff?gameId=prompt-injection-arena&ruleVersionB=1.1.0',
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when ruleVersionB is missing', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/kpi/diff?gameId=prompt-injection-arena&ruleVersionA=1.0.0',
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
