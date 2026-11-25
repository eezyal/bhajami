import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CatalogIndexPayload, StreamMediaMode } from '@bhajami/shared';

const LIKED_IDS_KEY = 'bhajami_mobile_liked_ids_v1';
const CATALOG_INDEX_KEY = 'bhajami_mobile_catalog_index_v1';
const THEME_MODE_KEY = 'bhajami_mobile_theme_mode_v1';
const MEDIA_MODE_KEY = 'bhajami_mobile_media_mode_v1';

/** Loads persisted favorite bhajan IDs/slugs from AsyncStorage. */
export async function loadStoredLikedIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(LIKED_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

/** Saves favorite bhajan IDs/slugs to AsyncStorage. */
export async function saveStoredLikedIds(ids: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(LIKED_IDS_KEY, JSON.stringify(ids));
  } catch {
    // Non-fatal storage failure
  }
}

/** Loads the last cached `CatalogIndexPayload` snapshot from AsyncStorage. */
export async function loadCachedCatalogIndex(): Promise<CatalogIndexPayload | null> {
  try {
    const raw = await AsyncStorage.getItem(CATALOG_INDEX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CatalogIndexPayload;
    return Array.isArray(parsed?.entries) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persists a slim `CatalogIndexPayload` snapshot in AsyncStorage for offline reloads. */
export async function saveCachedCatalogIndex(payload: CatalogIndexPayload): Promise<void> {
  try {
    await AsyncStorage.setItem(CATALOG_INDEX_KEY, JSON.stringify(payload));
  } catch {
    // Non-fatal storage failure
  }
}

/** Loads user-preferred light/dark theme mode from AsyncStorage. */
export async function loadStoredThemeMode(): Promise<'light' | 'dark' | null> {
  try {
    const raw = await AsyncStorage.getItem(THEME_MODE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

/** Persists light/dark theme mode in AsyncStorage. */
export async function saveStoredThemeMode(mode: 'light' | 'dark'): Promise<void> {
  try {
    await AsyncStorage.setItem(THEME_MODE_KEY, mode);
  } catch {
    // Non-fatal storage failure
  }
}

/** Loads persisted sticky Stream media mode (`audio` Data Saver vs `video`) from AsyncStorage. */
export async function loadStoredMediaMode(): Promise<StreamMediaMode | null> {
  try {
    const raw = await AsyncStorage.getItem(MEDIA_MODE_KEY);
    return raw === 'audio' || raw === 'video' ? raw : null;
  } catch {
    return null;
  }
}

/** Persists sticky Stream media mode (`audio` vs `video`) in AsyncStorage. */
export async function saveStoredMediaMode(mode: StreamMediaMode): Promise<void> {
  try {
    await AsyncStorage.setItem(MEDIA_MODE_KEY, mode);
  } catch {
    // Non-fatal storage failure
  }
}
