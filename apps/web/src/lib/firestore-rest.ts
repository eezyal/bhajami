import {
  getMissingBhajanFields,
  parsePitchStringOptional,
  type AudioSubmissionInfo,
  type Bhajan,
  type BhajanIndexEntry,
  type BhajanRevision,
  type CatalogIndexShardDoc,
  type CatalogMetaDoc,
  type LyricCorrection,
  type MatchCandidate,
  type MatchStatus,
  type MissingFieldKey,
  type PitchInfo,
  type ProposedMetadataPatch,
  type RagaInfo,
  type RecordingSource,
  type SubmissionType,
} from '@bhajami/shared';
import { logEvent } from './logger';

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'saibhajanverse';
const API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '';
const BASE_DOC_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

export function hasCloudConfig(): boolean {
  return (
    Boolean(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    ) && process.env.DISABLE_CLOUD_FIRESTORE_SYNC !== '1'
  );
}

function isCloudSyncDisabled(): boolean {
  return !hasCloudConfig();
}

export interface CloudApprovedOverride {
  bhajanId: string;
  slug?: string;
  title?: string;
  language?: string;
  lyricsSets?: Bhajan['lyricsSets'];
  glossary?: Bhajan['glossary'];
  meaning?: string;
  deity?: string;
  beat?: string;
  tala?: string;
  tempo?: string;
  raga?: RagaInfo;
  ragaName?: string;
  arohanam?: string;
  avarohanam?: string;
  gentsPitchRaw?: string;
  ladiesPitchRaw?: string;
  gentsPitch?: PitchInfo;
  ladiesPitch?: PitchInfo;
  firstLineNotes?: Bhajan['firstLineNotes'];
  notesRange?: string;
  sheetMusicUrl?: string;
  sourceUrl?: string;
  recordings?: RecordingSource[];
  addedRecordings?: RecordingSource[];
  isEstimated?: boolean;
  lyricsMissing?: boolean;
  matchStatus?: MatchStatus;
  matchCandidates?: MatchCandidate[];
  missingFields?: MissingFieldKey[];
  slugAliases?: string[];
  metadataSource?: Bhajan['metadataSource'];
  bhajamiOverride?: boolean;
  bhajamiNewBhajan?: boolean;
  isNewBhajan?: boolean;
  createdAt?: string;
  updatedAt: string;
}

export type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

export function toFirestoreValue(val: unknown): FirestoreValue {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === 'boolean') {
    return { booleanValue: val };
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return { nullValue: null };
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') {
    return { stringValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => toFirestoreValue(item)) } };
  }
  if (typeof val === 'object') {
    return { mapValue: { fields: toFirestoreFields(val as Record<string, unknown>) } };
  }
  return { stringValue: String(val) };
}

export function toFirestoreFields(obj: Record<string, unknown>): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    fields[k] = toFirestoreValue(v);
  }
  return fields;
}

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

export const ALLOWED_META_KEYS = new Set([
  'title',
  'deity',
  'raga',
  'ragaName',
  'arohanam',
  'avarohanam',
  'tala',
  'beat',
  'tempo',
  'gentsPitchRaw',
  'ladiesPitchRaw',
  'pitch',
  'firstLineSargam',
  'firstLineWestern',
  'notesRange',
  'sheetMusicUrl',
  'language',
  'category',
  'meaning',
  'notes',
]);

