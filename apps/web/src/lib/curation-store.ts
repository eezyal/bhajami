import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalizePhrase,
  getMissingBhajanFields,
  isSpecialOrInstrumentalTrack,
  makeDoNotMergeKey,
  parsePitchStringOptional,
  type Bhajan,
  type BhajanRevision,
  type DoNotMergePairDoc,
  type DuplicateClearanceLogEntry,
  type EntityAliasDoc,
  type IngestionRunDoc,
  type LyricsSet,
  type ProposedMetadataPatch,
  type RagaInfo,
  type RecordingSource,
  type YouTubeVideoProvenanceDoc,
} from '@bhajami/shared';
import { getAdminFirestore } from './firebase-admin';
import {
  buildCanonicalBhajanFields,
  fromFirestoreFields,
  hasCloudConfig,
  invalidateCloudCatalogCaches,
  parseBhajanRecord,
  toFirestoreFields,
  type CloudApprovedOverride,
  type FirestoreValue,
} from './firestore-rest';
import { getBhajanDetail, getMergedCatalog, inferScriptKind } from './catalog-store';
import { logEvent } from './logger';

export type CurationViewKind =
  | 'missing_lyrics'
  | 'needs_verification'
  | 'ambiguous_long'
  | 'runs'
  | 'duplicate_log';

export type CurationActionPayload =
  | {
      action: 'approve_merge';
      sourceBhajanId: string;
      targetBhajanId: string;
      defaultRecordingId?: string;
      videoId?: string;
      saveAliasTitle?: string;
      note?: string;
      lyricsSets?: LyricsSet[];
      lyricsText?: string;
      script?: string;
      metadata?: ProposedMetadataPatch;
    }
  | {
      action: 'keep_distinct';
      sourceBhajanId: string;
      candidateBhajanId: string;
      note?: string;
    }
  | {
      action: 'publish_curated';
      bhajanId: string;
      lyricsSets?: LyricsSet[];
      lyricsText?: string;
      script?: string;
      metadata?: ProposedMetadataPatch;
    }
  | {
      action: 'exclude_non_bhajan';
      bhajanId: string;
      videoId?: string;
      reason: string;
    };

const REST_PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'saibhajanverse';
const REST_API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '';
const REST_BASE_DOC_URL = `https://firestore.googleapis.com/v1/projects/${REST_PROJECT_ID}/databases/(default)/documents`;
const DUPLICATE_LOG_FILENAME = 'duplicate-clearance-log.jsonl';
const MAX_NOTE_LEN = 500;

function withRestKey(url: string): string {
  if (!REST_API_KEY) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}key=${encodeURIComponent(REST_API_KEY)}`;
}

function encodeDocPath(collectionPath: string, docId: string): string {
  const segs = [...collectionPath.split('/').filter(Boolean), docId];
  return segs.map((s) => encodeURIComponent(s)).join('/');
}

async function readRestError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed?.error?.message || text || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function restGetDoc(
  collectionPath: string,
  docId: string,
  idToken: string,
): Promise<Record<string, unknown> | null> {
  const url = withRestKey(`${REST_BASE_DOC_URL}/${encodeDocPath(collectionPath, docId)}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `Firestore read failed for ${collectionPath}/${docId} (HTTP ${res.status}): ${await readRestError(res)}`,
    );
  }
  const doc = (await res.json()) as { fields?: Record<string, FirestoreValue> };
  return doc.fields ? fromFirestoreFields(doc.fields) : {};
}

async function restPatchDoc(
  collectionPath: string,
  docId: string,
  fieldsObj: Record<string, unknown>,
  idToken: string,
  updateMaskFields?: string[],
): Promise<void> {
  const base = `${REST_BASE_DOC_URL}/${encodeDocPath(collectionPath, docId)}`;
  const maskQuery =
    updateMaskFields && updateMaskFields.length > 0
      ? updateMaskFields.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&')
      : '';
  const url = withRestKey(maskQuery ? `${base}?${maskQuery}` : base);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ fields: toFirestoreFields(fieldsObj) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(
      `Firestore write failed for ${collectionPath}/${docId} (HTTP ${res.status}): ${await readRestError(res)}`,
    );
  }
}

