'use client';

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
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
  return { auth, googleProvider };
}

export function getFirebaseClientFirestore(): Firestore | null {
  const app = getClientApp();
  if (!app) return null;
  if (!cachedDb) {
    cachedDb = getFirestore(app);
  }
  return cachedDb;
}

export async function getCurrentFirebaseIdToken(): Promise<string | null> {
  const fb = getFirebaseClientAuth();
  if (!fb?.auth.currentUser) return null;
  try {
    return await fb.auth.currentUser.getIdToken();
  } catch {
    return null;
  }
}