export function sanitizeProposedMetadata(
  meta: ProposedMetadataPatch | undefined,
): Record<string, string | number> | null {
  if (!meta) return null;
  const cleaned: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!ALLOWED_META_KEYS.has(k)) continue;
    if (k === 'tempo' && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 500) {
      cleaned[k] = v;
      continue;
    }
    if (typeof v === 'string' && v.trim() !== '') {
      cleaned[k] = v.trim();
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

function sanitizeAudioSubmission(
  audio: AudioSubmissionInfo | null | undefined,
): Record<string, unknown> | null {
  if (!audio || typeof audio.url !== 'string' || !audio.url.trim()) return null;
  const out: Record<string, unknown> = {
    url: audio.url.trim(),
    label: (audio.label || 'Community Audio Recording').trim(),
  };
  if (typeof audio.mimeType === 'string' && audio.mimeType.trim()) {
    out.mimeType = audio.mimeType.trim();
  }
  if (typeof audio.durationSec === 'number' && Number.isFinite(audio.durationSec)) {
    out.durationSec = audio.durationSec;
  }
  if (audio.sourceKind === 'uploaded_file' || audio.sourceKind === 'external_url') {
    out.sourceKind = audio.sourceKind;
  }
  return out;
}

export function buildRuleCompliantCorrectionFields(
  c: LyricCorrection,
  hasAuthToken: boolean,
): Record<string, unknown> {
  return {
    bhajanId: c.bhajanId,
    bhajanTitle: c.bhajanTitle,
    submissionType: c.submissionType || 'lyric_correction',
    script: c.script,
    alternateScriptKind: c.alternateScriptKind ?? null,
    originalLyrics: c.originalLyrics,
    proposedLyrics: c.proposedLyrics,
    proposedMetadata: sanitizeProposedMetadata(c.proposedMetadata),
    audioSubmission: sanitizeAudioSubmission(c.audioSubmission),
    reasonOrSource: c.reasonOrSource,
    submitterUid: hasAuthToken && c.submitterUid ? c.submitterUid : null,
    submitterName: c.submitterName,
    submitterEmail: c.submitterEmail,
    status: c.status,
    createdAt: c.createdAt,
    reviewedAt: c.reviewedAt ?? null,
    reviewedBy: c.reviewedBy ?? null,
    reviewNote: c.reviewNote ?? null,
    infoRequestedAt: c.infoRequestedAt ?? null,
    infoRequestNote: c.infoRequestNote ?? null,
    contributorReply: c.contributorReply ?? null,
    contributorRepliedAt: c.contributorRepliedAt ?? null,
  };
}

function mergeRecordingArrays(
  existing: RecordingSource[] | undefined,
  added: RecordingSource[] | undefined,
): RecordingSource[] {
  const base = existing ?? [];
  if (!added || added.length === 0) return base;
  const seenKeys = new Set(added.map((r) => r.externalUrl || r.localPath || r.id));
  const seenIds = new Set(added.map((r) => r.id));
  const filtered = base.filter(
    (r) => !seenKeys.has(r.externalUrl || r.localPath || r.id) && !seenIds.has(r.id),
  );
  return [...added, ...filtered];
}

/**
 * Produces canonical Firestore `bhajans/{id}` document fields matching `isValidBhajan`
 * in `firestore.rules` identically across Admin SDK and REST writes.
 */
export function buildCanonicalBhajanFields(
  ov: CloudApprovedOverride,
  existingBhajan?: Bhajan | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: ov.bhajanId,
    slug: ov.slug || existingBhajan?.slug || ov.bhajanId,
    title: ov.title || existingBhajan?.title || ov.bhajanId,
    bhajamiOverride: ov.bhajamiOverride ?? true,
    updatedAt: ov.updatedAt,
  };

  if (ov.isNewBhajan || ov.bhajamiNewBhajan) {
    out.bhajamiNewBhajan = true;
    out.metadataSource = ov.metadataSource ?? existingBhajan?.metadataSource ?? 'community_contributed';
    if (ov.createdAt || existingBhajan?.createdAt) {
      out.createdAt = ov.createdAt ?? existingBhajan?.createdAt;
    }
  } else if (ov.metadataSource) {
    out.metadataSource = ov.metadataSource;
  }

  const language = ov.language ?? existingBhajan?.language;
  if (language) out.language = language;

  const deity = ov.deity ?? existingBhajan?.deity;
  if (deity) out.deity = deity;

  const beat = ov.beat ?? existingBhajan?.beat;
  if (beat) out.beat = beat;

  const tala = ov.tala ?? existingBhajan?.tala;
  if (tala) out.tala = tala;

  const tempo = ov.tempo ?? existingBhajan?.tempo;
  if (tempo) out.tempo = tempo;

  const meaning = ov.meaning ?? existingBhajan?.meaning;
  if (meaning) out.meaning = meaning;

  const notesRange = ov.notesRange ?? existingBhajan?.notesRange;
  if (notesRange) out.notesRange = notesRange;

  const sheetMusicUrl = ov.sheetMusicUrl ?? existingBhajan?.sheetMusicUrl;
  if (sheetMusicUrl) out.sheetMusicUrl = sheetMusicUrl;

  const sourceUrl = ov.sourceUrl ?? existingBhajan?.sourceUrl;
  if (sourceUrl) out.sourceUrl = sourceUrl;

  const mergedRagaName = ov.raga?.name ?? ov.ragaName ?? existingBhajan?.raga?.name;
  const mergedArohanam = ov.raga?.arohanam ?? ov.arohanam ?? existingBhajan?.raga?.arohanam;
  const mergedAvarohanam = ov.raga?.avarohanam ?? ov.avarohanam ?? existingBhajan?.raga?.avarohanam;
  const mergedWesternInC = ov.raga?.westernInC ?? existingBhajan?.raga?.westernInC;
  if (mergedRagaName || mergedArohanam || mergedAvarohanam || mergedWesternInC) {
    const ragaMap: RagaInfo = {
      name: mergedRagaName || 'Unspecified',
    };
    if (mergedArohanam) ragaMap.arohanam = mergedArohanam;
    if (mergedAvarohanam) ragaMap.avarohanam = mergedAvarohanam;
    if (mergedWesternInC) ragaMap.westernInC = mergedWesternInC;
    out.raga = ragaMap;
  }

  const gentsPitch =
    ov.gentsPitch ??
    parsePitchStringOptional(ov.gentsPitchRaw) ??
    existingBhajan?.gentsPitch ??
    undefined;
  const gentsRaw = ov.gentsPitchRaw ?? gentsPitch?.raw ?? existingBhajan?.gentsPitchRaw;
  if (gentsPitch) out.gentsPitch = gentsPitch;
  if (gentsRaw) out.gentsPitchRaw = gentsRaw;

  const ladiesPitch =
    ov.ladiesPitch ??
    parsePitchStringOptional(ov.ladiesPitchRaw) ??
    existingBhajan?.ladiesPitch ??
    undefined;
  const ladiesRaw = ov.ladiesPitchRaw ?? ladiesPitch?.raw ?? existingBhajan?.ladiesPitchRaw;
  if (ladiesPitch) out.ladiesPitch = ladiesPitch;
  if (ladiesRaw) out.ladiesPitchRaw = ladiesRaw;

  const mergedSargam = ov.firstLineNotes?.sargam ?? existingBhajan?.firstLineNotes?.sargam;
  const mergedWestern = ov.firstLineNotes?.westernInC ?? existingBhajan?.firstLineNotes?.westernInC;
  if (mergedSargam || mergedWestern) {
    const notesObj: NonNullable<Bhajan['firstLineNotes']> = {};
    if (mergedSargam) notesObj.sargam = mergedSargam;
    if (mergedWestern) notesObj.westernInC = mergedWestern;
    out.firstLineNotes = notesObj;
  }

  const lyricsSets = ov.lyricsSets ?? existingBhajan?.lyricsSets;
  if (lyricsSets) out.lyricsSets = lyricsSets;

  const glossary = ov.glossary ?? existingBhajan?.glossary;
  if (glossary) out.glossary = glossary;

  const mergedRecordings = ov.recordings
    ? mergeRecordingArrays(ov.recordings, ov.addedRecordings)
    : mergeRecordingArrays(existingBhajan?.recordings, ov.addedRecordings);
  if (mergedRecordings.length > 0 || ov.isNewBhajan || ov.bhajamiNewBhajan) {
    out.recordings = mergedRecordings;
  }
  if (ov.addedRecordings?.length) {
    out.addedRecordings = ov.addedRecordings;
  }

  if (typeof ov.isEstimated === 'boolean') out.isEstimated = ov.isEstimated;
  if (typeof ov.lyricsMissing === 'boolean') out.lyricsMissing = ov.lyricsMissing;
  if (ov.matchStatus) out.matchStatus = ov.matchStatus;
  if (ov.matchCandidates) out.matchCandidates = ov.matchCandidates;
  if (ov.slugAliases) out.slugAliases = ov.slugAliases;

  const candidateForMissing: Partial<Bhajan> = {
    ...existingBhajan,
    id: ov.bhajanId,
    title: String(out.title),
    deity: (out.deity as string | undefined) ?? null,
    language: (out.language as string | undefined) ?? null,
    raga: (out.raga as RagaInfo | undefined) ?? null,
    beat: (out.beat as string | undefined) ?? null,
    tempo: (out.tempo as string | undefined) ?? null,
    gentsPitch: (out.gentsPitch as PitchInfo | undefined) ?? null,
    ladiesPitch: (out.ladiesPitch as PitchInfo | undefined) ?? null,
    firstLineNotes: (out.firstLineNotes as Bhajan['firstLineNotes']) ?? null,
    meaning: (out.meaning as string | undefined) ?? null,
    lyricsSets: (out.lyricsSets as Bhajan['lyricsSets'] | undefined) ?? [],
    lyricsMissing: out.lyricsMissing as boolean | undefined,
    isEstimated: out.isEstimated as boolean | undefined,
  };
  out.missingFields = ov.missingFields ?? getMissingBhajanFields(candidateForMissing);

  return out;
}

