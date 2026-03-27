import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock firebase modules before importing lib/firebase
vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({ name: '[DEFAULT]' })),
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: '[DEFAULT]' })),
}));

vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({})),
  connectAuthEmulator: vi.fn(),
}));

describe('firebase.ts — environment variable validation', () => {
  const REQUIRED_VARS = {
    NEXT_PUBLIC_FIREBASE_API_KEY: 'test-api-key',
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'test.firebaseapp.com',
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'test-project',
    NEXT_PUBLIC_FIREBASE_APP_ID: '1:123:web:abc',
  };

  beforeEach(() => {
    // Clear mock call counts and reset module registry so each test gets a fresh singleton
    vi.clearAllMocks();
    vi.resetModules();
    // Set all required vars by default
    for (const [key, value] of Object.entries(REQUIRED_VARS)) {
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(REQUIRED_VARS)) {
      delete process.env[key];
    }
    delete process.env['NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST'];
  });

  it('initializes successfully when all required vars are set', async () => {
    const { getFirebaseApp } = await import('@/lib/firebase');
    expect(() => getFirebaseApp()).not.toThrow();
  });

  it('throws when NEXT_PUBLIC_FIREBASE_API_KEY is missing', async () => {
    delete process.env['NEXT_PUBLIC_FIREBASE_API_KEY'];
    const { getFirebaseApp } = await import('@/lib/firebase');
    expect(() => getFirebaseApp()).toThrow('NEXT_PUBLIC_FIREBASE_API_KEY');
  });

  it('throws when NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN is missing', async () => {
    delete process.env['NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'];
    const { getFirebaseApp } = await import('@/lib/firebase');
    expect(() => getFirebaseApp()).toThrow('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN');
  });

  it('throws when NEXT_PUBLIC_FIREBASE_PROJECT_ID is missing', async () => {
    delete process.env['NEXT_PUBLIC_FIREBASE_PROJECT_ID'];
    const { getFirebaseApp } = await import('@/lib/firebase');
    expect(() => getFirebaseApp()).toThrow('NEXT_PUBLIC_FIREBASE_PROJECT_ID');
  });

  it('throws when NEXT_PUBLIC_FIREBASE_APP_ID is missing', async () => {
    delete process.env['NEXT_PUBLIC_FIREBASE_APP_ID'];
    const { getFirebaseApp } = await import('@/lib/firebase');
    expect(() => getFirebaseApp()).toThrow('NEXT_PUBLIC_FIREBASE_APP_ID');
  });

  it('connects auth emulator when NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST is set', async () => {
    process.env['NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST'] = '127.0.0.1:9099';
    const firebaseModule = await import('@/lib/firebase');
    const firebaseAuth = await import('firebase/auth');
    firebaseModule.getFirebaseAuth();
    expect(firebaseAuth.connectAuthEmulator).toHaveBeenCalledWith(
      expect.anything(),
      'http://127.0.0.1:9099',
      { disableWarnings: true },
    );
  });

  it('does not connect auth emulator when NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST is not set', async () => {
    delete process.env['NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST'];
    const firebaseModule = await import('@/lib/firebase');
    const firebaseAuth = await import('firebase/auth');
    firebaseModule.getFirebaseAuth();
    expect(firebaseAuth.connectAuthEmulator).not.toHaveBeenCalled();
  });
});
