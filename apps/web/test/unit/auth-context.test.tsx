import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Top-level mocks (hoisted)
vi.mock('@/lib/firebase', () => ({
  getFirebaseAuth: vi.fn(() => ({})),
}));

vi.mock('firebase/auth', () => ({
  signInWithPopup: vi.fn(),
  GoogleAuthProvider: vi.fn(function () {
    return { providerId: 'google.com' };
  }),
  GithubAuthProvider: vi.fn(function () {
    return { providerId: 'github.com' };
  }),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
}));

const getModules = async () => {
  const { AuthProvider, useAuth } = await import('@/contexts/auth-context');
  const firebaseAuth = await import('firebase/auth');
  return { AuthProvider, useAuth, firebaseAuth };
};

import React from 'react';

type UseAuthReturn = ReturnType<Awaited<ReturnType<typeof getModules>>['useAuth']>;

function makeConsumer(useAuth: () => UseAuthReturn) {
  return function TestConsumer() {
    const { user, loading, signInWithGoogle, signInWithGithub, signOut } = useAuth();
    if (loading) return <div>Loading...</div>;
    return (
      <div>
        <div data-testid="user">{user !== null ? user.uid : 'null'}</div>
        <button onClick={() => void signInWithGoogle()}>Sign In Google</button>
        <button onClick={() => void signInWithGithub()}>Sign In Github</button>
        <button onClick={() => void signOut()}>Sign Out</button>
      </div>
    );
  };
}

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws if useAuth is used outside AuthProvider', async () => {
    const { useAuth } = await getModules();
    const TestConsumer = makeConsumer(useAuth);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow('useAuth must be used within an AuthProvider');
    consoleSpy.mockRestore();
  });

  it('shows loading state initially', async () => {
    const { AuthProvider, useAuth, firebaseAuth } = await getModules();
    vi.mocked(firebaseAuth.onAuthStateChanged).mockImplementation(() => () => {});
    const TestConsumer = makeConsumer(useAuth);

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('provides null user when not authenticated', async () => {
    const { AuthProvider, useAuth, firebaseAuth } = await getModules();
    vi.mocked(firebaseAuth.onAuthStateChanged).mockImplementation(
      (_auth, callback) => {
        (callback as (u: null) => void)(null);
        return () => {};
      }
    );
    const TestConsumer = makeConsumer(useAuth);

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('null');
    });
  });

  it('provides user when authenticated', async () => {
    const { AuthProvider, useAuth, firebaseAuth } = await getModules();
    const mockUser = { uid: 'test-uid', displayName: 'Test User' };
    vi.mocked(firebaseAuth.onAuthStateChanged).mockImplementation(
      (_auth, callback) => {
        (callback as (u: typeof mockUser) => void)(mockUser);
        return () => {};
      }
    );
    const TestConsumer = makeConsumer(useAuth);

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('test-uid');
    });
  });

  it('calls signInWithPopup with GoogleAuthProvider on signInWithGoogle', async () => {
    const { AuthProvider, useAuth, firebaseAuth } = await getModules();
    vi.mocked(firebaseAuth.onAuthStateChanged).mockImplementation(
      (_auth, callback) => {
        (callback as (u: null) => void)(null);
        return () => {};
      }
    );
    vi.mocked(firebaseAuth.signInWithPopup).mockResolvedValue({} as never);
    const TestConsumer = makeConsumer(useAuth);

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => screen.getByText('Sign In Google'));
    await userEvent.click(screen.getByText('Sign In Google'));

    expect(firebaseAuth.signInWithPopup).toHaveBeenCalledOnce();
    expect(firebaseAuth.GoogleAuthProvider).toHaveBeenCalledOnce();
  });

  it('calls signInWithPopup with GithubAuthProvider on signInWithGithub', async () => {
    const { AuthProvider, useAuth, firebaseAuth } = await getModules();
    vi.mocked(firebaseAuth.onAuthStateChanged).mockImplementation(
      (_auth, callback) => {
        (callback as (u: null) => void)(null);
        return () => {};
      }
    );
    vi.mocked(firebaseAuth.signInWithPopup).mockResolvedValue({} as never);
    const TestConsumer = makeConsumer(useAuth);

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => screen.getByText('Sign In Github'));
    await userEvent.click(screen.getByText('Sign In Github'));

    expect(firebaseAuth.signInWithPopup).toHaveBeenCalledOnce();
    expect(firebaseAuth.GithubAuthProvider).toHaveBeenCalledOnce();
  });

  it('calls firebase signOut on sign out', async () => {
    const { AuthProvider, useAuth, firebaseAuth } = await getModules();
    const mockUser = { uid: 'test-uid', displayName: 'Test' };
    vi.mocked(firebaseAuth.onAuthStateChanged).mockImplementation(
      (_auth, callback) => {
        (callback as (u: typeof mockUser) => void)(mockUser);
        return () => {};
      }
    );
    vi.mocked(firebaseAuth.signOut).mockResolvedValue(undefined as never);
    const TestConsumer = makeConsumer(useAuth);

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => screen.getByText('Sign Out'));
    await userEvent.click(screen.getByText('Sign Out'));

    expect(firebaseAuth.signOut).toHaveBeenCalledOnce();
  });
});