function parseCorrectionFields(id: string, parsed: Record<string, unknown>): LyricCorrection {
  const rawAudio =
    parsed.audioSubmission && typeof parsed.audioSubmission === 'object'
      ? (parsed.audioSubmission as Record<string, unknown>)
      : null;

  return {
    id,
    bhajanId: String(parsed.bhajanId ?? ''),
    bhajanTitle: String(parsed.bhajanTitle ?? ''),
    submissionType: (parsed.submissionType as SubmissionType) ?? 'lyric_correction',
    script: String(parsed.script ?? 'Roman'),
    alternateScriptKind:
      typeof parsed.alternateScriptKind === 'string' ? parsed.alternateScriptKind : undefined,
    originalLyrics: Array.isArray(parsed.originalLyrics)
      ? (parsed.originalLyrics as string[])
      : [],
    proposedLyrics: Array.isArray(parsed.proposedLyrics)
      ? (parsed.proposedLyrics as string[])
      : [],
    proposedMetadata:
      parsed.proposedMetadata && typeof parsed.proposedMetadata === 'object'
        ? (parsed.proposedMetadata as ProposedMetadataPatch)
        : undefined,
    audioSubmission:
      rawAudio && typeof rawAudio.url === 'string'
        ? {
            url: rawAudio.url,
            label: typeof rawAudio.label === 'string' ? rawAudio.label : 'Community Audio',
            mimeType: typeof rawAudio.mimeType === 'string' ? rawAudio.mimeType : undefined,
            durationSec:
              typeof rawAudio.durationSec === 'number' ? rawAudio.durationSec : undefined,
            sourceKind:
              rawAudio.sourceKind === 'uploaded_file' ? 'uploaded_file' : 'external_url',
          }
        : null,
    reasonOrSource: String(parsed.reasonOrSource ?? ''),
    submitterName: String(parsed.submitterName ?? ''),
    submitterEmail: String(parsed.submitterEmail ?? ''),
    submitterUid: typeof parsed.submitterUid === 'string' ? parsed.submitterUid : null,
    status: (parsed.status as LyricCorrection['status']) ?? 'pending',
    createdAt: String(parsed.createdAt ?? ''),
    reviewedAt: typeof parsed.reviewedAt === 'string' ? parsed.reviewedAt : null,
    reviewedBy: typeof parsed.reviewedBy === 'string' ? parsed.reviewedBy : null,
    reviewNote: typeof parsed.reviewNote === 'string' ? parsed.reviewNote : null,
    infoRequestedAt: typeof parsed.infoRequestedAt === 'string' ? parsed.infoRequestedAt : null,
    infoRequestNote: typeof parsed.infoRequestNote === 'string' ? parsed.infoRequestNote : null,
    contributorReply:
      typeof parsed.contributorReply === 'string' ? parsed.contributorReply : null,
    contributorRepliedAt:
      typeof parsed.contributorRepliedAt === 'string' ? parsed.contributorRepliedAt : null,
  };
}

