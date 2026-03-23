import { describe, expect, it } from 'vitest';

import type { Match } from '@moltgames/domain';
import { InMemoryMatchRepository } from '../../../src/match/repository.js';

const makeMatch = (overrides: Partial<Match> = {}): Match => ({
  matchId: 'match-001',
  gameId: 'prompt-injection-arena',
  status: 'WAITING_AGENT_CONNECT',
  participants: [{ uid: 'user-1', agentId: 'agent-1', role: 'PLAYER' }],
  ruleId: 'prompt-injection-arena',
  ruleVersion: '1.0.0',
  region: 'us-central1',
  ...overrides,
});

describe('InMemoryMatchRepository', () => {
  it('returns null for unknown matchId', async () => {
    const repo = new InMemoryMatchRepository();
    expect(await repo.get('unknown')).toBeNull();
  });

  it('saves and retrieves a match', async () => {
    const repo = new InMemoryMatchRepository();
    const match = makeMatch();
    await repo.save(match);
    expect(await repo.get('match-001')).toEqual(match);
  });

  it('overwrites on repeated save', async () => {
    const repo = new InMemoryMatchRepository();
    await repo.save(makeMatch({ status: 'WAITING_AGENT_CONNECT' }));
    await repo.save(makeMatch({ status: 'IN_PROGRESS' }));
    expect((await repo.get('match-001'))?.status).toBe('IN_PROGRESS');
  });

  it('updateStatus changes status field', async () => {
    const repo = new InMemoryMatchRepository();
    await repo.save(makeMatch({ status: 'WAITING_AGENT_CONNECT' }));
    await repo.updateStatus('match-001', 'IN_PROGRESS');
    expect((await repo.get('match-001'))?.status).toBe('IN_PROGRESS');
  });

  it('updateStatus with startedAt sets the field', async () => {
    const repo = new InMemoryMatchRepository();
    await repo.save(makeMatch());
    const startedAt = '2026-03-21T00:00:00.000Z';
    await repo.updateStatus('match-001', 'IN_PROGRESS', { startedAt });
    const saved = await repo.get('match-001');
    expect(saved?.startedAt).toBe(startedAt);
    expect(saved?.status).toBe('IN_PROGRESS');
  });

  it('updateStatus with endedAt sets the field', async () => {
    const repo = new InMemoryMatchRepository();
    await repo.save(makeMatch({ status: 'IN_PROGRESS' }));
    const endedAt = '2026-03-21T01:00:00.000Z';
    await repo.updateStatus('match-001', 'FINISHED', { endedAt });
    const saved = await repo.get('match-001');
    expect(saved?.endedAt).toBe(endedAt);
    expect(saved?.status).toBe('FINISHED');
  });

  it('updateStatus is a no-op for unknown matchId', async () => {
    const repo = new InMemoryMatchRepository();
    await expect(repo.updateStatus('unknown', 'IN_PROGRESS')).resolves.not.toThrow();
  });
});