async function restCreateDoc(
  collectionPath: string,
  docId: string,
  fieldsObj: Record<string, unknown>,
  idToken: string,
): Promise<void> {
  const cleanCol = collectionPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const url = withRestKey(`${REST_BASE_DOC_URL}/${cleanCol}?documentId=${encodeURIComponent(docId)}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ fields: toFirestoreFields(fieldsObj) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(
      `Firestore create failed for ${collectionPath}/${docId} (HTTP ${res.status}): ${await readRestError(res)}`,
    );
  }
}

async function restDeleteDoc(
  collectionPath: string,
  docId: string,
  idToken: string,
): Promise<void> {
  const url = withRestKey(`${REST_BASE_DOC_URL}/${encodeDocPath(collectionPath, docId)}`);
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return;
  if (!res.ok) {
    throw new Error(
      `Firestore delete failed for ${collectionPath}/${docId} (HTTP ${res.status}): ${await readRestError(res)}`,
    );
  }
}

async function restRunQuery(
  structuredQuery: Record<string, unknown>,
  idToken: string,
): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
  const url = withRestKey(`${REST_BASE_DOC_URL}:runQuery`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ structuredQuery }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`Firestore query failed: ${await readRestError(res)}`);
  }
  const rows = (await res.json()) as Array<{
    document?: { name: string; fields?: Record<string, FirestoreValue> };
  }>;
  return rows
    .filter((r) => Boolean(r.document?.fields))
    .map((r) => ({
      id: r.document!.name.split('/').pop() || '',
      fields: fromFirestoreFields(r.document!.fields),
    }));
}

async function restListCollection(
  collectionPath: string,
  idToken: string,
  pageSize = 200,
): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
  const out: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const cleanCol = collectionPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (pageToken) params.set('pageToken', pageToken);
    const url = withRestKey(`${REST_BASE_DOC_URL}/${cleanCol}?${params.toString()}`);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${idToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`Firestore list failed for ${collectionPath}: ${await readRestError(res)}`);
    }
    const data = (await res.json()) as {
      documents?: Array<{ name: string; fields?: Record<string, FirestoreValue> }>;
      nextPageToken?: string;
    };
    for (const doc of data.documents ?? []) {
      if (!doc.fields) continue;
      out.push({
        id: doc.name.split('/').pop() || '',
        fields: fromFirestoreFields(doc.fields),
      });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

function resolveDataDir(): string {
  if (process.env.BHAJAMI_DATA_DIR) {
    return path.resolve(process.env.BHAJAMI_DATA_DIR);
  }
  const repoRootWeb = path.resolve(process.cwd(), 'apps/web');
  return fs.existsSync(repoRootWeb)
    ? path.join(repoRootWeb, 'data')
    : path.resolve(process.cwd(), 'data');
}

function getLocalStorePath(filename: string): string {
  return path.join(resolveDataDir(), filename);
}

function readLocalJson<T>(filename: string, fallback: T): T {
  const filePath = getLocalStorePath(filename);
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeLocalJson(filename: string, data: unknown): void {
  const dir = resolveDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getLocalStorePath(filename), JSON.stringify(data, null, 2), 'utf-8');
}

function appendDuplicateClearanceLog(entry: DuplicateClearanceLogEntry): void {
  try {
    const dir = resolveDataDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(
      getLocalStorePath(DUPLICATE_LOG_FILENAME),
      `${JSON.stringify(entry)}\n`,
      'utf-8',
    );
  } catch (err) {
    logEvent('warn', {
      route: 'curation-store.appendDuplicateClearanceLog',
      errCode: 'log_append_failed',
      message: err instanceof Error ? err.message : 'Unable to append duplicate clearance log',
    });
  }
}

export function readLocalDuplicateClearanceLog(): DuplicateClearanceLogEntry[] {
  const filePath = getLocalStorePath(DUPLICATE_LOG_FILENAME);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const out: DuplicateClearanceLogEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as DuplicateClearanceLogEntry;
        if (parsed && parsed.sourceBhajanId && parsed.targetBhajanId && parsed.decision) {
          out.push(parsed);
        }
      } catch {
        // Skip malformed line
      }
    }
    return out.sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
  } catch {
    return [];
  }
}

function mergeDuplicateLogSources(
  localEntries: DuplicateClearanceLogEntry[],
  cloudEntries: DuplicateClearanceLogEntry[],
  limit: number,
): DuplicateClearanceLogEntry[] {
  const byKey = new Map<string, DuplicateClearanceLogEntry>();
  for (const entry of localEntries) {
    const key = `${entry.decision}::${entry.sourceBhajanId}::${entry.targetBhajanId}`;
    byKey.set(key, entry);
  }
  for (const entry of cloudEntries) {
    const forward = `${entry.decision}::${entry.sourceBhajanId}::${entry.targetBhajanId}`;
    const reverse = `${entry.decision}::${entry.targetBhajanId}::${entry.sourceBhajanId}`;
    if (!byKey.has(forward) && !byKey.has(reverse)) {
      byKey.set(forward, entry);
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : 0))
    .slice(0, limit);
}

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function randomSuffix(length = 4): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function hasLongAmbiguousVideo(bhajan: Bhajan): boolean {
  return (bhajan.recordings ?? []).some((rec) => (rec.durationSec ?? 0) > 390);
}

function filterBhajansByView(
  bhajans: Bhajan[],
  view: 'missing_lyrics' | 'needs_verification' | 'ambiguous_long',
  ambiguousVideoIds?: Set<string>,
): Bhajan[] {
  if (view === 'missing_lyrics') {
    return bhajans.filter(
      (b) =>
        !isSpecialOrInstrumentalTrack(b) &&
        (b.lyricsMissing === true || getMissingBhajanFields(b).includes('lyrics')),
    );
  }
  if (view === 'needs_verification') {
    return bhajans.filter((b) => b.matchStatus === 'needs_verification');
  }
  return bhajans.filter(
    (b) =>
      hasLongAmbiguousVideo(b) ||
      (ambiguousVideoIds ? ambiguousVideoIds.has(b.id) : false),
  );
}

function mergeRecordingsUnique(
  targetRecs: RecordingSource[],
  sourceRecs: RecordingSource[],
): RecordingSource[] {
  const out = [...targetRecs];
  const seen = new Set(targetRecs.map((r) => r.id));
  for (const rec of sourceRecs) {
    if (!seen.has(rec.id)) {
      seen.add(rec.id);
      out.push(rec);
    }
  }
  return out;
}

function applyDefaultRecordingSelection(
  recordings: RecordingSource[],
  defaultRecordingId?: string,
): { recordings: RecordingSource[]; defaultRecordingId: string | null } {
  if (recordings.length === 0) {
    return { recordings: [], defaultRecordingId: null };
  }
  const chosenId = defaultRecordingId?.trim();
  if (!chosenId) {
    throw new Error(
      'approve_merge requires selecting a valid defaultRecordingId from the merged recordings.',
    );
  }
  const chosenIdx = recordings.findIndex((r) => r.id === chosenId);
  if (chosenIdx < 0) {
    throw new Error(
      `approve_merge requires selecting a valid defaultRecordingId from the merged recordings (unknown id "${chosenId}").`,
    );
  }
  const chosen = { ...recordings[chosenIdx], isDefault: true };
  const others = recordings
    .filter((_, idx) => idx !== chosenIdx)
    .map((r) => {
      if (!r.isDefault) return r;
      const { isDefault: _omitted, ...rest } = r;
      return rest;
    });
  return {
    recordings: [chosen, ...others],
    defaultRecordingId: chosen.id,
  };
}

function computeAliasKey(canonicalPhrase: string): string {
  return crypto.createHash('sha1').update(canonicalPhrase, 'utf8').digest('hex').slice(0, 16);
}

function buildCuratedLyricsSets(params: {
  existing: Bhajan;
  lyricsSets?: LyricsSet[];
  lyricsText?: string;
  script?: string;
}): LyricsSet[] {
  if (Array.isArray(params.lyricsSets) && params.lyricsSets.length > 0) {
    return params.lyricsSets;
  }
  const lines = (params.lyricsText ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return params.existing.lyricsSets ?? [];
  }
  const label = params.script?.trim() || params.existing.lyricsSets[0]?.language || 'Roman';
  const kind = inferScriptKind(lines, label);
  const baseSets = [...(params.existing.lyricsSets ?? [])];
  const existingIdx = baseSets.findIndex(
    (s) => s.language.toLowerCase() === label.toLowerCase() || s.script === kind,
  );
  if (existingIdx >= 0) {
    baseSets[existingIdx] = { language: label, script: kind, lines };
    return baseSets;
  }
  return [{ language: label, script: kind, lines }, ...baseSets];
}

function prepareApproveMergeData(params: {
  source: Bhajan;
  target: Bhajan;
  payload: Extract<CurationActionPayload, { action: 'approve_merge' }>;
  reviewer: string;
  now: string;
}) {
  const { source, target, payload, reviewer, now } = params;
  const mergedRecordings = mergeRecordingsUnique(target.recordings, source.recordings);
  const {
    recordings: orderedRecordings,
    defaultRecordingId,
  } = applyDefaultRecordingSelection(mergedRecordings, payload.defaultRecordingId);

  const aliasSlugs = Array.from(
    new Set([
      ...(target.slugAliases ?? []),
      source.id,
      source.slug,
      ...(source.slugAliases ?? []),
    ]),
  ).filter((s) => Boolean(s) && s !== target.id && s !== target.slug);

  const nextTargetCandidates = (target.matchCandidates ?? []).filter(
    (c) => c.targetBhajanId !== source.id,
  );
  const matchedCandidate = (source.matchCandidates ?? []).find(
    (c) => c.targetBhajanId === target.id,
  );

  // Backfill target lyrics/metadata from source when missing, then apply any Admin edits
  const seedLyricsSets =
    (target.lyricsSets?.length ?? 0) > 0 ? target.lyricsSets : source.lyricsSets ?? [];
  const nextLyricsSets = buildCuratedLyricsSets({
    existing: { ...target, lyricsSets: seedLyricsSets },
    lyricsSets: payload.lyricsSets,
    lyricsText: payload.lyricsText,
    script: payload.script,
  });

  const meta = payload.metadata ?? {};
  const pickStr = (edited?: string, tVal?: string | null, sVal?: string | null) =>
    edited?.trim() || tVal?.trim() || sVal?.trim() || undefined;

  const ragaNameFromMeta = pickStr(
    meta.ragaName || meta.raga,
    target.raga?.name,
    source.raga?.name,
  );
  const arohanamFromMeta = pickStr(meta.arohanam, target.raga?.arohanam, source.raga?.arohanam);
  const avarohanamFromMeta = pickStr(
    meta.avarohanam,
    target.raga?.avarohanam,
    source.raga?.avarohanam,
  );
  const nextRaga: RagaInfo | undefined =
    ragaNameFromMeta || arohanamFromMeta || avarohanamFromMeta || target.raga?.westernInC
      ? {
          name: ragaNameFromMeta || 'Unspecified',
          arohanam: arohanamFromMeta,
          avarohanam: avarohanamFromMeta,
          westernInC: target.raga?.westernInC ?? source.raga?.westernInC,
        }
      : undefined;

  const sargamMerged = pickStr(
    meta.firstLineSargam,
    target.firstLineNotes?.sargam,
    source.firstLineNotes?.sargam,
  );
  const westernMerged = pickStr(
    meta.firstLineWestern,
    target.firstLineNotes?.westernInC,
    source.firstLineNotes?.westernInC,
  );
  const nextFirstLineNotes =
    sargamMerged || westernMerged
      ? { sargam: sargamMerged, westernInC: westernMerged }
      : undefined;

  const gentsRawMerged = pickStr(
    meta.gentsPitchRaw,
    target.gentsPitchRaw || target.gentsPitch?.raw,
    source.gentsPitchRaw || source.gentsPitch?.raw,
  );
  const ladiesRawMerged = pickStr(
    meta.ladiesPitchRaw,
    target.ladiesPitchRaw || target.ladiesPitch?.raw,
    source.ladiesPitchRaw || source.ladiesPitch?.raw,
  );
  const beatMerged = pickStr(
    meta.beat?.trim() || meta.tala?.trim(),
    target.beat,
    source.beat,
  );
  const tempoMerged =
    meta.tempo !== undefined && String(meta.tempo).trim() !== ''
      ? String(meta.tempo).trim()
      : target.tempo || source.tempo || undefined;

  const ov: CloudApprovedOverride = {
    bhajanId: target.id,
    slug: target.slug,
    title: pickStr(meta.title, target.title, source.title) || target.title,
    deity: pickStr(meta.deity, target.deity, source.deity),
    language: pickStr(meta.language, target.language, source.language),
    beat: beatMerged,
    tala: pickStr(meta.tala, target.tala, source.tala),
    tempo: tempoMerged,
    meaning: pickStr(meta.meaning, target.meaning, source.meaning),
    raga: nextRaga,
    gentsPitchRaw: gentsRawMerged,
    ladiesPitchRaw: ladiesRawMerged,
    firstLineNotes: nextFirstLineNotes,
    notesRange: pickStr(meta.notesRange, target.notesRange, source.notesRange),
    sheetMusicUrl: pickStr(meta.sheetMusicUrl, target.sheetMusicUrl, source.sheetMusicUrl),
    lyricsSets: nextLyricsSets,
    lyricsMissing: nextLyricsSets.length === 0,
    isEstimated: false,
    recordings: orderedRecordings,
    defaultRecordingId,
    slugAliases: aliasSlugs,
    ...(target.matchCandidates ? { matchCandidates: nextTargetCandidates } : {}),
    bhajamiOverride: true,
    updatedAt: now,
  };

  const targetPatch = buildCanonicalBhajanFields(ov, target);
  delete targetPatch.createdAt;

  const nextTarget: Bhajan = {
    ...target,
    title: ov.title || target.title,
    deity: ov.deity ?? target.deity,
    language: ov.language ?? target.language,
    beat: ov.beat ?? target.beat,
    tala: ov.tala ?? target.tala,
    tempo: ov.tempo ?? target.tempo,
    meaning: ov.meaning ?? target.meaning,
    raga: nextRaga ?? target.raga,
    gentsPitchRaw: gentsRawMerged ?? target.gentsPitchRaw,
    ladiesPitchRaw: ladiesRawMerged ?? target.ladiesPitchRaw,
    gentsPitch: gentsRawMerged
      ? parsePitchStringOptional(gentsRawMerged) ?? target.gentsPitch
      : target.gentsPitch,
    ladiesPitch: ladiesRawMerged
      ? parsePitchStringOptional(ladiesRawMerged) ?? target.ladiesPitch
      : target.ladiesPitch,
    firstLineNotes: nextFirstLineNotes ?? target.firstLineNotes,
    notesRange: ov.notesRange ?? target.notesRange,
    sheetMusicUrl: ov.sheetMusicUrl ?? target.sheetMusicUrl,
    lyricsSets: nextLyricsSets,
    lyricsMissing: nextLyricsSets.length === 0,
    isEstimated: false,
    recordings: orderedRecordings,
    defaultRecordingId,
    slugAliases: aliasSlugs,
    ...(target.matchCandidates ? { matchCandidates: nextTargetCandidates } : {}),
    bhajamiOverride: true,
    updatedAt: now,
  };
  nextTarget.missingFields = getMissingBhajanFields(nextTarget);

  let aliasDoc: EntityAliasDoc | null = null;
  const aliasText = payload.saveAliasTitle?.trim();
  if (aliasText) {
    const canonical = canonicalizePhrase(aliasText);
    if (canonical) {
      aliasDoc = {
        id: computeAliasKey(canonical),
        variantTitle: aliasText,
        canonicalPhrase: canonical,
        targetBhajanId: target.id,
        source: 'admin_merge',
        createdAt: now,
        approvedBy: reviewer,
      };
    }
  }

  const cleanNote = payload.note?.trim().slice(0, MAX_NOTE_LEN) || null;
  const logEntry: DuplicateClearanceLogEntry = {
    id: `dup_merge_${Date.now()}_${randomSuffix(4)}`,
    decision: 'merged',
    sourceBhajanId: source.id,
    sourceTitle: source.title,
    targetBhajanId: target.id,
    targetTitle: nextTarget.title,
    candidateScore: matchedCandidate?.score ?? null,
    candidateReason: matchedCandidate?.reason ?? null,
    defaultRecordingId,
    combinedRecordingCount: orderedRecordings.length,
    adminNote: cleanNote,
    reviewerEmail: reviewer,
    decidedAt: now,
    storageSource: 'local_jsonl',
  };

  return {
    orderedRecordings,
    defaultRecordingId,
    aliasSlugs,
    nextTargetCandidates,
    ov,
    targetPatch,
    nextTarget,
    aliasDoc,
    logEntry,
  };
}

function prepareKeepDistinctData(params: {
  source: Bhajan;
  payload: Extract<CurationActionPayload, { action: 'keep_distinct' }>;
  reviewer: string;
  now: string;
}) {
  const { source, payload, reviewer, now } = params;
  const cleanNote = payload.note?.trim() || '';
  if (cleanNote.length > MAX_NOTE_LEN) {
    throw new Error(`Difference explanation must be at most ${MAX_NOTE_LEN} characters.`);
  }
  const matchedCandidate = (source.matchCandidates ?? []).find(
    (c) => c.targetBhajanId === payload.candidateBhajanId,
  );
  const nextCandidates = (source.matchCandidates ?? []).filter(
    (c) => c.targetBhajanId !== payload.candidateBhajanId,
  );
  const nextStatus: Bhajan['matchStatus'] =
    nextCandidates.length > 0
      ? 'needs_verification'
      : source.lyricsMissing
        ? 'unmatched'
        : 'verified';

  const pairKey = makeDoNotMergeKey(payload.sourceBhajanId, payload.candidateBhajanId);
  const pairDoc: DoNotMergePairDoc = {
    id: pairKey,
    entityA:
      payload.sourceBhajanId <= payload.candidateBhajanId
        ? payload.sourceBhajanId
        : payload.candidateBhajanId,
    entityB:
      payload.sourceBhajanId <= payload.candidateBhajanId
        ? payload.candidateBhajanId
        : payload.sourceBhajanId,
    createdBy: reviewer,
    createdAt: now,
    ...(cleanNote ? { note: cleanNote } : {}),
  };

  const logEntry: DuplicateClearanceLogEntry = {
    id: `dup_distinct_${Date.now()}_${randomSuffix(4)}`,
    decision: 'kept_distinct',
    sourceBhajanId: source.id,
    sourceTitle: source.title,
    targetBhajanId: payload.candidateBhajanId,
    targetTitle: matchedCandidate?.targetTitle || payload.candidateBhajanId,
    candidateScore: matchedCandidate?.score ?? null,
    candidateReason: matchedCandidate?.reason ?? null,
    adminNote: cleanNote || null,
    reviewerEmail: reviewer,
    decidedAt: now,
    storageSource: 'local_jsonl',
  };

  return {
    pairKey,
    pairDoc,
    nextCandidates,
    nextStatus,
    updatedSource: {
      ...source,
      matchCandidates: nextCandidates,
      matchStatus: nextStatus,
      updatedAt: now,
    } satisfies Bhajan,
    logEntry,
  };
}

function preparePublishCuratedData(params: {
  existing: Bhajan;
  payload: Extract<CurationActionPayload, { action: 'publish_curated' }>;
  reviewer: string;
  now: string;
}) {
  const { existing, payload, reviewer, now } = params;
  const meta = payload.metadata ?? {};
  const nextLyricsSets = buildCuratedLyricsSets({
    existing,
    lyricsSets: payload.lyricsSets,
    lyricsText: payload.lyricsText,
    script: payload.script,
  });

  const tempoStr =
    meta.tempo !== undefined && String(meta.tempo).trim() !== ''
      ? String(meta.tempo).trim()
      : existing.tempo ?? undefined;
  const ragaNameFromMeta = meta.ragaName || meta.raga;
  const nextRaga: RagaInfo | undefined =
    ragaNameFromMeta || meta.arohanam || meta.avarohanam
      ? {
          name: ragaNameFromMeta || existing.raga?.name || 'Unspecified',
          arohanam: meta.arohanam ?? existing.raga?.arohanam,
          avarohanam: meta.avarohanam ?? existing.raga?.avarohanam,
          westernInC: existing.raga?.westernInC,
        }
      : existing.raga ?? undefined;

  const nextFirstLineNotes =
    meta.firstLineSargam || meta.firstLineWestern
      ? {
          sargam: meta.firstLineSargam ?? existing.firstLineNotes?.sargam,
          westernInC: meta.firstLineWestern ?? existing.firstLineNotes?.westernInC,
        }
      : existing.firstLineNotes ?? undefined;

  const ov: CloudApprovedOverride = {
    bhajanId: existing.id,
    slug: existing.slug,
    title: meta.title?.trim() || existing.title,
    deity: meta.deity?.trim() || existing.deity || undefined,
    language: meta.language?.trim() || existing.language || undefined,
    beat: meta.beat?.trim() || meta.tala?.trim() || existing.beat || undefined,
    tala: meta.tala?.trim() || existing.tala || undefined,
    tempo: tempoStr,
    meaning: meta.meaning?.trim() || existing.meaning || undefined,
    raga: nextRaga,
    gentsPitchRaw: meta.gentsPitchRaw?.trim() || existing.gentsPitchRaw || existing.gentsPitch?.raw,
    ladiesPitchRaw: meta.ladiesPitchRaw?.trim() || existing.ladiesPitchRaw || existing.ladiesPitch?.raw,
    firstLineNotes: nextFirstLineNotes,
    notesRange: meta.notesRange?.trim() || existing.notesRange || undefined,
    sheetMusicUrl: meta.sheetMusicUrl?.trim() || existing.sheetMusicUrl || undefined,
    lyricsSets: nextLyricsSets,
    lyricsMissing: nextLyricsSets.length === 0,
    isEstimated: false,
    matchStatus: 'verified',
    matchCandidates: [],
    metadataSource: 'admin_curated',
    bhajamiOverride: true,
    updatedAt: now,
  };

  const fields = buildCanonicalBhajanFields(ov, existing);
  const revId = `rev_${Date.now()}_${randomSuffix(4)}`;
  const revision: BhajanRevision = {
    id: revId,
    bhajanId: existing.id,
    correctionId: `curated_${revId}`,
    previousLyrics: existing.lyricsSets[0]?.lines ?? [],
    newLyrics: nextLyricsSets[0]?.lines ?? [],
    script: nextLyricsSets[0]?.language || 'Roman',
    contributorName: reviewer,
    approvedBy: reviewer,
    approvedAt: now,
  };

  return { ov, fields, revId, revision };
}

function mapCloudPairsAndAliasesToLog(params: {
  pairs: DoNotMergePairDoc[];
  aliases: EntityAliasDoc[];
}): DuplicateClearanceLogEntry[] {
  const entries: DuplicateClearanceLogEntry[] = [];
  for (const p of params.pairs) {
    entries.push({
      id: `dnm_${p.id}`,
      decision: 'kept_distinct',
      sourceBhajanId: p.entityA,
      sourceTitle: p.entityA,
      targetBhajanId: p.entityB,
      targetTitle: p.entityB,
      adminNote: p.note ?? null,
      reviewerEmail: p.createdBy || 'pschax@gmail.com',
      decidedAt: p.createdAt || '',
      storageSource: 'firestore_do_not_merge',
    });
  }
  for (const a of params.aliases) {
    if (a.source !== 'admin_merge') continue;
    entries.push({
      id: `alias_${a.id}`,
      decision: 'merged',
      sourceBhajanId: a.variantTitle,
      sourceTitle: a.variantTitle,
      targetBhajanId: a.targetBhajanId,
      targetTitle: a.targetBhajanId,
      reviewerEmail: a.approvedBy || 'pschax@gmail.com',
      decidedAt: a.createdAt || '',
      storageSource: 'firestore_entity_alias',
    });
  }
  return entries;
}

export async function listCurationView(params: {
  view: CurationViewKind;
  cursor?: string | null;
  limit?: number;
  idToken?: string | null;
}): Promise<{
  view: CurationViewKind;
  items: Bhajan[];
  runs?: IngestionRunDoc[];
  duplicateLog?: DuplicateClearanceLogEntry[];
  nextCursor: string | null;
  totalMatching: number;
}> {
  const safeLimit = Math.max(1, Math.min(100, Number(params.limit || 25) || 25));
  const cloudMode = hasCloudConfig();

  if (cloudMode) {
    const db = getAdminFirestore();

    if (db) {
      if (params.view === 'runs') {
        const snap = await db
          .collection('ingestionRuns')
          .orderBy('startedAt', 'desc')
          .limit(safeLimit)
          .get();
        const runs = snap.docs.map((doc) => ({
          runId: doc.id,
          ...(doc.data() as Omit<IngestionRunDoc, 'runId'>),
        }));
        return {
          view: 'runs',
          items: [],
          runs,
          nextCursor: null,
          totalMatching: runs.length,
        };
      }

      if (params.view === 'duplicate_log') {
        const [dnmSnap, aliasSnap] = await Promise.all([
          db.collection('doNotMergePairs').orderBy('createdAt', 'desc').limit(safeLimit).get(),
          db.collection('entityAliases').where('source', '==', 'admin_merge').limit(safeLimit).get(),
        ]);
        const cloudEntries = mapCloudPairsAndAliasesToLog({
          pairs: dnmSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<DoNotMergePairDoc, 'id'>) })),
          aliases: aliasSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<EntityAliasDoc, 'id'>) })),
        });
        const merged = mergeDuplicateLogSources(
          readLocalDuplicateClearanceLog(),
          cloudEntries,
          safeLimit,
        );
        return {
          view: 'duplicate_log',
          items: [],
          duplicateLog: merged,
          nextCursor: null,
          totalMatching: merged.length,
        };
      }

      let query: FirebaseFirestore.Query = db.collection('bhajans');
      if (params.view === 'missing_lyrics') {
        query = query.where('lyricsMissing', '==', true).orderBy('updatedAt', 'desc');
      } else if (params.view === 'needs_verification') {
        query = query.where('matchStatus', '==', 'needs_verification').orderBy('updatedAt', 'desc');
      } else {
        const ySnap = await db
          .collection('youtubeVideos')
          .where('classification', '==', 'ambiguous_long')
          .limit(safeLimit)
          .get();
        const linkedIds = new Set<string>();
        for (const ydoc of ySnap.docs) {
          const ydata = ydoc.data() as Partial<YouTubeVideoProvenanceDoc>;
          if (ydata.excluded) continue;
          for (const bid of ydata.linkedBhajanIds ?? [`yt_${ydoc.id}`]) {
            linkedIds.add(bid);
          }
        }
        const fetched: Bhajan[] = [];
        for (const bid of linkedIds) {
          const bSnap = await db.collection('bhajans').doc(bid).get();
          if (bSnap.exists) {
            fetched.push(parseBhajanRecord(bSnap.id, bSnap.data() ?? {}));
          }
        }
        return {
          view: 'ambiguous_long',
          items: fetched,
          nextCursor: null,
          totalMatching: fetched.length,
        };
      }

      if (params.cursor) {
        const cursorSnap = await db.collection('bhajans').doc(params.cursor).get();
        if (cursorSnap.exists) {
          query = query.startAfter(cursorSnap);
        }
      }

      const fetchLimit =
        params.view === 'missing_lyrics' ? Math.min(100, safeLimit * 3) : safeLimit + 1;
      const snap = await query.limit(fetchLimit).get();
      let rawDocs = snap.docs;
      let items = rawDocs.map((doc) => parseBhajanRecord(doc.id, doc.data()));
      if (params.view === 'missing_lyrics') {
        const filteredPairs = rawDocs
          .map((doc, idx) => ({ doc, item: items[idx] }))
          .filter(({ item }) => !isSpecialOrInstrumentalTrack(item));
        rawDocs = filteredPairs.map((p) => p.doc);
        items = filteredPairs.map((p) => p.item);
      }
      const hasMore = items.length > safeLimit;
      const pagedDocs = rawDocs.slice(0, safeLimit);
      const pagedItems = items.slice(0, safeLimit);
      const nextCursor = hasMore && pagedDocs.length > 0 ? pagedDocs[pagedDocs.length - 1].id : null;
      return {
        view: params.view,
        items: pagedItems,
        nextCursor,
        totalMatching: pagedItems.length,
      };
    }

    // Cloud REST mode with verified Admin Firebase ID token
    const idToken = params.idToken;
    if (!idToken) {
      throw new Error('Admin Bearer ID token is required for cloud curation queries.');
    }

    if (params.view === 'runs') {
      const rows = await restRunQuery(
        {
          from: [{ collectionId: 'ingestionRuns' }],
          orderBy: [{ field: { fieldPath: 'startedAt' }, direction: 'DESCENDING' }],
          limit: safeLimit,
        },
        idToken,
      );
      const runs = rows.map((r) => ({
        runId: r.id,
        ...(r.fields as Omit<IngestionRunDoc, 'runId'>),
      }));
      return {
        view: 'runs',
        items: [],
        runs,
        nextCursor: null,
        totalMatching: runs.length,
      };
    }

    if (params.view === 'duplicate_log') {
      const [dnmRows, aliasRows] = await Promise.all([
        restListCollection('doNotMergePairs', idToken, safeLimit),
        restListCollection('entityAliases', idToken, safeLimit),
      ]);
      const cloudEntries = mapCloudPairsAndAliasesToLog({
        pairs: dnmRows.map((r) => ({ id: r.id, ...(r.fields as Omit<DoNotMergePairDoc, 'id'>) })),
        aliases: aliasRows.map((r) => ({ id: r.id, ...(r.fields as Omit<EntityAliasDoc, 'id'>) })),
      });
      const merged = mergeDuplicateLogSources(
        readLocalDuplicateClearanceLog(),
        cloudEntries,
        safeLimit,
      );
      return {
        view: 'duplicate_log',
        items: [],
        duplicateLog: merged,
        nextCursor: null,
        totalMatching: merged.length,
      };
    }

    if (params.view === 'ambiguous_long') {
      const yRows = await restRunQuery(
        {
          from: [{ collectionId: 'youtubeVideos' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'classification' },
              op: 'EQUAL',
              value: { stringValue: 'ambiguous_long' },
            },
          },
          limit: safeLimit,
        },
        idToken,
      );
      const linkedIds = new Set<string>();
      for (const yRow of yRows) {
        const ydata = yRow.fields as Partial<YouTubeVideoProvenanceDoc>;
        if (ydata.excluded) continue;
        for (const bid of ydata.linkedBhajanIds ?? [`yt_${yRow.id}`]) {
          linkedIds.add(bid);
        }
      }
      const fetched = (
        await Promise.all(
          Array.from(linkedIds).map(async (bid) => {
            const fields = await restGetDoc('bhajans', bid, idToken);
            return fields ? parseBhajanRecord(bid, fields) : null;
          }),
        )
      ).filter((b): b is Bhajan => b !== null);
      return {
        view: 'ambiguous_long',
        items: fetched,
        nextCursor: null,
        totalMatching: fetched.length,
      };
    }

    const fieldPath = params.view === 'missing_lyrics' ? 'lyricsMissing' : 'matchStatus';
    const filterValue =
      params.view === 'missing_lyrics'
        ? { booleanValue: true }
        : { stringValue: 'needs_verification' };

    const fetchLimit =
      params.view === 'missing_lyrics' ? Math.min(100, safeLimit * 3) : safeLimit;
    let rows: Array<{ id: string; fields: Record<string, unknown> }>;
    try {
      rows = await restRunQuery(
        {
          from: [{ collectionId: 'bhajans' }],
          where: {
            fieldFilter: {
              field: { fieldPath },
              op: 'EQUAL',
              value: filterValue,
            },
          },
          orderBy: [{ field: { fieldPath: 'updatedAt' }, direction: 'DESCENDING' }],
          limit: fetchLimit,
        },
        idToken,
      );
    } catch {
      rows = await restRunQuery(
        {
          from: [{ collectionId: 'bhajans' }],
          where: {
            fieldFilter: {
              field: { fieldPath },
              op: 'EQUAL',
              value: filterValue,
            },
          },
          limit: fetchLimit,
        },
        idToken,
      );
    }

    let items = rows.map((r) => parseBhajanRecord(r.id, r.fields));
    if (params.view === 'missing_lyrics') {
      items = items.filter((b) => !isSpecialOrInstrumentalTrack(b));
    }
    items = items
      .sort((a, b) => ((a.updatedAt || '') < (b.updatedAt || '') ? 1 : -1))
      .slice(0, safeLimit);

    return {
      view: params.view,
      items,
      nextCursor: null,
      totalMatching: items.length,
    };
  }

  // Local fallback store mode
  if (params.view === 'runs') {
    const runs = readLocalJson<IngestionRunDoc[]>('curation-runs.json', []).sort((a, b) =>
      a.startedAt < b.startedAt ? 1 : -1,
    );
    return {
      view: 'runs',
      items: [],
      runs: runs.slice(0, safeLimit),
      nextCursor: null,
      totalMatching: runs.length,
    };
  }

  if (params.view === 'duplicate_log') {
    const dnmMap = readLocalJson<Record<string, DoNotMergePairDoc>>('curation-do-not-merge.json', {});
    const aliasMap = readLocalJson<Record<string, EntityAliasDoc>>('curation-aliases.json', {});
    const jsonFallback = mapCloudPairsAndAliasesToLog({
      pairs: Object.values(dnmMap),
      aliases: Object.values(aliasMap),
    });
    const merged = mergeDuplicateLogSources(
      readLocalDuplicateClearanceLog(),
      jsonFallback,
      safeLimit,
    );
    return {
      view: 'duplicate_log',
      items: [],
      duplicateLog: merged,
      nextCursor: null,
      totalMatching: merged.length,
    };
  }

  const { catalog } = getMergedCatalog();
  const localYoutubeDocs = readLocalJson<Record<string, YouTubeVideoProvenanceDoc>>(
    'curation-youtube-videos.json',
    {},
  );
  const ambiguousIds = new Set<string>();
  for (const ydoc of Object.values(localYoutubeDocs)) {
    if (ydoc.classification === 'ambiguous_long' && !ydoc.excluded) {
      for (const bid of ydoc.linkedBhajanIds ?? [`yt_${ydoc.videoId}`]) {
        ambiguousIds.add(bid);
      }
    }
  }

  const matching = filterBhajansByView(catalog.bhajans, params.view, ambiguousIds);
  const startIdx = params.cursor
    ? Math.max(
        0,
        matching.findIndex((b) => b.id === params.cursor) + 1,
      )
    : 0;
  const page = matching.slice(startIdx, startIdx + safeLimit);
  const nextCursor = startIdx + safeLimit < matching.length ? page[page.length - 1]?.id ?? null : null;

  return {
    view: params.view,
    items: page,
    nextCursor,
    totalMatching: matching.length,
  };
}

export async function executeCurationAction(
  payload: CurationActionPayload & { reviewerEmail: string; idToken?: string | null },
): Promise<{
  ok: true;
  action: CurationActionPayload['action'];
  bhajan?: Bhajan;
  aliasId?: string;
  doNotMergeKey?: string;
  revisionId?: string;
}> {
  const now = utcNowIso();
  const reviewer = payload.reviewerEmail || 'pschax@gmail.com';
  const cloudMode = hasCloudConfig();

  if (cloudMode) {
    const db = getAdminFirestore();

    if (db) {
      if (payload.action === 'approve_merge') {
        if (!payload.sourceBhajanId || !payload.targetBhajanId || payload.sourceBhajanId === payload.targetBhajanId) {
          throw new Error('Distinct sourceBhajanId and targetBhajanId are required for approve_merge.');
        }
        const sourceRef = db.collection('bhajans').doc(payload.sourceBhajanId);
        const targetRef = db.collection('bhajans').doc(payload.targetBhajanId);
        let aliasId: string | undefined;
        let mergedTarget: Bhajan | undefined;
        let logEntry: DuplicateClearanceLogEntry | undefined;

        await db.runTransaction(async (tx) => {
          const [sourceSnap, targetSnap] = await Promise.all([tx.get(sourceRef), tx.get(targetRef)]);
          if (!sourceSnap.exists) throw new Error(`Source bhajan not found: ${payload.sourceBhajanId}`);
          if (!targetSnap.exists) throw new Error(`Target bhajan not found: ${payload.targetBhajanId}`);

          const source = parseBhajanRecord(sourceSnap.id, sourceSnap.data() ?? {});
          const target = parseBhajanRecord(targetSnap.id, targetSnap.data() ?? {});
          const prep = prepareApproveMergeData({ source, target, payload, reviewer, now });

          mergedTarget = prep.nextTarget;
          logEntry = prep.logEntry;

          tx.set(targetRef, prep.targetPatch, { merge: true });

          if (prep.aliasDoc) {
            aliasId = prep.aliasDoc.id;
            tx.set(db.collection('entityAliases').doc(aliasId), prep.aliasDoc);
          }

          if (payload.videoId) {
            const yRef = db.collection('youtubeVideos').doc(payload.videoId);
            const ySnap = await tx.get(yRef);
            if (ySnap.exists) {
              const linked = (ySnap.data()?.linkedBhajanIds as string[] | undefined) ?? [];
              const updatedLinked = Array.from(
                new Set(
                  linked
                    .filter((id) => id !== payload.sourceBhajanId)
                    .concat(payload.targetBhajanId),
                ),
              );
              tx.update(yRef, { linkedBhajanIds: updatedLinked, lastVerifiedAt: now });
            }
          }

          tx.delete(sourceRef);
        });

        if (logEntry) appendDuplicateClearanceLog(logEntry);
        invalidateCloudCatalogCaches();
        return { ok: true, action: 'approve_merge', bhajan: mergedTarget, aliasId };
      }

      if (payload.action === 'keep_distinct') {
        const pairKey = makeDoNotMergeKey(payload.sourceBhajanId, payload.candidateBhajanId);
        const sourceRef = db.collection('bhajans').doc(payload.sourceBhajanId);
        const pairRef = db.collection('doNotMergePairs').doc(pairKey);
        let updatedSource: Bhajan | undefined;
        let logEntry: DuplicateClearanceLogEntry | undefined;

        await db.runTransaction(async (tx) => {
          const sourceSnap = await tx.get(sourceRef);
          if (!sourceSnap.exists) throw new Error(`Bhajan not found: ${payload.sourceBhajanId}`);
          const source = parseBhajanRecord(sourceSnap.id, sourceSnap.data() ?? {});
          const prep = prepareKeepDistinctData({ source, payload, reviewer, now });

          updatedSource = prep.updatedSource;
          logEntry = prep.logEntry;

          tx.set(pairRef, prep.pairDoc);
          tx.update(sourceRef, {
            matchCandidates: prep.nextCandidates,
            matchStatus: prep.nextStatus,
            updatedAt: now,
          });
        });

        if (logEntry) appendDuplicateClearanceLog(logEntry);
        invalidateCloudCatalogCaches();
        return { ok: true, action: 'keep_distinct', bhajan: updatedSource, doNotMergeKey: pairKey };
      }

      if (payload.action === 'publish_curated') {
        const ref = db.collection('bhajans').doc(payload.bhajanId);
        const snap = await ref.get();
        if (!snap.exists) {
          throw new Error(`Bhajan not found: ${payload.bhajanId}`);
        }
        const existing = parseBhajanRecord(snap.id, snap.data() ?? {});
        const { fields, revId, revision } = preparePublishCuratedData({
          existing,
          payload,
          reviewer,
          now,
        });

        const batch = db.batch();
        batch.set(ref, fields, { merge: true });
        batch.set(ref.collection('revisions').doc(revId), revision);
        await batch.commit();

        invalidateCloudCatalogCaches();
        const refreshed = await getBhajanDetail(existing.id);
        return {
          ok: true,
          action: 'publish_curated',
          bhajan: refreshed ?? existing,
          revisionId: revId,
        };
      }

      // exclude_non_bhajan
      if (!payload.reason?.trim()) {
        throw new Error('A non-empty exclusion reason is required.');
      }
      const batch = db.batch();
      if (payload.videoId) {
        batch.set(
          db.collection('youtubeVideos').doc(payload.videoId),
          {
            excluded: true,
            exclusionReason: payload.reason.trim(),
            lastVerifiedAt: now,
          },
          { merge: true },
        );
      }
      batch.delete(db.collection('bhajans').doc(payload.bhajanId));
      await batch.commit();
      invalidateCloudCatalogCaches();
      return { ok: true, action: 'exclude_non_bhajan' };
    }

    // Cloud REST mode with verified Admin Firebase ID token
    const idToken = payload.idToken;
    if (!idToken) {
      throw new Error('Admin Bearer ID token is required for cloud curation actions.');
    }

    if (payload.action === 'approve_merge') {
      if (!payload.sourceBhajanId || !payload.targetBhajanId || payload.sourceBhajanId === payload.targetBhajanId) {
        throw new Error('Distinct sourceBhajanId and targetBhajanId are required for approve_merge.');
      }
      const [sourceFields, targetFields] = await Promise.all([
        restGetDoc('bhajans', payload.sourceBhajanId, idToken),
        restGetDoc('bhajans', payload.targetBhajanId, idToken),
      ]);
      if (!sourceFields) throw new Error(`Source bhajan not found: ${payload.sourceBhajanId}`);
      if (!targetFields) throw new Error(`Target bhajan not found: ${payload.targetBhajanId}`);

      const source = parseBhajanRecord(payload.sourceBhajanId, sourceFields);
      const target = parseBhajanRecord(payload.targetBhajanId, targetFields);
      const prep = prepareApproveMergeData({ source, target, payload, reviewer, now });

      await restPatchDoc(
        'bhajans',
        target.id,
        prep.targetPatch,
        idToken,
        Object.keys(prep.targetPatch),
      );

      let aliasId: string | undefined;
      if (prep.aliasDoc) {
        aliasId = prep.aliasDoc.id;
        await restPatchDoc(
          'entityAliases',
          aliasId,
          prep.aliasDoc as unknown as Record<string, unknown>,
          idToken,
        );
      }

      if (payload.videoId) {
        try {
          const yFields = await restGetDoc('youtubeVideos', payload.videoId, idToken);
          if (yFields) {
            const linked = Array.isArray(yFields.linkedBhajanIds)
              ? (yFields.linkedBhajanIds as string[])
              : [];
            const updatedLinked = Array.from(
              new Set(
                linked
                  .filter((id) => id !== payload.sourceBhajanId)
                  .concat(payload.targetBhajanId),
              ),
            );
            await restPatchDoc(
              'youtubeVideos',
              payload.videoId,
              { linkedBhajanIds: updatedLinked, lastVerifiedAt: now },
              idToken,
              ['linkedBhajanIds', 'lastVerifiedAt'],
            );
          }
        } catch (err) {
          logEvent('warn', {
            route: 'curation-store.approve_merge',
            errCode: 'youtube_provenance_update_failed',
            docPath: `youtubeVideos/${payload.videoId}`,
            message: err instanceof Error ? err.message : 'Failed updating youtubeVideos provenance',
          });
        }
      }

      await restDeleteDoc('bhajans', source.id, idToken);
      appendDuplicateClearanceLog(prep.logEntry);
      invalidateCloudCatalogCaches();
      return { ok: true, action: 'approve_merge', bhajan: prep.nextTarget, aliasId };
    }

    if (payload.action === 'keep_distinct') {
      const sourceFields = await restGetDoc('bhajans', payload.sourceBhajanId, idToken);
      if (!sourceFields) throw new Error(`Bhajan not found: ${payload.sourceBhajanId}`);
      const source = parseBhajanRecord(payload.sourceBhajanId, sourceFields);
      const prep = prepareKeepDistinctData({ source, payload, reviewer, now });

      await restPatchDoc(
        'doNotMergePairs',
        prep.pairKey,
        prep.pairDoc as unknown as Record<string, unknown>,
        idToken,
      );
      await restPatchDoc(
        'bhajans',
        source.id,
        {
          matchCandidates: prep.nextCandidates,
          matchStatus: prep.nextStatus,
          updatedAt: now,
        },
        idToken,
        ['matchCandidates', 'matchStatus', 'updatedAt'],
      );

      appendDuplicateClearanceLog(prep.logEntry);
      invalidateCloudCatalogCaches();
      return {
        ok: true,
        action: 'keep_distinct',
        bhajan: prep.updatedSource,
        doNotMergeKey: prep.pairKey,
      };
    }

    if (payload.action === 'publish_curated') {
      const existingFields = await restGetDoc('bhajans', payload.bhajanId, idToken);
      if (!existingFields) throw new Error(`Bhajan not found: ${payload.bhajanId}`);
      const existing = parseBhajanRecord(payload.bhajanId, existingFields);
      const { fields, revId, revision } = preparePublishCuratedData({
        existing,
        payload,
        reviewer,
        now,
      });

      const updateFields = Object.keys(fields).filter((k) => k !== 'createdAt');
      const patchObj: Record<string, unknown> = {};
      for (const k of updateFields) patchObj[k] = fields[k];

      await restPatchDoc('bhajans', existing.id, patchObj, idToken, updateFields);
      await restCreateDoc(
        `bhajans/${existing.id}/revisions`,
        revId,
        revision as unknown as Record<string, unknown>,
        idToken,
      );

      invalidateCloudCatalogCaches();
      const refreshed = await getBhajanDetail(existing.id);
      return {
        ok: true,
        action: 'publish_curated',
        bhajan: refreshed ?? existing,
        revisionId: revId,
      };
    }

    // exclude_non_bhajan via REST
    if (!payload.reason?.trim()) {
      throw new Error('A non-empty exclusion reason is required.');
    }
    if (payload.videoId) {
      const yFields = await restGetDoc('youtubeVideos', payload.videoId, idToken);
      if (yFields) {
        await restPatchDoc(
          'youtubeVideos',
          payload.videoId,
          {
            excluded: true,
            exclusionReason: payload.reason.trim(),
            lastVerifiedAt: now,
          },
          idToken,
          ['excluded', 'exclusionReason', 'lastVerifiedAt'],
        );
      }
    }
    await restDeleteDoc('bhajans', payload.bhajanId, idToken);
    invalidateCloudCatalogCaches();
    return { ok: true, action: 'exclude_non_bhajan' };
  }

  // Local dev fallback implementation (atomic local JSON updates under BHAJAMI_DATA_DIR)
  const localOverrides = readLocalJson<Record<string, CloudApprovedOverride>>(
    'approved-overrides.json',
    {},
  );
  const newBhajans = readLocalJson<Bhajan[]>('approved-new-bhajans.json', []);
  const deletedIds = new Set(readLocalJson<string[]>('curation-deleted-ids.json', []));

  if (payload.action === 'approve_merge') {
    if (!payload.sourceBhajanId || !payload.targetBhajanId || payload.sourceBhajanId === payload.targetBhajanId) {
      throw new Error('Distinct sourceBhajanId and targetBhajanId are required for approve_merge.');
    }
    const source = await getBhajanDetail(payload.sourceBhajanId);
    const target = await getBhajanDetail(payload.targetBhajanId);
    if (!source) throw new Error(`Source bhajan not found: ${payload.sourceBhajanId}`);
    if (!target) throw new Error(`Target bhajan not found: ${payload.targetBhajanId}`);

    const prep = prepareApproveMergeData({ source, target, payload, reviewer, now });

    const existingOv = localOverrides[target.id];
    const nextOv: CloudApprovedOverride = {
      ...existingOv,
      ...prep.ov,
      addedRecordings: undefined,
      gentsPitch: prep.nextTarget.gentsPitch ?? undefined,
      ladiesPitch: prep.nextTarget.ladiesPitch ?? undefined,
    };
    localOverrides[target.id] = nextOv;
    writeLocalJson('approved-overrides.json', localOverrides);

    deletedIds.add(source.id);
    writeLocalJson('curation-deleted-ids.json', Array.from(deletedIds));

    let aliasId: string | undefined;
    if (prep.aliasDoc) {
      aliasId = prep.aliasDoc.id;
      const aliases = readLocalJson<Record<string, EntityAliasDoc>>('curation-aliases.json', {});
      aliases[aliasId] = prep.aliasDoc;
      writeLocalJson('curation-aliases.json', aliases);
    }

    if (payload.videoId) {
      const yDocs = readLocalJson<Record<string, YouTubeVideoProvenanceDoc>>(
        'curation-youtube-videos.json',
        {},
      );
      if (yDocs[payload.videoId]) {
        yDocs[payload.videoId] = {
          ...yDocs[payload.videoId],
          linkedBhajanIds: Array.from(
            new Set(
              (yDocs[payload.videoId].linkedBhajanIds ?? [])
                .filter((id) => id !== source.id)
                .concat(target.id),
            ),
          ),
          lastVerifiedAt: now,
        };
        writeLocalJson('curation-youtube-videos.json', yDocs);
      }
    }

    appendDuplicateClearanceLog(prep.logEntry);
    const updatedTarget = await getBhajanDetail(target.id);
    return {
      ok: true,
      action: 'approve_merge',
      bhajan: updatedTarget ?? prep.nextTarget,
      aliasId,
    };
  }

  if (payload.action === 'keep_distinct') {
    const source = await getBhajanDetail(payload.sourceBhajanId);
    if (!source) throw new Error(`Bhajan not found: ${payload.sourceBhajanId}`);
    const prep = prepareKeepDistinctData({ source, payload, reviewer, now });

    const pairs = readLocalJson<Record<string, DoNotMergePairDoc>>('curation-do-not-merge.json', {});
    pairs[prep.pairKey] = prep.pairDoc;
    writeLocalJson('curation-do-not-merge.json', pairs);

    const existingOv = localOverrides[source.id];
    localOverrides[source.id] = {
      ...existingOv,
      bhajanId: source.id,
      matchCandidates: prep.nextCandidates,
      matchStatus: prep.nextStatus,
      updatedAt: now,
    };
    writeLocalJson('approved-overrides.json', localOverrides);

    appendDuplicateClearanceLog(prep.logEntry);
    const updated = await getBhajanDetail(source.id);
    return {
      ok: true,
      action: 'keep_distinct',
      bhajan: updated ?? prep.updatedSource,
      doNotMergeKey: prep.pairKey,
    };
  }

  if (payload.action === 'publish_curated') {
    const existing = await getBhajanDetail(payload.bhajanId);
    if (!existing) throw new Error(`Bhajan not found: ${payload.bhajanId}`);
    const { ov: baseOv, revId, revision } = preparePublishCuratedData({
      existing,
      payload,
      reviewer,
      now,
    });
    const meta = payload.metadata ?? {};
    const existingOv = localOverrides[existing.id];
    const nextOv: CloudApprovedOverride = {
      ...existingOv,
      ...baseOv,
      gentsPitch: meta.gentsPitchRaw
        ? parsePitchStringOptional(meta.gentsPitchRaw) ?? undefined
        : existing.gentsPitch ?? undefined,
      ladiesPitch: meta.ladiesPitchRaw
        ? parsePitchStringOptional(meta.ladiesPitchRaw) ?? undefined
        : existing.ladiesPitch ?? undefined,
    };
    localOverrides[existing.id] = nextOv;
    writeLocalJson('approved-overrides.json', localOverrides);

    const newIdx = newBhajans.findIndex((b) => b.id === existing.id);
    if (newIdx >= 0) {
      const updatedEntry: Bhajan = {
        ...newBhajans[newIdx],
        title: nextOv.title || newBhajans[newIdx].title,
        deity: nextOv.deity,
        language: nextOv.language,
        beat: nextOv.beat,
        tempo: nextOv.tempo,
        meaning: nextOv.meaning,
        raga: nextOv.raga,
        gentsPitch: nextOv.gentsPitch,
        ladiesPitch: nextOv.ladiesPitch,
        firstLineNotes: nextOv.firstLineNotes,
        lyricsSets: nextOv.lyricsSets ?? [],
        lyricsMissing: nextOv.lyricsMissing,
        isEstimated: false,
        matchStatus: 'verified',
        matchCandidates: [],
        bhajamiOverride: true,
        updatedAt: now,
      };
      updatedEntry.missingFields = getMissingBhajanFields(updatedEntry);
      newBhajans[newIdx] = updatedEntry;
      writeLocalJson('approved-new-bhajans.json', newBhajans);
    }

    const revisions = readLocalJson<BhajanRevision[]>('revisions-store.json', []);
    revisions.unshift(revision);
    writeLocalJson('revisions-store.json', revisions);

    const updated = await getBhajanDetail(existing.id);
    return { ok: true, action: 'publish_curated', bhajan: updated ?? existing, revisionId: revId };
  }

  // exclude_non_bhajan
  if (!payload.reason?.trim()) {
    throw new Error('A non-empty exclusion reason is required.');
  }
  deletedIds.add(payload.bhajanId);
  writeLocalJson('curation-deleted-ids.json', Array.from(deletedIds));

  if (payload.videoId) {
    const yDocs = readLocalJson<Record<string, YouTubeVideoProvenanceDoc>>(
      'curation-youtube-videos.json',
      {},
    );
    yDocs[payload.videoId] = {
      ...(yDocs[payload.videoId] ?? {
        videoId: payload.videoId,
        channelId: '',
        rawTitle: payload.bhajanId,
        rawDescription: '',
        cleanedTitle: payload.bhajanId,
        durationSec: 0,
        publishedAt: now,
        classification: 'single',
        embeddable: true,
        linkedBhajanIds: [],
        ingestedAt: now,
      }),
      excluded: true,
      exclusionReason: payload.reason.trim(),
      lastVerifiedAt: now,
    };
    writeLocalJson('curation-youtube-videos.json', yDocs);
  }
  return { ok: true, action: 'exclude_non_bhajan' };
}

export function safeLogCurationError(message: string, errCode: string): void {
  logEvent('error', {
    route: '/api/admin/curation',
    errCode,
    httpStatus: 500,
    message,
  });
}