export function parseBhajanRecord(bhajanId: string, fields: Record<string, unknown>): Bhajan {
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

  const rawNotes =
    fields.firstLineNotes && typeof fields.firstLineNotes === 'object'
      ? (fields.firstLineNotes as Bhajan['firstLineNotes'])
      : null;

  const baseRecordings = Array.isArray(fields.recordings)
    ? (fields.recordings as RecordingSource[])
    : [];
  const addedRecs = Array.isArray(fields.addedRecordings)
    ? (fields.addedRecordings as RecordingSource[])
    : [];

  return {
    id: bhajanId,
    slug: typeof fields.slug === 'string' ? fields.slug : bhajanId,
    title: typeof fields.title === 'string' ? fields.title : bhajanId,
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
    firstLineNotes: rawNotes,
    notesRange: typeof fields.notesRange === 'string' ? fields.notesRange : null,
    meaning: typeof fields.meaning === 'string' ? fields.meaning : null,
    lyricsSets: Array.isArray(fields.lyricsSets) ? (fields.lyricsSets as Bhajan['lyricsSets']) : [],
    glossary: Array.isArray(fields.glossary) ? (fields.glossary as Bhajan['glossary']) : [],
    recordings: mergeRecordingArrays(baseRecordings, addedRecs),
    addedRecordings: addedRecs.length ? addedRecs : undefined,
    sheetMusicUrl: typeof fields.sheetMusicUrl === 'string' ? fields.sheetMusicUrl : null,
    sourceUrl: typeof fields.sourceUrl === 'string' ? fields.sourceUrl : null,
    metadataSource:
      typeof fields.metadataSource === 'string'
        ? (fields.metadataSource as Bhajan['metadataSource'])
        : 'community_contributed',
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
    slugAliases: Array.isArray(fields.slugAliases)
      ? (fields.slugAliases as string[])
      : undefined,
    bhajamiOverride: fields.bhajamiOverride === true ? true : undefined,
    bhajamiNewBhajan: fields.bhajamiNewBhajan === true ? true : undefined,
    createdAt: typeof fields.createdAt === 'string' ? fields.createdAt : undefined,
    updatedAt: typeof fields.updatedAt === 'string' ? fields.updatedAt : undefined,
  };
}

