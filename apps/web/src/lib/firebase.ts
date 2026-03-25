import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';

let _app: FirebaseApp | undefined;
let _auth: Auth | undefined;

export function getFirebaseApp(): FirebaseApp {
  if (_app !== undefined) return _app;
  const config = {
    apiKey: process.env['NEXT_PUBLIC_FIREBASE_API_KEY'] ?? '',
    authDomain: process.env['NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'] ?? '',
    projectId: process.env['NEXT_PUBLIC_FIREBASE_PROJECT_ID'] ?? '',
    storageBucket: process.env['NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET'] ?? '',
    messagingSenderId: process.env['NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'] ?? '',
    appId: process.env['NEXT_PUBLIC_FIREBASE_APP_ID'] ?? '',
  };
  _app = getApps().length === 0 ? initializeApp(config) : getApp();
  return _app;
}

export function getFirebaseAuth(): Auth {
  if (_auth !== undefined) return _auth;
  const firebaseApp = getFirebaseApp();
  _auth = getAuth(firebaseApp);
  if (process.env['NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST'] !== undefined) {
    connectAuthEmulator(
      _auth,
      `http://${process.env['NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST']}`,
      { disableWarnings: true }
    );
  }
  return _auth;
}

// Named exports for tests that mock this module
export const app = { get instance() { return getFirebaseApp(); } };
export const auth = { get instance() { return getFirebaseAuth(); } };
