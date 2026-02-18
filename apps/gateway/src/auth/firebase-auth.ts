export const FIREBASE_AUTH_PROVIDER_IDS = ['google.com', 'github.com'] as const;

export type FirebaseAuthProviderId = (typeof FIREBASE_AUTH_PROVIDER_IDS)[number];

const firebaseAuthProviderIdSet: ReadonlySet<FirebaseAuthProviderId> = new Set(
  FIREBASE_AUTH_PROVIDER_IDS,
);

export const isFirebaseAuthProviderId = (value: unknown): value is FirebaseAuthProviderId =>
  typeof value === 'string' && firebaseAuthProviderIdSet.has(value as FirebaseAuthProviderId);

export interface VerifiedFirebaseIdToken {
  uid: string;
  providerId: FirebaseAuthProviderId;
  customClaims: Record<string, unknown>;
}

export interface FirebaseIdTokenVerifier {
  verifyIdToken(idToken: string): Promise<VerifiedFirebaseIdToken>;
}
