import {
  getMissingBhajanFields,
  parsePitchStringOptional,
  type Bhajan,
  type BhajanIndexEntry,
  type CatalogIndexPayload,
  type CatalogIndexShardDoc,
  type CatalogMetaDoc,
  type CatalogPayload,
  type MatchCandidate,
  type MissingFieldKey,
  type PitchInfo,
  type RagaInfo,
  type RecordingSource,
  type TrackType,
} from '@bhajami/shared';
import bundledCatalogJson from '../../../../packages/shared/data/catalog.json';
import bundledIndexJson from '../../../../packages/shared/data/catalog-index.v1.json';
import { cleanYouTubeDisplayTitle } from './search-and-playback';

export const DEFAULT_FIREBASE_PROJECT_ID = 'saibhajanverse';

export type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

/** Converts a Firestore REST Value into a plain JavaScript value. */
export function fromFirestoreValue(val: FirestoreValue | undefined): unknown {
  if (!val) return undefined;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return val.doubleValue;
  if ('stringValue' in val) return val.stringValue;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) {
    return (val.arrayValue.values ?? []).map((item) => fromFirestoreValue(item));
  }
  if ('mapValue' in val) {
    return fromFirestoreFields(val.mapValue.fields ?? {});
  }
  return undefined;
}

/** Converts a map of Firestore REST Value entries into a plain object. */
export function fromFirestoreFields(
  fields: Record<string, FirestoreValue> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    out[k] = fromFirestoreValue(v);
  }
  return out;
}

function mergeRecordings(
  base: RecordingSource[],
  added: RecordingSource[],
): RecordingSource[] {
  if (!added.length) return base;
  const seenKeys = new Set(added.map((r) => r.externalUrl || r.localPath || r.id));
  const seenIds = new Set(added.map((r) => r.id));
  return [
    ...added,
    ...base.filter((r) => !seenKeys.has(r.externalUrl || r.localPath || r.id) && !seenIds.has(r.id)),
  ];
}

/**
 * Parses a Firestore `bhajans/{id}` field map into a nullable-safe `Bhajan` record,
 * handling legacy `youtubeId` and raw `lyrics` string documents gracefully.
 */
