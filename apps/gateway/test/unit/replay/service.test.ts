import { describe, expect, it } from 'vitest';
import type { TurnEvent } from '@moltgames/domain';
import { ReplayService } from '../../../src/replay/service.js';
import { InMemoryReplayRepository } from '../../../src/replay/repository.js';
import { InMemoryReplayStorage } from '../../../src/replay/storage.js';

const makeTurnEvent = (overrides: Partial<TurnEvent> = {}): TurnEvent => ({
  eventId: 'evt-1',
  matchId: 'match-1',
  turn: 1,
  actor: 'agent-attacker',
  action: { tool: 'send_message', args: { content: 'hello' } },
  result: { content: 'reply' },
  latencyMs: 100,
  timestamp: '2026-03-19T00:00:00.000Z',
  ...overrides,
});

describe('ReplayService', () => {
  const makeService = () => {
    const repository = new InMemoryReplayRepository();
    const storage = new InMemoryReplayStorage();
    const service = new ReplayService({ repository, storage });
    return { service, repository, storage };
  };

  describe('generateAndStore', () => {
    it('stores replay metadata in repository', async () => {
      const { service, repository } = makeService();
      const events = [makeTurnEvent()];

      await service.generateAndStore(
        'match-1',
        'prompt-injection-arena',
        events,
        '2026-03-19T00:00:00.000Z',
      );

      const replay = await repository.getReplay('match-1');
      expect(replay).not.toBeNull();
      expect(replay?.matchId).toBe('match-1');
      expect(replay?.visibility).toBe('PUBLIC');
      expect(replay?.redactionVersion).toBeTruthy();
      expect(replay?.storagePath).toMatch(/\.jsonl\.gz$/);
    });

    it('uploads compressed JSONL to storage', async () => {
      const { service, storage } = makeService();
      const events = [
        makeTurnEvent({ eventId: 'evt-1', turn: 1 }),
        makeTurnEvent({ eventId: 'evt-2', turn: 2 }),
      ];

      await service.generateAndStore(
        'match-1',
        'vector-grid-wars',
        events,
        '2026-03-19T00:00:00.000Z',
      );

      const files = storage.listFiles();
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/match-1\.jsonl\.gz$/);
    });

    it('applies redaction for prompt-injection-arena', async () => {
      const { service, storage } = makeService();
      const events = [
        makeTurnEvent({
          result: { secret: 'top-secret-value', content: 'visible' },
        }),
      ];

      await service.generateAndStore(
        'match-1',
        'prompt-injection-arena',
        events,
        '2026-03-19T00:00:00.000Z',
      );

      const files = storage.listFiles();
      const data = storage.getFileData(files[0]);
      expect(data).not.toContain('top-secret-value');
      expect(data).toContain('REDACTED');
      expect(data).toContain('visible');
    });

    it('stores storage path in the format replays/{seasonId}/{matchId}.jsonl.gz', async () => {
      const { service, repository } = makeService();
      const events = [makeTurnEvent()];

      await service.generateAndStore(
        'match-abc',
        'prompt-injection-arena',
        events,
        '2026-03-19T10:00:00.000Z',
      );

      const replay = await repository.getReplay('match-abc');
      // Season derived from endedAt: 2026-Q1
      expect(replay?.storagePath).toBe('replays/2026-q1/match-abc.jsonl.gz');
    });

    it('generates valid JSONL where each line is a JSON TurnEvent', async () => {
      const { service, storage } = makeService();
      const events = [
        makeTurnEvent({ eventId: 'e1', turn: 1 }),
        makeTurnEvent({ eventId: 'e2', turn: 2 }),
      ];

      await service.generateAndStore(
        'match-1',
        'vector-grid-wars',
        events,
        '2026-03-19T00:00:00.000Z',
      );

      const files = storage.listFiles();
      const jsonlText = storage.getFileData(files[0]);
      const lines = jsonlText.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(() => JSON.parse(lines[0])).not.toThrow();
      expect(() => JSON.parse(lines[1])).not.toThrow();
      expect(JSON.parse(lines[0]).eventId).toBe('e1');
      expect(JSON.parse(lines[1]).eventId).toBe('e2');
    });
  });

  describe('getSignedDownloadUrl', () => {
    it('returns a URL for an existing public replay', async () => {
      const { service } = makeService();
      const events = [makeTurnEvent()];
      await service.generateAndStore(
        'match-1',
        'vector-grid-wars',
        events,
        '2026-03-19T00:00:00.000Z',
      );

      const url = await service.getSignedDownloadUrl('match-1');

      expect(typeof url).toBe('string');
      expect(url.length).toBeGreaterThan(0);
    });

    it('throws if replay does not exist', async () => {
      const { service } = makeService();

      await expect(service.getSignedDownloadUrl('nonexistent-match')).rejects.toThrow();
    });
  });
});