function parseOverrideFromFields(
  bhajanId: string,
  fields: Record<string, unknown>,
): CloudApprovedOverride {
  const ragaObj =
    fields.raga && typeof fields.raga === 'object' ? (fields.raga as Record<string, unknown>) : null;
  const legacyRagaName =
    typeof fields.ragaName === 'string'
      ? fields.ragaName
      : typeof fields.raga === 'string'
        ? fields.raga
        : undefined;

  return {
    bhajanId,
    slug: typeof fields.slug === 'string' ? fields.slug : undefined,
    title: typeof fields.title === 'string' ? fields.title : undefined,
    language: typeof fields.language === 'string' ? fields.language : undefined,
    lyricsSets: Array.isArray(fields.lyricsSets)
      ? (fields.lyricsSets as Bhajan['lyricsSets'])
      : undefined,
    glossary: Array.isArray(fields.glossary)
      ? (fields.glossary as Bhajan['glossary'])
      : undefined,
    meaning: typeof fields.meaning === 'string' ? fields.meaning : undefined,
    deity: typeof fields.deity === 'string' ? fields.deity : undefined,
    beat: typeof fields.beat === 'string' ? fields.beat : undefined,
    tala: typeof fields.tala === 'string' ? fields.tala : undefined,
    tempo:
      typeof fields.tempo === 'string' || typeof fields.tempo === 'number'
        ? String(fields.tempo)
        : undefined,
    raga: ragaObj
      ? {
          name: typeof ragaObj.name === 'string' ? ragaObj.name : legacyRagaName || 'Unspecified',
          arohanam: typeof ragaObj.arohanam === 'string' ? ragaObj.arohanam : undefined,
          avarohanam: typeof ragaObj.avarohanam === 'string' ? ragaObj.avarohanam : undefined,
          westernInC: typeof ragaObj.westernInC === 'string' ? ragaObj.westernInC : undefined,
        }
      : legacyRagaName
        ? { name: legacyRagaName }
        : undefined,
    gentsPitchRaw: typeof fields.gentsPitchRaw === 'string' ? fields.gentsPitchRaw : undefined,
    ladiesPitchRaw: typeof fields.ladiesPitchRaw === 'string' ? fields.ladiesPitchRaw : undefined,
    gentsPitch:
      fields.gentsPitch && typeof fields.gentsPitch === 'object'
        ? (fields.gentsPitch as PitchInfo)
        : undefined,
    ladiesPitch:
      fields.ladiesPitch && typeof fields.ladiesPitch === 'object'
        ? (fields.ladiesPitch as PitchInfo)
        : undefined,
    firstLineNotes:
      fields.firstLineNotes && typeof fields.firstLineNotes === 'object'
        ? (fields.firstLineNotes as Bhajan['firstLineNotes'])
        : undefined,
    notesRange: typeof fields.notesRange === 'string' ? fields.notesRange : undefined,
    sheetMusicUrl: typeof fields.sheetMusicUrl === 'string' ? fields.sheetMusicUrl : undefined,
    sourceUrl: typeof fields.sourceUrl === 'string' ? fields.sourceUrl : undefined,
    recordings: Array.isArray(fields.recordings)
      ? (fields.recordings as RecordingSource[])
      : undefined,
    addedRecordings: Array.isArray(fields.addedRecordings)
      ? (fields.addedRecordings as RecordingSource[])
      : undefined,
    isEstimated: typeof fields.isEstimated === 'boolean' ? fields.isEstimated : undefined,
    lyricsMissing: typeof fields.lyricsMissing === 'boolean' ? fields.lyricsMissing : undefined,
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
    slugAliases: Array.isArray(fields.slugAliases)
      ? (fields.slugAliases as string[])
      : undefined,
    metadataSource:
      typeof fields.metadataSource === 'string'
        ? (fields.metadataSource as Bhajan['metadataSource'])
        : undefined,
    bhajamiOverride: typeof fields.bhajamiOverride === 'boolean' ? fields.bhajamiOverride : undefined,
    isNewBhajan: fields.bhajamiNewBhajan === true ? true : undefined,
    bhajamiNewBhajan: fields.bhajamiNewBhajan === true ? true : undefined,
    createdAt: typeof fields.createdAt === 'string' ? fields.createdAt : undefined,
    updatedAt: typeof fields.updatedAt === 'string' ? fields.updatedAt : new Date().toISOString(),
  };
}

function withKey(url: string): string {
  if (!API_KEY) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}key=${encodeURIComponent(API_KEY)}`;
}

let cachedCloudOverrides: Record<string, CloudApprovedOverride> | null = null;
let cachedAt = 0;

export function invalidateCloudCatalogCaches(): void {
  cachedCloudOverrides = null;
  cachedAt = 0;
}

export function invalidateCloudOverridesCache(): void {
  invalidateCloudCatalogCaches();
}

export async function createCloudCorrection(
  correction: LyricCorrection,
  idToken?: string | null,
): Promise<boolean> {
  if (isCloudSyncDisabled()) return false;
  try {
    const url = withKey(
      `${BASE_DOC_URL}/lyricCorrections?documentId=${encodeURIComponent(correction.id)}`,
    );
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idToken) headers.Authorization = `Bearer ${idToken}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fields: toFirestoreFields(buildRuleCompliantCorrectionFields(correction, Boolean(idToken))),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logEvent('error', {
        route: 'firestore-rest.createCloudCorrection',
        errCode: 'firestore_http_error',
        httpStatus: res.status,
        docPath: `lyricCorrections/${correction.id}`,
        message: `Failed creating lyricCorrection via REST: HTTP ${res.status}`,
      });
    }
    return res.ok;
  } catch (err) {
    logEvent('error', {
      route: 'firestore-rest.createCloudCorrection',
      errCode: 'firestore_fetch_failed',
      docPath: `lyricCorrections/${correction.id}`,
      message: err instanceof Error ? err.message : 'Network error creating lyricCorrection',
    });
    return false;
  }
}