export function parseFirestoreBhajan(
  bhajanId: string,
  fields: Record<string, unknown>,
): Bhajan {
  const rawRaga = fields.raga;
  let raga: RagaInfo | null = null;
  if (rawRaga && typeof rawRaga === 'object') {
    const r = rawRaga as Record<string, unknown>;
    raga = {
      name: typeof r.name === 'string' && r.name.trim() ? r.name : 'Unspecified',
      arohanam: typeof r.arohanam === 'string' ? r.arohanam : undefined,
      avarohanam: typeof r.avarohanam === 'string' ? r.avarohanam : undefined,
      westernInC: typeof r.westernInC === 'string' ? r.westernInC : undefined,
    };
  } else if (typeof rawRaga === 'string' && rawRaga.trim()) {
    raga = { name: rawRaga.trim() };
  }

  const rawGents =
    fields.gentsPitch && typeof fields.gentsPitch === 'object'
      ? (fields.gentsPitch as PitchInfo)
      : parsePitchStringOptional(
          typeof fields.gentsPitchRaw === 'string' ? fields.gentsPitchRaw : undefined,
        ) ?? null;

  const rawLadies =
    fields.ladiesPitch && typeof fields.ladiesPitch === 'object'
      ? (fields.ladiesPitch as PitchInfo)
      : parsePitchStringOptional(
          typeof fields.ladiesPitchRaw === 'string' ? fields.ladiesPitchRaw : undefined,
        ) ?? null;

  const baseRecordings = Array.isArray(fields.recordings)
    ? (fields.recordings as RecordingSource[])
    : [];
  const addedRecs = Array.isArray(fields.addedRecordings)
    ? (fields.addedRecordings as RecordingSource[])
    : [];

  const rawTitle = typeof fields.title === 'string' ? fields.title.trim() : '';
  const firstLabel = String(baseRecordings[0]?.label || addedRecs[0]?.label || '').trim();
  const labelTitle = firstLabel
    ? (firstLabel.includes(': ') ? firstLabel.split(': ').slice(1).join(': ') : firstLabel)
        .replace(/\s*\(\d{1,2}:\d{2}(?::\d{2})?[–-]\d{1,2}:\d{2}(?::\d{2})?\)\s*$/, '')
        .trim()
    : '';
  const isLegacyOrYouTube =
    typeof fields.youtubeId === 'string' ||
    String(fields.source || '').toLowerCase() === 'youtube' ||
    String(fields.metadataSource || '').startsWith('youtube');
  let title = rawTitle || labelTitle || bhajanId.replace(/[-_]+/g, ' ').trim();
  if (isLegacyOrYouTube && title) {
    const cleaned = cleanYouTubeDisplayTitle(title);
    if (cleaned.length >= 3) title = cleaned;
  }

  const legacyYtId = typeof fields.youtubeId === 'string' ? fields.youtubeId.trim() : '';
  const normalizedBaseRecs: RecordingSource[] =
    baseRecordings.length > 0
      ? baseRecordings
      : legacyYtId
        ? [
            {
              id: `yt_${legacyYtId}`,
              label: title,
              collection: 'youtube_sss_bhajans',
              externalUrl: `https://www.youtube.com/watch?v=${legacyYtId}`,
              youtubeVideoId: legacyYtId,
              embeddable: true,
            },
          ]
        : [];

  const rawLyricsSets = Array.isArray(fields.lyricsSets)
    ? (fields.lyricsSets as Bhajan['lyricsSets'])
    : [];
  const lyricsSets =
    rawLyricsSets.length === 0 && typeof fields.lyrics === 'string' && fields.lyrics.trim()
      ? [
          {
            language: 'Roman',
            script: 'roman' as const,
            lines: fields.lyrics
              .split(/\r?\n/)
              .map((ln) => ln.trim())
              .filter(Boolean),
          },
        ]
      : rawLyricsSets;

  const bhajan: Bhajan = {
    id: bhajanId,
    slug: typeof fields.slug === 'string' ? fields.slug : bhajanId,
    title,
    deity: typeof fields.deity === 'string' ? fields.deity : null,
    language: typeof fields.language === 'string' ? fields.language : null,
    raga,
    beat: typeof fields.beat === 'string' ? fields.beat : null,
    tala: typeof fields.tala === 'string' ? fields.tala : null,
    tempo:
      typeof fields.tempo === 'string' || typeof fields.tempo === 'number'
        ? String(fields.tempo)
        : null,
    level: typeof fields.level === 'string' ? fields.level : null,
    gentsPitch: rawGents,
    ladiesPitch: rawLadies,
    gentsPitchRaw: typeof fields.gentsPitchRaw === 'string' ? fields.gentsPitchRaw : null,
    ladiesPitchRaw: typeof fields.ladiesPitchRaw === 'string' ? fields.ladiesPitchRaw : null,
    firstLineNotes:
      fields.firstLineNotes && typeof fields.firstLineNotes === 'object'
        ? (fields.firstLineNotes as Bhajan['firstLineNotes'])
        : null,
    notesRange: typeof fields.notesRange === 'string' ? fields.notesRange : null,
    meaning: typeof fields.meaning === 'string' ? fields.meaning : null,
    lyricsSets,
    glossary: Array.isArray(fields.glossary) ? (fields.glossary as Bhajan['glossary']) : [],
    recordings: mergeRecordings(normalizedBaseRecs, addedRecs),
    addedRecordings: addedRecs.length ? addedRecs : undefined,
    defaultRecordingId:
      typeof fields.defaultRecordingId === 'string' && fields.defaultRecordingId.trim()
        ? fields.defaultRecordingId.trim()
        : null,
    sheetMusicUrl: typeof fields.sheetMusicUrl === 'string' ? fields.sheetMusicUrl : null,
    sourceUrl: typeof fields.sourceUrl === 'string' ? fields.sourceUrl : null,
    metadataSource:
      typeof fields.metadataSource === 'string'
        ? (fields.metadataSource as Bhajan['metadataSource'])
        : legacyYtId
          ? 'youtube_sss_bhajans'
          : 'community_contributed',
    trackType:
      fields.trackType === 'bhajan' ||
      fields.trackType === 'instrumental' ||
      fields.trackType === 'karaoke' ||
      fields.trackType === 'special'
        ? (fields.trackType as TrackType)
        : undefined,
    isEstimated: fields.isEstimated === true ? true : undefined,
    lyricsMissing: fields.lyricsMissing === true ? true : undefined,
    matchStatus:
      fields.matchStatus === 'verified' ||
      fields.matchStatus === 'needs_verification' ||
      fields.matchStatus === 'unmatched'
        ? fields.matchStatus
        : undefined,
    matchCandidates: Array.isArray(fields.matchCandidates)
      ? (fields.matchCandidates as MatchCandidate[])
      : undefined,
    missingFields: Array.isArray(fields.missingFields)
      ? (fields.missingFields as MissingFieldKey[])
      : undefined,
    slugAliases: Array.isArray(fields.slugAliases) ? (fields.slugAliases as string[]) : undefined,
    bhajamiOverride: fields.bhajamiOverride === true ? true : undefined,
    bhajamiNewBhajan: fields.bhajamiNewBhajan === true ? true : undefined,
    createdAt: typeof fields.createdAt === 'string' ? fields.createdAt : undefined,
    updatedAt: typeof fields.updatedAt === 'string' ? fields.updatedAt : undefined,
  };

  if (!bhajan.missingFields) {
    bhajan.missingFields = getMissingBhajanFields(bhajan);
  }
  return bhajan;
}

/** Returns the bundled slim `CatalogIndexPayload` (`catalog-index.v1.json`) for instant offline startup. */
export function getBundledCatalogIndex(): CatalogIndexPayload {
  const payload = bundledIndexJson as unknown as CatalogIndexPayload;
  return {
    generatedAt: payload.generatedAt,
    version: 0,
    stats: payload.stats,
    entries: payload.entries,
  };
}

