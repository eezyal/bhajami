'use client';

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  type Auth,
  type User,
  type UserCredential,
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? 'saibhajanverse.firebaseapp.com',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'saibhajanverse',
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export function isFirebaseClientConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.appId);
}

let cachedApp: FirebaseApp | null = null;
let cachedDb: Firestore | null = null;

function getClientApp(): FirebaseApp | null {
  if (!isFirebaseClientConfigured()) return null;
  if (!cachedApp) {
    cachedApp = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
  }
  return cachedApp;
}

export function getFirebaseClientAuth(): { auth: Auth; googleProvider: GoogleAuthProvider } | null {
  const app = getClientApp();
  if (!app) return null;
  const auth = getAuth(app);
  const googleProvider = new GoogleAuthProvider();
  googleProvider.setCustomParameters({ prompt: 'select_account' });
  return { auth, googleProvider };
}

export interface FormattedAuthError {
  message: string;
  code: string | null;
  suggestLocalhost: boolean;
  suggestRedirect: boolean;
  consoleSettingsUrl?: string;
}

function extractFirebaseAuthCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  if (err instanceof Error) {
    const m = err.message.match(/\((auth\/[^)]+)\)/);
    if (m) return m[1];
  }
  return null;
}

function isLoopbackAliasHost(hostname?: string): boolean {
  if (!hostname) return false;
  const host = hostname.trim().toLowerCase();
  return host === '127.0.0.1' || host === '::1';
}

/**
 * Formats Firebase Auth client errors into actionable user messages with exact error codes
 * and recovery flags (`suggestLocalhost`, `suggestRedirect`, `consoleSettingsUrl`).
 */
export function formatFirebaseAuthError(
  err: unknown,
  options: { fallback?: string; isCloud?: boolean; hostname?: string } = {},
): FormattedAuthError {
  const fallback = options.fallback || 'Sign-In failed';
  const isCloud = options.isCloud ?? true;
  const rawMsg = err instanceof Error ? err.message : fallback;
  const code = extractFirebaseAuthCode(err);

  if (code === 'auth/unauthorized-domain' || rawMsg.includes('auth/unauthorized-domain')) {
    const hostLabel = options.hostname || 'this domain';
    const suggestLocalhost = isLoopbackAliasHost(options.hostname);
    const projectId = firebaseConfig.projectId || 'saibhajanverse';
    const consoleSettingsUrl = `https://console.firebase.google.com/project/${encodeURIComponent(projectId)}/authentication/settings`;
    return {
      code: 'auth/unauthorized-domain',
      suggestLocalhost,
      suggestRedirect: false,
      consoleSettingsUrl,
      message: suggestLocalhost
        ? `Google Sign-In is not authorized for "${hostLabel}". Open http://localhost:3000 for local sign-in, or add "${hostLabel}" in Firebase Console → Authentication → Settings → Authorized domains (${projectId}). [auth/unauthorized-domain]`
        : `Google Sign-In is not authorized for "${hostLabel}". Add "${hostLabel}" in Firebase Console → Authentication → Settings → Authorized domains (${projectId}) to allow logins from this host. [auth/unauthorized-domain]`,
    };
  }

  if (
    code === 'auth/popup-blocked' ||
    code === 'auth/operation-not-supported-in-this-environment' ||
    code === 'auth/cancelled-popup-request' ||
    rawMsg.includes('auth/popup-blocked') ||
    rawMsg.includes('auth/operation-not-supported-in-this-environment')
  ) {
    const resolvedCode = code || 'auth/popup-blocked';
    return {
      code: resolvedCode,
      suggestLocalhost: false,
      suggestRedirect: true,
      message: `Browser blocked or could not complete the Google Sign-In popup. Try Redirect Sign-In below. [${resolvedCode}]`,
    };
  }

  if (code === 'auth/popup-closed-by-user' || rawMsg.includes('auth/popup-closed-by-user')) {
    return {
      code: 'auth/popup-closed-by-user',
      suggestLocalhost: false,
      suggestRedirect: true,
      message:
        'Google Sign-In popup was closed before completing. Try again or use Redirect Sign-In. [auth/popup-closed-by-user]',
    };
  }

  if (
    code === 'auth/configuration-not-found' ||
    code === 'auth/operation-not-allowed' ||
    rawMsg.includes('auth/configuration-not-found') ||
    rawMsg.includes('auth/operation-not-allowed')
  ) {
    const resolvedCode = code || 'auth/operation-not-allowed';
    return {
      code: resolvedCode,
      suggestLocalhost: false,
      suggestRedirect: false,
      message: isCloud
        ? `Enable this Sign-In provider in Firebase Console → Authentication → Sign-in method (saibhajanverse). [${resolvedCode}]`
        : `Enable this Sign-In provider in Firebase Console → Authentication → Sign-in method (saibhajanverse), or use Continue as Guest below. [${resolvedCode}]`,
    };
  }

  if (code === 'auth/network-request-failed' || rawMsg.includes('auth/network-request-failed')) {
    return {
      code: 'auth/network-request-failed',
      suggestLocalhost: false,
      suggestRedirect: false,
      message:
        'Network error contacting Google / Firebase Auth. Check your connection or disable ad/tracker blockers for accounts.google.com and try again. [auth/network-request-failed]',
    };
  }

  return {
    code,
    suggestLocalhost: false,
    suggestRedirect: false,
    message: code && !rawMsg.includes(code) ? `${rawMsg} [${code}]` : rawMsg,
  };
}

export type GoogleSmartSignInResult =
  | { ok: false; missingConfig: true }
  | { ok: true; redirected: true }
  | { ok: true; redirected: false; result: UserCredential };

/**
 * Signs in with Google via popup, automatically falling back to redirect when popups are
 * blocked or unsupported in the current browser environment.
 */
export async function signInWithGoogleSmart(): Promise<GoogleSmartSignInResult> {
  const fb = getFirebaseClientAuth();
  if (!fb) return { ok: false, missingConfig: true };
  try {
    const result = await signInWithPopup(fb.auth, fb.googleProvider);
    return { ok: true, redirected: false, result };
  } catch (err) {
    const code = extractFirebaseAuthCode(err);
    if (
      code === 'auth/popup-blocked' ||
      code === 'auth/operation-not-supported-in-this-environment'
    ) {
      await signInWithRedirect(fb.auth, fb.googleProvider);
      return { ok: true, redirected: true };
    }
    throw err;
  }
}

export async function signInWithGoogleRedirect(): Promise<boolean> {
  const fb = getFirebaseClientAuth();
  if (!fb) return false;
  await signInWithRedirect(fb.auth, fb.googleProvider);
  return true;
}

export async function consumeGoogleRedirectResult(): Promise<{
  user: User | null;
  error: unknown;
}> {
  const fb = getFirebaseClientAuth();
  if (!fb) return { user: null, error: null };
  try {
    const cred = await getRedirectResult(fb.auth);
    return { user: cred?.user ?? null, error: null };
  } catch (err) {
    return { user: null, error: err };
  }
}

export function getFirebaseClientFirestore(): Firestore | null {
  const app = getClientApp();
  if (!app) return null;
  if (!cachedDb) {
    cachedDb = getFirestore(app);
  }
  return cachedDb;
}

export async function getCurrentFirebaseIdToken(forceRefresh = false): Promise<string | null> {
  const fb = getFirebaseClientAuth();
  if (!fb?.auth.currentUser) return null;
  try {
    return await fb.auth.currentUser.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}
