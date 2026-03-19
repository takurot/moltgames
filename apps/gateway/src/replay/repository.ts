import { getFirestore } from 'firebase-admin/firestore';
import { replayFirestoreConverter, type Replay } from '@moltgames/domain';

export interface ReplayRepository {
  getReplay(matchId: string): Promise<Replay | null>;
  saveReplay(replay: Replay): Promise<void>;
}

export class InMemoryReplayRepository implements ReplayRepository {
  private replays = new Map<string, Replay>();

  async getReplay(matchId: string): Promise<Replay | null> {
    return this.replays.get(matchId) ?? null;
  }

  async saveReplay(replay: Replay): Promise<void> {
    this.replays.set(replay.matchId, replay);
  }
}

export class FirestoreReplayRepository implements ReplayRepository {
  private db = getFirestore();

  async getReplay(matchId: string): Promise<Replay | null> {
    const doc = await this.db
      .collection('replays')
      .doc(matchId)
      .withConverter(replayFirestoreConverter)
      .get();

    return doc.exists ? (doc.data() ?? null) : null;
  }

  async saveReplay(replay: Replay): Promise<void> {
    await this.db
      .collection('replays')
      .doc(replay.matchId)
      .withConverter(replayFirestoreConverter)
      .set(replay);
  }
}
