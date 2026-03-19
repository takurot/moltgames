import { gzipSync } from 'node:zlib';
import type { TurnEvent } from '@moltgames/domain';
import type { Replay } from '@moltgames/domain';
import { applyRedaction, REDACTION_VERSION } from './redaction.js';
import type { ReplayRepository } from './repository.js';
import type { ReplayStorage } from './storage.js';

const SIGNED_URL_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

const getSeasonId = (endedAt: string): string => {
  const date = new Date(endedAt);
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${year}-q${quarter}`;
};

const buildStoragePath = (matchId: string, seasonId: string): string =>
  `replays/${seasonId}/${matchId}.jsonl.gz`;

const toJsonl = (events: TurnEvent[]): string =>
  events.map((event) => JSON.stringify(event)).join('\n');

export interface ReplayServiceOptions {
  repository: ReplayRepository;
  storage: ReplayStorage;
}

export class ReplayService {
  private repository: ReplayRepository;
  private storage: ReplayStorage;

  constructor(options: ReplayServiceOptions) {
    this.repository = options.repository;
    this.storage = options.storage;
  }

  async generateAndStore(
    matchId: string,
    gameId: string,
    events: readonly TurnEvent[],
    endedAt: string,
  ): Promise<Replay> {
    if (gameId.trim().length === 0 || gameId === 'unknown') {
      throw new Error('Replay generation requires a known gameId');
    }

    const seasonId = getSeasonId(endedAt);
    const storagePath = buildStoragePath(matchId, seasonId);

    const redacted = applyRedaction(events, gameId);
    const jsonl = toJsonl(redacted);
    const compressed = gzipSync(Buffer.from(jsonl, 'utf8'));

    await this.storage.upload(storagePath, compressed);

    const replay: Replay = {
      matchId,
      storagePath,
      visibility: 'PUBLIC',
      redactionVersion: REDACTION_VERSION,
    };

    await this.repository.saveReplay(replay);

    return replay;
  }

  async getSignedDownloadUrl(matchId: string): Promise<string> {
    const replay = await this.repository.getReplay(matchId);
    if (!replay) {
      throw new Error(`Replay not found for match: ${matchId}`);
    }

    return this.storage.getSignedUrl(replay.storagePath, SIGNED_URL_EXPIRY_MS);
  }
}