export async function fetchCloudCorrectionById(
  id: string,
  idToken: string,
): Promise<LyricCorrection | null> {
  if (!idToken || isCloudSyncDisabled()) return null;
  try {
    const url = withKey(`${BASE_DOC_URL}/lyricCorrections/${encodeURIComponent(id)}`);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      logEvent('warn', {
        route: 'firestore-rest.fetchCloudCorrectionById',
        errCode: 'firestore_http_error',
        httpStatus: res.status,
        docPath: `lyricCorrections/${id}`,
        message: `HTTP ${res.status} reading lyricCorrection`,
      });
      return null;
    }
    const doc = (await res.json()) as { name?: string; fields?: Record<string, FirestoreValue> };
    if (!doc.fields) return null;
    const docId = doc.name?.split('/').pop() || id;
    return parseCorrectionFields(docId, fromFirestoreFields(doc.fields));
  } catch (err) {
    logEvent('warn', {
      route: 'firestore-rest.fetchCloudCorrectionById',
      errCode: 'firestore_fetch_failed',
      docPath: `lyricCorrections/${id}`,
      message: err instanceof Error ? err.message : 'Error reading lyricCorrection',
    });
    return null;
  }
}

export async function fetchCloudCorrections(
  idToken: string,
  options?: { submitterUid?: string },
): Promise<LyricCorrection[]> {
  if (!idToken || isCloudSyncDisabled()) return [];

  try {
    if (options?.submitterUid) {
      const url = withKey(`${BASE_DOC_URL}:runQuery`);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'lyricCorrections' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'submitterUid' },
                op: 'EQUAL',
                value: { stringValue: options.submitterUid },
              },
            },
            limit: 200,
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        logEvent('warn', {
          route: 'firestore-rest.fetchCloudCorrections',
          errCode: 'firestore_http_error',
          httpStatus: res.status,
          docPath: 'lyricCorrections',
          message: `Scoped query failed with HTTP ${res.status}`,
        });
        return [];
      }
      const rows = (await res.json()) as Array<{
        document?: { name: string; fields?: Record<string, FirestoreValue> };
      }>;
      return rows
        .filter((r) => Boolean(r.document?.fields))
        .map((r) => {
          const docId = r.document!.name.split('/').pop() || '';
          return parseCorrectionFields(docId, fromFirestoreFields(r.document!.fields));
        });
    }

    const collected: LyricCorrection[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({ pageSize: '200' });
      if (pageToken) params.set('pageToken', pageToken);
      const url = withKey(`${BASE_DOC_URL}/lyricCorrections?${params.toString()}`);
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${idToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        logEvent('warn', {
          route: 'firestore-rest.fetchCloudCorrections',
          errCode: 'firestore_http_error',
          httpStatus: res.status,
          docPath: 'lyricCorrections',
          message: `Paginated list failed with HTTP ${res.status}`,
        });
        break;
      }
      const data = (await res.json()) as {
        documents?: Array<{ name: string; fields?: Record<string, FirestoreValue> }>;
        nextPageToken?: string;
      };
      for (const doc of data.documents ?? []) {
        const docId = doc.name.split('/').pop() || '';
        collected.push(parseCorrectionFields(docId, fromFirestoreFields(doc.fields)));
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return collected;
  } catch (err) {
    logEvent('error', {
      route: 'firestore-rest.fetchCloudCorrections',
      errCode: 'firestore_fetch_failed',
      docPath: 'lyricCorrections',
      message: err instanceof Error ? err.message : 'Error listing lyricCorrections',
    });
    return [];
  }
}

