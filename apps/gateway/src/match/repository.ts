import { getFirestore } from 'firebase-admin/firestore';

import { matchFirestoreConverter, type Match, type MatchStatus } from '@moltgames/domain';

export interface MatchRepository {
  get(matchId: string): Promise<Match | null>;
  listByParticipant(uid: string, agentId?: string): Promise<Match[]>;
  save(match: Match): Promise<void>;
  updateStatus(
    matchId: string,
    status: MatchStatus,
    updates?: Partial<Pick<Match, 'startedAt' | 'endedAt'>>,
  ): Promise<void>;
}

export class InMemoryMatchRepository implements MatchRepository {
  private readonly store = new Map<string, Match>();

  async get(matchId: string): Promise<Match | null> {
    return this.store.get(matchId) ?? null;
  }

  async listByParticipant(uid: string, agentId?: string): Promise<Match[]> {
    return Array.from(this.store.values()).filter((match) =>
      match.participants.some(
        (participant) =>
          participant.uid === uid && (agentId === undefined || participant.agentId === agentId),
      ),
    );
  }

  async save(match: Match): Promise<void> {
    this.store.set(match.matchId, { ...match });
  }

  async updateStatus(
    matchId: string,
    status: MatchStatus,
    updates?: Partial<Pick<Match, 'startedAt' | 'endedAt'>>,
  ): Promise<void> {
    const existing = this.store.get(matchId);
    if (!existing) {
      return;
    }
    this.store.set(matchId, { ...existing, status, ...updates });
  }
}

export class FirestoreMatchRepository implements MatchRepository {
  private get db() {
    return getFirestore();
  }

  async get(matchId: string): Promise<Match | null> {
    const ref = this.db.collection('matches').doc(matchId).withConverter(matchFirestoreConverter);
    const snap = await ref.get();
    return snap.exists ? (snap.data() ?? null) : null;
  }

  async listByParticipant(uid: string, agentId?: string): Promise<Match[]> {
    const snapshot = await this.db
      .collection('matches')
      .where('participantUids', 'array-contains', uid)
      .get();

    return snapshot.docs
      .map((doc) => doc.data())
      .filter(
        (match): match is Match =>
          match !== undefined &&
          (agentId === undefined ||
            match.participants.some(
              (participant: Match['participants'][number]) =>
                participant.uid === uid && participant.agentId === agentId,
            )),
      );
  }

  async save(match: Match): Promise<void> {
    const ref = this.db
      .collection('matches')
      .doc(match.matchId)
      .withConverter(matchFirestoreConverter);
    await ref.set({
      ...match,
      participantUids: Array.from(
        new Set(match.participants.map((participant) => participant.uid)),
      ),
      participantAgentIds: Array.from(
        new Set(match.participants.map((participant) => participant.agentId)),
      ),
    } as Match);
  }

  async updateStatus(
    matchId: string,
    status: MatchStatus,
    updates?: Partial<Pick<Match, 'startedAt' | 'endedAt'>>,
  ): Promise<void> {
    const ref = this.db.collection('matches').doc(matchId).withConverter(matchFirestoreConverter);
    await ref.set({ status, ...updates } as Match, { merge: true });
  }
}