/** Looks up a full `Bhajan` record from the bundled local fallback catalog when offline. */
export function getBundledBhajanById(id: string): Bhajan | null {
  const cleanId = id.trim();
  if (!cleanId) return null;
  const catalog = bundledCatalogJson as unknown as CatalogPayload;
  return (
    catalog.bhajans.find(
      (b) => b.id === cleanId || b.slug === cleanId || b.slugAliases?.includes(cleanId),
    ) ?? null
  );
}

function buildDocsBaseUrl(projectId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}

async function fetchJsonWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Loads the live two-tier cloud catalog index (`catalogMeta/latest` + parallel `catalogIndexShards`)
 * directly via Firestore REST APIs, falling back seamlessly to the bundled index when offline.
 */
export async function fetchCloudCatalogIndex(
  options: {
    projectId?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<{ payload: CatalogIndexPayload; source: 'cloud' | 'bundled' }> {
  const projectId = options.projectId || DEFAULT_FIREBASE_PROJECT_ID;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const baseUrl = buildDocsBaseUrl(projectId);

  try {
    const metaRes = await fetchJsonWithTimeout(`${baseUrl}/catalogMeta/latest`, fetchImpl, timeoutMs);
    if (!metaRes.ok) {
      return { payload: getBundledCatalogIndex(), source: 'bundled' };
    }
    const metaJson = (await metaRes.json()) as { fields?: Record<string, FirestoreValue> };
    if (!metaJson.fields) {
      return { payload: getBundledCatalogIndex(), source: 'bundled' };
    }
    const meta = fromFirestoreFields(metaJson.fields) as unknown as CatalogMetaDoc;
    const shardIds = Array.isArray(meta.shardIds) ? meta.shardIds : [];
    if (shardIds.length === 0) {
      return { payload: getBundledCatalogIndex(), source: 'bundled' };
    }

    const shardResults = await Promise.all(
      shardIds.map(async (sid) => {
        const sRes = await fetchJsonWithTimeout(
          `${baseUrl}/catalogIndexShards/${encodeURIComponent(sid)}`,
          fetchImpl,
          timeoutMs,
        );
        if (!sRes.ok) return null;
        const sJson = (await sRes.json()) as { fields?: Record<string, FirestoreValue> };
        if (!sJson.fields) return null;
        return fromFirestoreFields(sJson.fields) as unknown as CatalogIndexShardDoc;
      }),
    );

    if (shardResults.some((s) => s === null)) {
      return { payload: getBundledCatalogIndex(), source: 'bundled' };
    }

    const entries: BhajanIndexEntry[] = shardResults.flatMap((s) => s?.entries ?? []);
    return {
      source: 'cloud',
      payload: {
        generatedAt: meta.updatedAt,
        version: Number(meta.version || 1),
        stats: meta.stats,
        entries,
      },
    };
  } catch {
    return { payload: getBundledCatalogIndex(), source: 'bundled' };
  }
}

/**
 * Lazily fetches a single full `bhajans/{id}` document from Cloud Firestore REST,
 * supporting `slugAliases` fallback lookup and bundled offline fallback.
 */
export async function fetchCloudBhajanDetail(
  id: string,
  options: {
    projectId?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<Bhajan | null> {
  const cleanId = id.trim();
  if (!cleanId) return null;
  const projectId = options.projectId || DEFAULT_FIREBASE_PROJECT_ID;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 6000;
  const baseUrl = buildDocsBaseUrl(projectId);

  try {
    const directRes = await fetchJsonWithTimeout(
      `${baseUrl}/bhajans/${encodeURIComponent(cleanId)}`,
      fetchImpl,
      timeoutMs,
    );
    if (directRes.ok) {
      const doc = (await directRes.json()) as {
        name?: string;
        fields?: Record<string, FirestoreValue>;
      };
      if (doc.fields) {
        const docId = doc.name?.split('/').pop() || cleanId;
        return parseFirestoreBhajan(docId, fromFirestoreFields(doc.fields));
      }
    }

    const qRes = await fetchJsonWithTimeout(`${baseUrl}:runQuery`, fetchImpl, timeoutMs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'bhajans' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'slugAliases' },
              op: 'ARRAY_CONTAINS',
              value: { stringValue: cleanId },
            },
          },
          limit: 1,
        },
      }),
    });
    if (qRes.ok) {
      const rows = (await qRes.json()) as Array<{
        document?: { name: string; fields?: Record<string, FirestoreValue> };
      }>;
      const first = rows.find((r) => Boolean(r.document?.fields))?.document;
      if (first?.fields) {
        const docId = first.name.split('/').pop() || cleanId;
        return parseFirestoreBhajan(docId, fromFirestoreFields(first.fields));
      }
    }
  } catch {
    // Fall back to bundled catalog when offline
  }

  return getBundledBhajanById(cleanId);
}
