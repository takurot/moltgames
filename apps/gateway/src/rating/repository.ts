import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  leaderboardFirestoreConverter,
  ratingFirestoreConverter,
  seasonFirestoreConverter,
  type Leaderboard,
  type Rating,
  type Season,
} from '@moltgames/domain';

export interface RatingRepository {
  getRating(seasonId: string, uid: string): Promise<Rating | null>;
  saveRating(rating: Rating): Promise<void>;
  listRatingsForSeason(seasonId: string): Promise<Rating[]>;
  getLeaderboard(seasonId: string): Promise<Leaderboard | null>;
  saveLeaderboard(leaderboard: Leaderboard): Promise<void>;
  getSeason(seasonId: string): Promise<Season | null>;
  saveSeason(season: Season): Promise<void>;
  listSeasons(): Promise<Season[]>;
}

const sortRatings = (ratings: readonly Rating[]): Rating[] =>
  [...ratings].sort((left, right) => {
    if (right.elo !== left.elo) {
      return right.elo - left.elo;
    }
    if (right.matches !== left.matches) {
      return right.matches - left.matches;
    }
    return left.uid.localeCompare(right.uid);
  });

export class InMemoryRatingRepository implements RatingRepository {
  private ratings = new Map<string, Rating>();
  private leaderboards = new Map<string, Leaderboard>();
  private seasons = new Map<string, Season>();

  async getRating(seasonId: string, uid: string): Promise<Rating | null> {
    return this.ratings.get(`${seasonId}_${uid}`) ?? null;
  }

  async saveRating(rating: Rating): Promise<void> {
    this.ratings.set(`${rating.seasonId}_${rating.uid}`, rating);
  }

  async listRatingsForSeason(seasonId: string): Promise<Rating[]> {
    return sortRatings(
      Array.from(this.ratings.values()).filter((rating) => rating.seasonId === seasonId),
    );
  }

  async getLeaderboard(seasonId: string): Promise<Leaderboard | null> {
    return this.leaderboards.get(seasonId) ?? null;
  }

  async saveLeaderboard(leaderboard: Leaderboard): Promise<void> {
    this.leaderboards.set(leaderboard.seasonId, leaderboard);
  }

  async getSeason(seasonId: string): Promise<Season | null> {
    return this.seasons.get(seasonId) ?? null;
  }

  async saveSeason(season: Season): Promise<void> {
    this.seasons.set(season.seasonId, season);
  }

  async listSeasons(): Promise<Season[]> {
    return Array.from(this.seasons.values()).sort((left, right) =>
      left.startsAt.localeCompare(right.startsAt),
    );
  }
}

const toSnapshot = <T>(id: string, data: T) => ({
  id,
  data: () => data,
});

export class FirestoreRatingRepository implements RatingRepository {
  private firestore: Firestore;

  constructor(firestore?: Firestore) {
    this.firestore = firestore ?? getFirestore();
  }

  async getRating(seasonId: string, uid: string): Promise<Rating | null> {
    const snapshot = await this.firestore.collection('ratings').doc(`${seasonId}_${uid}`).get();
    if (!snapshot.exists) {
      return null;
    }

    return ratingFirestoreConverter.fromFirestore(toSnapshot(snapshot.id, snapshot.data()));
  }

  async saveRating(rating: Rating): Promise<void> {
    await this.firestore
      .collection('ratings')
      .doc(`${rating.seasonId}_${rating.uid}`)
      .set(ratingFirestoreConverter.toFirestore(rating));
  }

  async listRatingsForSeason(seasonId: string): Promise<Rating[]> {
    const snapshot = await this.firestore
      .collection('ratings')
      .where('seasonId', '==', seasonId)
      .get();

    return sortRatings(
      snapshot.docs.map((doc) =>
        ratingFirestoreConverter.fromFirestore(toSnapshot(doc.id, doc.data())),
      ),
    );
  }

  async getLeaderboard(seasonId: string): Promise<Leaderboard | null> {
    const snapshot = await this.firestore.collection('leaderboards').doc(seasonId).get();
    if (!snapshot.exists) {
      return null;
    }

    return leaderboardFirestoreConverter.fromFirestore(toSnapshot(snapshot.id, snapshot.data()));
  }

  async saveLeaderboard(leaderboard: Leaderboard): Promise<void> {
    await this.firestore
      .collection('leaderboards')
      .doc(leaderboard.seasonId)
      .set(leaderboardFirestoreConverter.toFirestore(leaderboard));
  }

  async getSeason(seasonId: string): Promise<Season | null> {
    const snapshot = await this.firestore.collection('seasons').doc(seasonId).get();
    if (!snapshot.exists) {
      return null;
    }

    return seasonFirestoreConverter.fromFirestore(toSnapshot(snapshot.id, snapshot.data()));
  }

  async saveSeason(season: Season): Promise<void> {
    await this.firestore
      .collection('seasons')
      .doc(season.seasonId)
      .set(seasonFirestoreConverter.toFirestore(season));
  }

  async listSeasons(): Promise<Season[]> {
    const snapshot = await this.firestore.collection('seasons').get();
    return snapshot.docs
      .map((doc) => seasonFirestoreConverter.fromFirestore(toSnapshot(doc.id, doc.data())))
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  }
}
