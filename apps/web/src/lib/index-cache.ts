'use client';

import type { Bhajan, CatalogIndexPayload } from '@bhajami/shared';

const DB_NAME = 'bhajami_cache_v1';
const DB_VERSION = 1;
const STORE_META = 'meta';
const STORE_BHAJANS = 'bhajans';
const CATALOG_INDEX_KEY = 'catalog_index';

let memIndex: CatalogIndexPayload | null = null;
const memBhajans = new Map<string, Bhajan>();

function openDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }
        if (!db.objectStoreNames.contains(STORE_BHAJANS)) {
          db.createObjectStore(STORE_BHAJANS);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function getCachedCatalogIndex(): Promise<CatalogIndexPayload | null> {
  const db = await openDb();
  if (!db) return memIndex;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_META, 'readonly');
      const req = tx.objectStore(STORE_META).get(CATALOG_INDEX_KEY);
      req.onsuccess = () => resolve((req.result as CatalogIndexPayload | undefined) ?? memIndex);
      req.onerror = () => resolve(memIndex);
    } catch {
      resolve(memIndex);
    }
  });
}

export async function setCachedCatalogIndex(payload: CatalogIndexPayload): Promise<void> {
  memIndex = payload;
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put(payload, CATALOG_INDEX_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getCachedBhajan(id: string): Promise<Bhajan | null> {
  const inMem = memBhajans.get(id);
  if (inMem) return inMem;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_BHAJANS, 'readonly');
      const req = tx.objectStore(STORE_BHAJANS).get(id);
      req.onsuccess = () => {
        const result = (req.result as Bhajan | undefined) ?? null;
        if (result) memBhajans.set(id, result);
        resolve(result);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function setCachedBhajan(bhajan: Bhajan): Promise<void> {
  memBhajans.set(bhajan.id, bhajan);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_BHAJANS, 'readwrite');
      tx.objectStore(STORE_BHAJANS).put(bhajan, bhajan.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
