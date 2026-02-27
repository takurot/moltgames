import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../src/app.js';
import * as firebaseApp from 'firebase-admin/app';
import * as firebaseAuth from 'firebase-admin/auth';

vi.mock('firebase-admin/app', () => ({
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(),
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => ({})),
}));

describe('App', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', originalEnv.NODE_ENV || '');
    vi.stubEnv('CONNECT_TOKEN_SECRET', originalEnv.CONNECT_TOKEN_SECRET || '');
    vi.stubEnv('MOCK_AUTH', originalEnv.MOCK_AUTH || '');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('Security (SBP-001)', () => {
    it('throws error if CONNECT_TOKEN_SECRET is missing in production environment', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CONNECT_TOKEN_SECRET;

      await expect(createApp()).rejects.toThrow('CONNECT_TOKEN_SECRET is required');
    });

    it('throws error if CONNECT_TOKEN_SECRET is missing in development environment', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.CONNECT_TOKEN_SECRET;

      await expect(createApp()).rejects.toThrow('CONNECT_TOKEN_SECRET is required');
    });

    it('does not throw if CONNECT_TOKEN_SECRET is missing in test environment', async () => {
      process.env.NODE_ENV = 'test';
      delete process.env.CONNECT_TOKEN_SECRET;

      const app = await createApp();
      expect(app).toBeDefined();
      await app.close();
    });
  });

  describe('Security (SBP-002)', () => {
    it('uses MockFirebaseVerifier when MOCK_AUTH=true in test environment', async () => {
      process.env.NODE_ENV = 'test';
      process.env.MOCK_AUTH = 'true';

      const app = await createApp();
      expect(firebaseApp.initializeApp).not.toHaveBeenCalled();
      await app.close();
    });

    it('uses MockFirebaseVerifier when MOCK_AUTH=true in development environment', async () => {
      process.env.NODE_ENV = 'development';
      process.env.MOCK_AUTH = 'true';
      process.env.CONNECT_TOKEN_SECRET = 'my-secret';

      const app = await createApp();
      expect(firebaseApp.initializeApp).not.toHaveBeenCalled();
      await app.close();
    });

    it('ignores MOCK_AUTH=true and uses real FirebaseAuthVerifier in production environment', async () => {
      process.env.NODE_ENV = 'production';
      process.env.MOCK_AUTH = 'true';
      process.env.CONNECT_TOKEN_SECRET = 'my-secret';

      const app = await createApp();
      expect(firebaseApp.initializeApp).toHaveBeenCalled();
      await app.close();
    });
  });
});
