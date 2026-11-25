import { doc, getDoc, setDoc } from 'firebase/firestore';
import { getFirebaseClientFirestore } from './firebase-client';

const MAX_FAVORITES = 500;

function storageKey(uid?: string | null): string {
  return `bhajami_liked_v1_${uid ? uid.trim() : 'guest'}`;
}

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of ids) {
    if (typeof item === 'string') {
      const clean = item.trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
        if (out.length >= MAX_FAVORITES) break;
      }
    }
  }
  return out;
}

export function loadLocalLikedIds(uid?: string | null): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(uid));
    if (!raw) return [];
    return normalizeIds(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveLocalLikedIds(ids: readonly string[], uid?: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(uid), JSON.stringify(normalizeIds(ids)));
  } catch {
    // Ignore quota/private mode errors
  }
}

/**
 * Load user favorites from `users/{uid}` and union any offline/guest likes locally saved.
 */
export async function syncLoadUserFavorites(uid: string): Promise<string[]> {
  const userLocal = loadLocalLikedIds(uid);
  const guestLocal = loadLocalLikedIds(null);
  const db = getFirebaseClientFirestore();
  if (!db || !uid) {
    return normalizeIds([...userLocal, ...guestLocal]);
  }
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    const remote = snap.exists() ? normalizeIds(snap.data()?.favorites) : [];
    const merged = normalizeIds([...remote, ...userLocal, ...guestLocal]);
    saveLocalLikedIds(merged, uid);
    return merged;
  } catch {
    return normalizeIds([...userLocal, ...guestLocal]);
  }
}

/**
 * Persist liked bhajans onto `users/{uid}` strictly obeying Firestore `isValidUser` rules
 * (`createdAt` written only on create, never mutated on update).
 */
export async function syncSaveUserFavorites(params: {
  uid: string;
  favorites: readonly string[];
  email?: string | null;
  displayName?: string | null;
}): Promise<boolean> {
  const cleanFavorites = normalizeIds(params.favorites);
  saveLocalLikedIds(cleanFavorites, params.uid);

  const db = getFirebaseClientFirestore();
  if (!db || !params.uid) return false;

  try {
    const userRef = doc(db, 'users', params.uid);
    const snap = await getDoc(userRef);
    const now = utcNowIso();
    const payload: Record<string, unknown> = {
      uid: params.uid,
      favorites: cleanFavorites,
      updatedAt: now,
    };
    if (params.email && params.email.length >= 3 && params.email !== 'guest@local') {
      payload.email = params.email;
    }
    if (params.displayName && params.displayName.trim().length > 0) {
      payload.displayName = params.displayName.trim().slice(0, 120);
    }
    if (!snap.exists()) {
      payload.createdAt = now;
    }
    await setDoc(userRef, payload, { merge: true });
    return true;
  } catch {
    return false;
  }
}
