import fs from 'node:fs';
import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { logEvent } from './logger';

export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'pschax@gmail.com').trim().toLowerCase();
const FIREBASE_PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'saibhajanverse';
const AUTH_VERIFIER_APP_NAME = 'bhajami-auth-verifier';

/**
 * Returns true when an authenticated identity matches the verified primary admin email
 * or holds the Firebase `admin: true` custom claim.
 */
export function isAdminIdentity(params: {
  email?: string | null;
  emailVerified?: boolean;
  adminClaim?: boolean;
}): boolean {
  if (params.adminClaim === true) return true;
  const normalized = typeof params.email === 'string' ? params.email.trim().toLowerCase() : '';
  return Boolean(normalized && normalized === ADMIN_EMAIL && params.emailVerified === true);
}

let cachedDb: Firestore | null | undefined;
let hasFirestoreCredentials: boolean | null = null;
let cachedAuthApp: App | null = null;

function ensureDefaultAdminApp(): { app: App | null; hasCreds: boolean } {
  if (hasFirestoreCredentials !== null) {
    const existing = getApps().find((a) => a.name === '[DEFAULT]') ?? null;
    return { app: existing, hasCreds: hasFirestoreCredentials };
  }

  try {
    const existingDefault = getApps().find((a) => a.name === '[DEFAULT]');
    if (existingDefault) {
      const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      const credsPresent = Boolean(
        (credPath && fs.existsSync(credPath)) ||
          process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
          process.env.FIRESTORE_EMULATOR_HOST,
      );
      hasFirestoreCredentials = credsPresent;
      return { app: existingDefault, hasCreds: credsPresent };
    }

    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credPath && fs.existsSync(credPath)) {
      const raw = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as { project_id?: string };
      const app = initializeApp({
        credential: cert(raw as Record<string, string>),
        projectId: raw.project_id ?? FIREBASE_PROJECT_ID,
      });
      hasFirestoreCredentials = true;
      return { app, hasCreds: true };
    }

    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const raw = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) as { project_id?: string };
      const app = initializeApp({
        credential: cert(raw as Record<string, string>),
        projectId: raw.project_id ?? FIREBASE_PROJECT_ID,
      });
      hasFirestoreCredentials = true;
      return { app, hasCreds: true };
    }

    if (process.env.FIRESTORE_EMULATOR_HOST) {
      const app = initializeApp({
        credential: applicationDefault(),
        projectId: FIREBASE_PROJECT_ID,
      });
      hasFirestoreCredentials = true;
      return { app, hasCreds: true };
    }

    hasFirestoreCredentials = false;
    return { app: null, hasCreds: false };
  } catch (err) {
    logEvent('error', {
      route: 'firebase-admin',
      errCode: 'admin_app_init_failed',
      message: err instanceof Error ? err.message : 'Failed to initialize Firebase Admin app',
    });
    hasFirestoreCredentials = false;
    return { app: null, hasCreds: false };
  }
}

/**
 * Returns true when server-side Firebase Admin credentials are available for Firestore Admin SDK writes.
 */
export function hasAdminFirestoreCredentials(): boolean {
  return ensureDefaultAdminApp().hasCreds;
}

/**
 * Returns a Firestore Admin client for `saibhajanverse` when credentials are available,
 * or null in zero-credential local/REST mode.
 */
export function getAdminFirestore(): Firestore | null {
  if (cachedDb !== undefined) return cachedDb;

  try {
    const { app, hasCreds } = ensureDefaultAdminApp();
    if (!hasCreds || !app) {
      cachedDb = null;
      return null;
    }
    cachedDb = getFirestore(app);
    return cachedDb;
  } catch (err) {
    logEvent('error', {
      route: 'firebase-admin',
      errCode: 'firestore_init_failed',
      message: err instanceof Error ? err.message : 'Unable to obtain Admin Firestore instance',
    });
    cachedDb = null;
    return null;
  }
}

function getAuthVerifierApp(): App {
  if (cachedAuthApp) return cachedAuthApp;
  const { app, hasCreds } = ensureDefaultAdminApp();
  if (hasCreds && app) {
    cachedAuthApp = app;
    return cachedAuthApp;
  }
  const existingVerifier = getApps().find((a) => a.name === AUTH_VERIFIER_APP_NAME);
  cachedAuthApp =
    existingVerifier ??
    initializeApp({ projectId: FIREBASE_PROJECT_ID }, AUTH_VERIFIER_APP_NAME);
  return cachedAuthApp;
}

export interface VerifiedUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  signInProvider: string | null;
  isAdmin: boolean;
}

export type AuthVerifyResult =
  | { ok: true; user: VerifiedUser; token: string }
  | { ok: false; status: 401 | 403; error: string; code: string };

export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

/**
 * Verifies a Firebase ID token from `Authorization: Bearer <token>` and rejects anonymous accounts.
 */
export async function verifyUserBearerToken(
  authHeader: string | null | undefined,
): Promise<AuthVerifyResult> {
  const token = extractBearerToken(authHeader);
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: 'Authentication required. Please sign in and retry.',
      code: 'auth_missing',
    };
  }

  try {
    const app = getAuthVerifierApp() || getApp();
    const decoded = await getAuth(app).verifyIdToken(token);
    const signInProvider =
      typeof decoded.firebase?.sign_in_provider === 'string'
        ? decoded.firebase.sign_in_provider
        : null;

    if (signInProvider === 'anonymous') {
      logEvent('warn', {
        route: 'firebase-admin',
        errCode: 'anonymous_not_allowed',
        httpStatus: 403,
        message: 'Rejected anonymous Firebase ID token',
      });
      return {
        ok: false,
        status: 403,
        error: 'Guest / anonymous sessions cannot perform this action. Please sign in with Google or Email.',
        code: 'anonymous_not_allowed',
      };
    }

    const email = typeof decoded.email === 'string' ? decoded.email : null;
    const emailVerified = decoded.email_verified === true;
    const isAdmin = isAdminIdentity({
      email,
      emailVerified,
      adminClaim: decoded.admin === true,
    });

    return {
      ok: true,
      token,
      user: {
        uid: decoded.uid,
        email,
        emailVerified,
        name: typeof decoded.name === 'string' ? decoded.name : null,
        signInProvider,
        isAdmin,
      },
    };
  } catch (err) {
    logEvent('warn', {
      route: 'firebase-admin',
      errCode: 'auth_invalid',
      httpStatus: 401,
      message: err instanceof Error ? err.message : 'Firebase ID token verification failed',
    });
    return {
      ok: false,
      status: 401,
      error: 'Invalid or expired Firebase authentication token.',
      code: 'auth_invalid',
    };
  }
}

/**
 * Verifies a Firebase ID token and requires admin claim or verified primary admin email.
 */
export async function verifyAdminBearerToken(
  authHeader: string | null | undefined,
): Promise<AuthVerifyResult> {
  const res = await verifyUserBearerToken(authHeader);
  if (!res.ok) return res;

  if (!res.user.isAdmin) {
    logEvent('warn', {
      route: 'firebase-admin',
      errCode: 'admin_required',
      httpStatus: 403,
      message: 'Non-admin account attempted an admin action',
    });
    return {
      ok: false,
      status: 403,
      error: 'Admin privileges required for moderation actions.',
      code: 'admin_required',
    };
  }
  return res;
}
