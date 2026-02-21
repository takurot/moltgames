import { Auth } from 'firebase-admin/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FirebaseAuthVerifier } from '../../../src/auth/firebase-verifier.js';

describe('FirebaseAuthVerifier', () => {
  let authMock: Auth;
  let verifier: FirebaseAuthVerifier;

  beforeEach(() => {
    authMock = {
      verifyIdToken: vi.fn(),
    } as unknown as Auth;
    verifier = new FirebaseAuthVerifier(authMock);
  });

  it('should verify valid token', async () => {
    const validToken = 'valid-token';
    const decodedToken = {
      uid: 'test-uid',
      firebase: { sign_in_provider: 'google.com' },
      some: 'claim',
    };

    (authMock.verifyIdToken as any).mockResolvedValue(decodedToken);

    const result = await verifier.verifyIdToken(validToken);

    expect(authMock.verifyIdToken).toHaveBeenCalledWith(validToken);
    expect(result).toEqual({
      uid: 'test-uid',
      providerId: 'google.com',
      customClaims: decodedToken,
    });
  });

  it('should throw error for unsupported provider', async () => {
    const validToken = 'valid-token';
    const decodedToken = {
      uid: 'test-uid',
      firebase: { sign_in_provider: 'unsupported' },
    };

    (authMock.verifyIdToken as any).mockResolvedValue(decodedToken);

    await expect(verifier.verifyIdToken(validToken)).rejects.toThrow('Unsupported provider');
  });

  it('should propagate verifyIdToken error', async () => {
    const invalidToken = 'invalid-token';
    (authMock.verifyIdToken as any).mockRejectedValue(new Error('Invalid token'));

    await expect(verifier.verifyIdToken(invalidToken)).rejects.toThrow('Invalid token');
  });
});
