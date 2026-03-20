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
  actionLatencyMs: 100,
  timestamp: '2026-03-19T00:00:00.000Z',
  actionType: 'send_message',
  seat: 'first',
  ruleVersion: '1.0.0',
  phase: 'dialogue',
  scoreDiffBefore: 0,
  scoreDiffAfter: 0,
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

    it('rejects replay generation when gameId is unknown', async () => {
      const { service, repository, storage } = makeService();
      const events = [makeTurnEvent()];

      await expect(
        service.generateAndStore('match-unknown', 'unknown', events, '2026-03-19T10:00:00.000Z'),
      ).rejects.toThrow('known gameId');

      expect(await repository.getReplay('match-unknown')).toBeNull();
      expect(storage.listFiles()).toHaveLength(0);
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

    it('includes integrity fields in JSONL output', async () => {
      const { service, storage } = makeService();
      const events = [makeTurnEvent({ eventId: 'e1' })];

      await service.generateAndStore(
        'match-1',
        'vector-grid-wars',
        events,
        '2026-03-19T00:00:00.000Z',
      );

      const files = storage.listFiles();
      const jsonlText = storage.getFileData(files[0]);
      const parsed = JSON.parse(jsonlText.trim());
      expect(typeof parsed.isHiddenInfoRedacted).toBe('boolean');
      expect(typeof parsed.redactionVersion).toBe('string');
      expect(typeof parsed.eventHash).toBe('string');
      expect(parsed.eventHash.length).toBe(64);
    });

    it('includes analytics fields in JSONL output', async () => {
      const { service, storage } = makeService();
      const events = [
        makeTurnEvent({
          eventId: 'e1',
          actionType: 'place_unit',
          seat: 'second',
          ruleVersion: '2.0.0',
        }),
      ];

      await service.generateAndStore(
        'match-1',
        'vector-grid-wars',
        events,
        '2026-03-19T00:00:00.000Z',
      );

      const files = storage.listFiles();
      const jsonlText = storage.getFileData(files[0]);
      const parsed = JSON.parse(jsonlText.trim());
      expect(parsed.actionType).toBe('place_unit');
      expect(parsed.seat).toBe('second');
      expect(parsed.ruleVersion).toBe('2.0.0');
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

    it('rejects download URLs for private replays', async () => {
      const { service, repository, storage } = makeService();
      await storage.upload('replays/2026-q1/match-private.jsonl.gz', Buffer.from('payload'));
      await repository.saveReplay({
        matchId: 'match-private',
        storagePath: 'replays/2026-q1/match-private.jsonl.gz',
        visibility: 'PRIVATE',
        redactionVersion: 'v1',
      });

      await expect(service.getSignedDownloadUrl('match-private')).rejects.toThrow(
        'publicly accessible',
      );
    });

    it('throws if replay does not exist', async () => {
      const { service } = makeService();

      await expect(service.getSignedDownloadUrl('nonexistent-match')).rejects.toThrow();
    });
  });
});
