import { type Auth } from 'firebase-admin/auth';

import {
  type FirebaseIdTokenVerifier,
  isFirebaseAuthProviderId,
  type VerifiedFirebaseIdToken,
} from './firebase-auth.js';

export class FirebaseAuthVerifier implements FirebaseIdTokenVerifier {
  readonly #auth: Auth;

  constructor(auth: Auth) {
    this.#auth = auth;
  }

  async verifyIdToken(idToken: string): Promise<VerifiedFirebaseIdToken> {
    const decodedToken = await this.#auth.verifyIdToken(idToken);
    const providerId = decodedToken.firebase.sign_in_provider;

    if (!isFirebaseAuthProviderId(providerId)) {
      throw new Error(`Unsupported provider: ${providerId}`);
    }

    return {
      uid: decodedToken.uid,
      providerId,
      customClaims: decodedToken,
    };
  }
}
