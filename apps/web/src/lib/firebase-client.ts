'use client';

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';

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

export function getFirebaseClientAuth(): { auth: Auth; googleProvider: GoogleAuthProvider } | null {
  if (!isFirebaseClientConfigured()) return null;
  if (!cachedApp) {
    cachedApp = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
  }
  const auth = getAuth(cachedApp);
  const googleProvider = new GoogleAuthProvider();
  return { auth, googleProvider };
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