export async function publishCloudDecision(params: {
  updated: LyricCorrection;
  bhajanTitle: string;
  override?: CloudApprovedOverride;
  existingBhajan?: Bhajan | null;
  revision?: BhajanRevision;
  idToken: string;
}): Promise<boolean> {
  if (!params.idToken || isCloudSyncDisabled()) return false;
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${params.idToken}`,
  };

  try {
    const corrUrl = withKey(
      `${BASE_DOC_URL}/lyricCorrections/${encodeURIComponent(params.updated.id)}`,
    );
    const corrRes = await fetch(corrUrl, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        fields: toFirestoreFields(
          buildRuleCompliantCorrectionFields(params.updated, Boolean(params.updated.submitterUid)),
        ),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!corrRes.ok) {
      logEvent('error', {
        route: 'firestore-rest.publishCloudDecision',
        errCode: 'correction_patch_failed',
        httpStatus: corrRes.status,
        docPath: `lyricCorrections/${params.updated.id}`,
        message: `Failed updating lyricCorrection: HTTP ${corrRes.status}`,
      });
      return false;
    }

    if (params.updated.status === 'approved' && params.override) {
      const ov = params.override;
      const existing = params.existingBhajan ?? (await fetchBhajanById(ov.bhajanId));
      const canonicalObj = buildCanonicalBhajanFields(
        {
          ...ov,
          title: ov.title || params.bhajanTitle,
        },
        existing,
      );

      const maskQuery = Object.keys(canonicalObj)
        .map((fieldPath) => `updateMask.fieldPaths=${encodeURIComponent(fieldPath)}`)
        .join('&');
      const bhajanUrl = withKey(
        `${BASE_DOC_URL}/bhajans/${encodeURIComponent(ov.bhajanId)}?${maskQuery}`,
      );
      const bhajanRes = await fetch(bhajanUrl, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ fields: toFirestoreFields(canonicalObj) }),
        signal: AbortSignal.timeout(5000),
      });
      if (!bhajanRes.ok) {
        logEvent('error', {
          route: 'firestore-rest.publishCloudDecision',
          errCode: 'bhajan_patch_failed',
          httpStatus: bhajanRes.status,
          docPath: `bhajans/${ov.bhajanId}`,
          message: `Failed updating canonical bhajan: HTTP ${bhajanRes.status}`,
        });
        return false;
      }

      if (params.revision) {
        const rev = params.revision;
        const revUrl = withKey(
          `${BASE_DOC_URL}/bhajans/${encodeURIComponent(ov.bhajanId)}/revisions?documentId=${encodeURIComponent(rev.id)}`,
        );
        const revRes = await fetch(revUrl, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            fields: toFirestoreFields({
              id: rev.id,
              bhajanId: rev.bhajanId,
              correctionId: rev.correctionId,
              previousLyrics: rev.previousLyrics,
              newLyrics: rev.newLyrics,
              script: rev.script,
              contributorName: rev.contributorName,
              approvedBy: rev.approvedBy,
              approvedAt: rev.approvedAt,
            }),
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!revRes.ok) {
          logEvent('error', {
            route: 'firestore-rest.publishCloudDecision',
            errCode: 'revision_create_failed',
            httpStatus: revRes.status,
            docPath: `bhajans/${ov.bhajanId}/revisions/${rev.id}`,
            message: `Failed creating bhajan revision: HTTP ${revRes.status}`,
          });
          return false;
        }
      }

      invalidateCloudCatalogCaches();
    }

    return true;
  } catch (err) {
    logEvent('error', {
      route: 'firestore-rest.publishCloudDecision',
      errCode: 'firestore_decision_failed',
      docPath: `lyricCorrections/${params.updated.id}`,
      message: err instanceof Error ? err.message : 'Error publishing cloud moderation decision',
    });
    return false;
  }
}

export async function fetchCloudApprovedOverrides(): Promise<
  Record<string, CloudApprovedOverride>
> {
  if (isCloudSyncDisabled()) {
    return {};
  }
  if (cachedCloudOverrides && Date.now() - cachedAt < 5000) {
    return cachedCloudOverrides;
  }

  try {
    const map: Record<string, CloudApprovedOverride> = {};
    let lastDocName: string | null = null;
    const BATCH_LIMIT = 500;

    for (let page = 0; page < 40; page++) {
      const structuredQuery: Record<string, unknown> = {
        from: [{ collectionId: 'bhajans' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'bhajamiOverride' },
            op: 'EQUAL',
            value: { booleanValue: true },
          },
        },
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        limit: BATCH_LIMIT,
      };
      if (lastDocName) {
        structuredQuery.startAt = {
          values: [{ referenceValue: lastDocName }],
          before: false,
        };
      }

      const url = withKey(`${BASE_DOC_URL}:runQuery`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ structuredQuery }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        logEvent('warn', {
          route: 'firestore-rest.fetchCloudApprovedOverrides',
          errCode: 'firestore_http_error',
          httpStatus: res.status,
          docPath: 'bhajans',
          message: `Failed querying approved overrides (page ${page}): HTTP ${res.status}`,
        });
        return Object.keys(map).length > 0 ? map : cachedCloudOverrides ?? {};
      }

      const rows = (await res.json()) as Array<{
        document?: { name: string; fields?: Record<string, FirestoreValue> };
      }>;

      let count = 0;
      for (const row of rows) {
        if (!row.document?.fields) continue;
        count++;
        lastDocName = row.document.name;
        const bhajanId = row.document.name.split('/').pop() || '';
        if (!bhajanId) continue;
        const fields = fromFirestoreFields(row.document.fields);
        map[bhajanId] = parseOverrideFromFields(bhajanId, fields);
      }

      if (count < BATCH_LIMIT) break;
    }

    cachedCloudOverrides = map;
    cachedAt = Date.now();
    return map;
  } catch (err) {
    logEvent('error', {
      route: 'firestore-rest.fetchCloudApprovedOverrides',
      errCode: 'firestore_fetch_failed',
      docPath: 'bhajans',
      message: err instanceof Error ? err.message : 'Error loading cloud approved overrides',
    });
    return cachedCloudOverrides ?? {};
  }
}

export async function fetchCatalogMeta(): Promise<CatalogMetaDoc | null> {
  if (isCloudSyncDisabled()) return null;
  try {
    const url = withKey(`${BASE_DOC_URL}/catalogMeta/latest`);
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (res.status === 404) return null;
    if (!res.ok) {
      logEvent('warn', {
        route: 'firestore-rest.fetchCatalogMeta',
        errCode: 'firestore_http_error',
        httpStatus: res.status,
        docPath: 'catalogMeta/latest',
        message: `HTTP ${res.status} fetching catalogMeta/latest`,
      });
      return null;
    }
    const doc = (await res.json()) as { fields?: Record<string, FirestoreValue> };
    if (!doc.fields) return null;
    const parsed = fromFirestoreFields(doc.fields);
    if (
      typeof parsed.version !== 'number' ||
      !Array.isArray(parsed.shardIds) ||
      !parsed.stats ||
      typeof parsed.stats !== 'object'
    ) {
      return null;
    }
    return {
      version: parsed.version,
      totalBhajans: typeof parsed.totalBhajans === 'number' ? parsed.totalBhajans : 0,
      indexHash: typeof parsed.indexHash === 'string' ? parsed.indexHash : '',
      shardIds: parsed.shardIds as string[],
      stats: parsed.stats as CatalogMetaDoc['stats'],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch (err) {
    logEvent('warn', {
      route: 'firestore-rest.fetchCatalogMeta',
      errCode: 'firestore_fetch_failed',
      docPath: 'catalogMeta/latest',
      message: err instanceof Error ? err.message : 'Failed reading catalogMeta/latest',
    });
    return null;
  }
}

export async function fetchCatalogIndexShards(
  shardIds: string[],
): Promise<CatalogIndexShardDoc[]> {
  if (isCloudSyncDisabled() || shardIds.length === 0) return [];
  try {
    const docs = await Promise.all(
      shardIds.map(async (shardId) => {
        const url = withKey(`${BASE_DOC_URL}/catalogIndexShards/${encodeURIComponent(shardId)}`);
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) {
          logEvent('warn', {
            route: 'firestore-rest.fetchCatalogIndexShards',
            errCode: 'shard_fetch_failed',
            httpStatus: res.status,
            docPath: `catalogIndexShards/${shardId}`,
            message: `HTTP ${res.status} fetching index shard`,
          });
          return null;
        }
        const doc = (await res.json()) as { fields?: Record<string, FirestoreValue> };
        if (!doc.fields) return null;
        const parsed = fromFirestoreFields(doc.fields);
        return {
          shardId: typeof parsed.shardId === 'string' ? parsed.shardId : shardId,
          version: typeof parsed.version === 'number' ? parsed.version : 1,
          count: typeof parsed.count === 'number' ? parsed.count : 0,
          entries: Array.isArray(parsed.entries) ? (parsed.entries as BhajanIndexEntry[]) : [],
        } satisfies CatalogIndexShardDoc;
      }),
    );
    return docs.filter((d): d is CatalogIndexShardDoc => d !== null);
  } catch (err) {
    logEvent('warn', {
      route: 'firestore-rest.fetchCatalogIndexShards',
      errCode: 'firestore_fetch_failed',
      docPath: 'catalogIndexShards',
      message: err instanceof Error ? err.message : 'Failed reading catalog index shards',
    });
    return [];
  }
}

export async function fetchBhajanById(id: string): Promise<Bhajan | null> {
  if (isCloudSyncDisabled() || !id.trim()) return null;
  try {
    const directUrl = withKey(`${BASE_DOC_URL}/bhajans/${encodeURIComponent(id)}`);
    const res = await fetch(directUrl, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const doc = (await res.json()) as { name?: string; fields?: Record<string, FirestoreValue> };
      if (doc.fields) {
        const docId = doc.name?.split('/').pop() || id;
        return parseBhajanRecord(docId, fromFirestoreFields(doc.fields));
      }
    } else if (res.status !== 404) {
      logEvent('warn', {
        route: 'firestore-rest.fetchBhajanById',
        errCode: 'firestore_http_error',
        httpStatus: res.status,
        docPath: `bhajans/${id}`,
        message: `HTTP ${res.status} fetching bhajan`,
      });
    }

    // Fallback: lookup merged bhajans by legacy slugAliases
    const queryUrl = withKey(`${BASE_DOC_URL}:runQuery`);
    const qRes = await fetch(queryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'bhajans' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'slugAliases' },
              op: 'ARRAY_CONTAINS',
              value: { stringValue: id },
            },
          },
          limit: 1,
        },
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!qRes.ok) return null;
    const rows = (await qRes.json()) as Array<{
      document?: { name: string; fields?: Record<string, FirestoreValue> };
    }>;
    const first = rows.find((r) => Boolean(r.document?.fields))?.document;
    if (!first?.fields) return null;
    const docId = first.name.split('/').pop() || id;
    return parseBhajanRecord(docId, fromFirestoreFields(first.fields));
  } catch (err) {
    logEvent('warn', {
      route: 'firestore-rest.fetchBhajanById',
      errCode: 'firestore_fetch_failed',
      docPath: `bhajans/${id}`,
      message: err instanceof Error ? err.message : 'Error fetching bhajan detail',
    });
    return null;
  }
}
