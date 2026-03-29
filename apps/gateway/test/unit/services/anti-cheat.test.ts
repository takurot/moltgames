import { describe, expect, it, beforeEach } from 'vitest';

import {
  AnomalousSpeedDetector,
  SelfPlayDetector,
  computeEventHash,
  verifyEventChain,
} from '../../../src/services/anti-cheat.js';

// ---------------------------------------------------------------------------
// In-memory Redis mock
// ---------------------------------------------------------------------------

class MockRedis {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string, ..._args: unknown[]): Promise<'OK'> {
    this.data.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.data.delete(key)) count++;
    }
    return count;
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace('*', '');
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

// ---------------------------------------------------------------------------
// AnomalousSpeedDetector
// ---------------------------------------------------------------------------

describe('AnomalousSpeedDetector', () => {
  let redis: MockRedis;
  let detector: AnomalousSpeedDetector;

  beforeEach(() => {
    redis = new MockRedis();
    detector = new AnomalousSpeedDetector(redis as never);
  });

  it('does not flag actions separated by more than the threshold', async () => {
    const now = Date.now();

    // Simulate 3 actions each 200ms apart — above 100ms threshold
    await detector.checkAction('match-1', 'agent-1', 100, 3, now);
    await detector.checkAction('match-1', 'agent-1', 100, 3, now + 200);
    const result = await detector.checkAction('match-1', 'agent-1', 100, 3, now + 400);

    expect(result.flagged).toBe(false);
  });

  it('flags after consecutiveCount rapid actions (all < thresholdMs)', async () => {
    const now = Date.now();

    // 3 actions each 50ms apart — all below 100ms threshold
    await detector.checkAction('match-1', 'agent-1', 100, 3, now);
    await detector.checkAction('match-1', 'agent-1', 100, 3, now + 50);
    const result = await detector.checkAction('match-1', 'agent-1', 100, 3, now + 100);

    expect(result.flagged).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it('does not flag when under consecutiveCount rapid actions', async () => {
    const now = Date.now();

    // Only 2 rapid actions — needs 3 to flag
    await detector.checkAction('match-1', 'agent-1', 100, 3, now);
    const result = await detector.checkAction('match-1', 'agent-1', 100, 3, now + 50);

    expect(result.flagged).toBe(false);
  });

  it('resets detection after a slow action breaks the streak', async () => {
    const now = Date.now();

    // 2 rapid, then 1 slow, then 1 rapid — streak only reaches 2 after reset
    await detector.checkAction('match-1', 'agent-1', 100, 3, now);
    await detector.checkAction('match-1', 'agent-1', 100, 3, now + 50);
    await detector.checkAction('match-1', 'agent-1', 100, 3, now + 300); // slow resets streak to 1
    const result = await detector.checkAction('match-1', 'agent-1', 100, 3, now + 350); // streak=2

    expect(result.flagged).toBe(false);
  });

  it('clearMatch removes stored timestamps', async () => {
    const now = Date.now();

    await detector.checkAction('match-1', 'agent-1', 100, 3, now);
    await detector.clearMatch('match-1');

    // After clearing, streak resets — can't reach 3 consecutive with only 1 new action
    const result = await detector.checkAction('match-1', 'agent-1', 100, 3, now + 50);
    expect(result.flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SelfPlayDetector
// ---------------------------------------------------------------------------

describe('SelfPlayDetector', () => {
  let detector: SelfPlayDetector;

  beforeEach(() => {
    detector = new SelfPlayDetector();
  });

  it('allows a new participant when no active participants', () => {
    const result = detector.checkEnqueue('uid-1', '1.2.3.4', []);
    expect(result.blocked).toBe(false);
  });

  it('allows different uid and different ip', () => {
    const result = detector.checkEnqueue('uid-2', '5.6.7.8', [{ uid: 'uid-1', ip: '1.2.3.4' }]);
    expect(result.blocked).toBe(false);
  });

  it('does not block when IP information is missing for both participants', () => {
    const result = detector.checkEnqueue('uid-2', '', [{ uid: 'uid-1', ip: '' }]);
    expect(result.blocked).toBe(false);
  });

  it('blocks same uid', () => {
    const result = detector.checkEnqueue('uid-1', '5.6.7.8', [{ uid: 'uid-1', ip: '1.2.3.4' }]);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/uid/i);
  });

  it('blocks same ip', () => {
    const result = detector.checkEnqueue('uid-2', '1.2.3.4', [{ uid: 'uid-1', ip: '1.2.3.4' }]);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/ip/i);
  });

  it('blocks when both uid and ip match', () => {
    const result = detector.checkEnqueue('uid-1', '1.2.3.4', [{ uid: 'uid-1', ip: '1.2.3.4' }]);
    expect(result.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeEventHash / verifyEventChain
// ---------------------------------------------------------------------------

describe('computeEventHash', () => {
  it('returns a 64-character hex string (SHA-256)', () => {
    const hash = computeEventHash('0000', 'action-data');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const h1 = computeEventHash('prev', 'data');
    const h2 = computeEventHash('prev', 'data');
    expect(h1).toBe(h2);
  });

  it('changes when prevHash changes', () => {
    const h1 = computeEventHash('prev-a', 'data');
    const h2 = computeEventHash('prev-b', 'data');
    expect(h1).not.toBe(h2);
  });

  it('changes when actionData changes', () => {
    const h1 = computeEventHash('prev', 'data-a');
    const h2 = computeEventHash('prev', 'data-b');
    expect(h1).not.toBe(h2);
  });
});

describe('verifyEventChain', () => {
  it('returns valid=true for an empty chain', () => {
    expect(verifyEventChain([])).toEqual({ valid: true });
  });

  it('returns valid=true for a correctly hashed chain', () => {
    const h0 = computeEventHash(
      '0000000000000000000000000000000000000000000000000000000000000000',
      'action-0',
    );
    const h1 = computeEventHash(h0, 'action-1');
    const h2 = computeEventHash(h1, 'action-2');

    const events = [
      {
        hash: h0,
        actionData: 'action-0',
        prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
      },
      { hash: h1, actionData: 'action-1', prevHash: h0 },
      { hash: h2, actionData: 'action-2', prevHash: h1 },
    ];

    expect(verifyEventChain(events)).toEqual({ valid: true });
  });

  it('returns valid=false with firstInvalidIndex when a hash is tampered', () => {
    const h0 = computeEventHash(
      '0000000000000000000000000000000000000000000000000000000000000000',
      'action-0',
    );
    const h1 = computeEventHash(h0, 'action-1');

    const events = [
      {
        hash: h0,
        actionData: 'action-0',
        prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
      },
      {
        hash: 'tampered-hash',
        actionData: 'action-1',
        prevHash: h0,
      },
      {
        hash: computeEventHash('tampered-hash', 'action-2'),
        actionData: 'action-2',
        prevHash: 'tampered-hash',
      },
    ];

    const result = verifyEventChain(events);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidIndex).toBe(1);
  });

  it('detects tampered actionData', () => {
    const h0 = computeEventHash(
      '0000000000000000000000000000000000000000000000000000000000000000',
      'action-0',
    );
    const h1 = computeEventHash(h0, 'action-1');

    const events = [
      {
        hash: h0,
        actionData: 'action-0',
        prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
      },
      {
        // Hash was computed correctly but actionData was changed after the fact
        hash: h1,
        actionData: 'TAMPERED-action-1',
        prevHash: h0,
      },
    ];

    const result = verifyEventChain(events);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidIndex).toBe(1);
  });

  it('detects broken prevHash linkage even if each hash is internally valid', () => {
    const h0 = computeEventHash(
      '0000000000000000000000000000000000000000000000000000000000000000',
      'action-0',
    );
    const detachedPrevHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const h1 = computeEventHash(detachedPrevHash, 'action-1');

    const events = [
      {
        hash: h0,
        actionData: 'action-0',
        prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
      },
      {
        hash: h1,
        actionData: 'action-1',
        prevHash: detachedPrevHash,
      },
    ];

    const result = verifyEventChain(events);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidIndex).toBe(1);
  });
});
