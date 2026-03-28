'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { activateDevice } from '@/lib/device-activate';

type ActivationState =
  | { kind: 'idle' }
  | { kind: 'activating' }
  | { kind: 'success' }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

function ActivateForm() {
  const params = useSearchParams();
  const { user, loading, signInWithGoogle, signInWithGithub } = useAuth();

  const [userCode, setUserCode] = useState(params.get('user_code') ?? '');
  const [state, setState] = useState<ActivationState>({ kind: 'idle' });
  const [authError, setAuthError] = useState<string | null>(null);
  const activatedRef = useRef(false);

  const gatewayUrl =
    process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080';

  const runActivation = async (code: string) => {
    if (!user || activatedRef.current) return;

    const trimmedCode = code.trim().toUpperCase();
    if (trimmedCode.length === 0) return;

    activatedRef.current = true;
    setState({ kind: 'activating' });

    try {
      const idToken = await user.getIdToken();
      const result = await activateDevice({
        userCode: trimmedCode,
        idToken,
        refreshToken: user.refreshToken,
        expiresIn: 3600,
        gatewayUrl,
      });

      if (result.success) {
        setState({ kind: 'success' });
      } else {
        activatedRef.current = false;
        setState({
          kind: 'error',
          code: result.code,
          message: result.message,
          retryable: result.retryable,
        });
      }
    } catch {
      activatedRef.current = false;
      setState({
        kind: 'error',
        code: 'NETWORK_ERROR',
        message: 'Network error. Please try again.',
        retryable: true,
      });
    }
  };

  // Auto-activate when user signs in and user_code is pre-filled from URL
  useEffect(() => {
    const prefilled = params.get('user_code');
    if (!loading && user !== null && prefilled !== null && !activatedRef.current) {
      void runActivation(prefilled);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, loading]);

  const handleSignIn = async (provider: 'google' | 'github') => {
    setAuthError(null);
    try {
      if (provider === 'google') {
        await signInWithGoogle();
      } else {
        await signInWithGithub();
      }
    } catch (err) {
      const code =
        err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : null;
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        return;
      }
      setAuthError('Sign-in failed. Please try again.');
    }
  };

  const handleActivate = async () => {
    activatedRef.current = false;
    await runActivation(userCode);
  };

  const handleRetry = () => {
    activatedRef.current = false;
    setState({ kind: 'idle' });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-gray-500">Loading…</p>
      </div>
    );
  }

  if (state.kind === 'success') {
    return (
      <section className="flex flex-col items-center justify-center min-h-[60vh] px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
          <div className="text-4xl mb-4" aria-hidden="true">
            ✓
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Device authorized</h1>
          <p className="text-sm text-gray-500">
            You can close this tab and return to your terminal.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col items-center justify-center min-h-[60vh] px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2 text-center">
          Authorize your device
        </h1>
        <p className="text-sm text-gray-500 mb-6 text-center">
          Enter the code shown in your terminal to connect your CLI.
        </p>

        {state.kind === 'error' && (
          <div
            role="alert"
            className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"
          >
            <p className="font-medium">{state.message}</p>
            {state.retryable && (
              <button
                onClick={handleRetry}
                className="mt-1 underline text-red-600 hover:text-red-800"
              >
                Try again
              </button>
            )}
          </div>
        )}

        <div className="mb-6">
          <label htmlFor="user-code" className="block text-sm font-medium text-gray-700 mb-1">
            Device code
          </label>
          <input
            id="user-code"
            type="text"
            value={userCode}
            onChange={(e) => setUserCode(e.target.value)}
            placeholder="XXXX-XXXX"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono tracking-widest text-center uppercase focus:outline-none focus:ring-2 focus:ring-indigo-500"
            maxLength={9}
            autoComplete="off"
            autoCapitalize="characters"
          />
        </div>

        {user === null ? (
          <>
            <p className="text-xs text-gray-400 mb-3 text-center">
              Sign in to authorize this device
            </p>
            {authError !== null && (
              <p role="alert" className="mb-3 text-sm text-red-600 text-center">
                {authError}
              </p>
            )}
            <div className="flex flex-col gap-3">
              <button
                onClick={() => void handleSignIn('google')}
                disabled={userCode.trim().length === 0}
                className="flex items-center justify-center gap-3 w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <GoogleIcon />
                Continue with Google
              </button>
              <button
                onClick={() => void handleSignIn('github')}
                disabled={userCode.trim().length === 0}
                className="flex items-center justify-center gap-3 w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <GitHubIcon />
                Continue with GitHub
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-gray-500 mb-4 text-center">
              Signed in as <span className="font-medium">{user.email ?? user.displayName}</span>
            </p>
            <button
              onClick={() => void handleActivate()}
              disabled={state.kind === 'activating' || userCode.trim().length === 0}
              className="w-full px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {state.kind === 'activating' ? 'Authorizing…' : 'Authorize device'}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export default function ActivatePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[60vh]">
          <p className="text-gray-500">Loading…</p>
        </div>
      }
    >
      <ActivateForm />
    </Suspense>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.373 0 0 5.373 0 12c0 5.302 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286 0 .322.218.694.825.576C20.565 21.795 24 17.298 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}
