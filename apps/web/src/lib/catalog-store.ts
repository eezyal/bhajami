import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  getMissingBhajanFields,
  parsePitchString,
  parsePitchStringOptional,
  type Bhajan,
  type BhajanIndexEntry,
  type BhajanRevision,
  type CatalogIndexPayload,
  type CatalogIndexShardDoc,
  type CatalogMetaDoc,
  type CatalogPayload,
  type LyricCorrection,
  type LyricsScriptKind,
  type OutboxEmailRecord,
  type ProposedMetadataPatch,
  type RagaInfo,
  type RecordingSource,
} from '@bhajami/shared';
import { getAdminFirestore } from './firebase-admin';
import {
  buildCanonicalBhajanFields,
  buildRuleCompliantCorrectionFields,
  createCloudCorrection,
  fetchBhajanById,
  fetchCatalogIndexShards,
  fetchCatalogMeta,
  fetchCloudApprovedOverrides,
  fetchCloudCorrectionById,
  fetchCloudCorrections,
  hasCloudConfig,
  invalidateCloudCatalogCaches,
  parseBhajanRecord,
  publishCloudDecision,
  type CloudApprovedOverride,
} from './firestore-rest';
import {
  ADMIN_EMAIL,
  buildCorrectionAdminEmail,
  dispatchAdminCorrectionEmail,
  dispatchContributorApprovalEmail,
  dispatchContributorFollowupEmail,
  dispatchContributorRejectionEmail,
} from './email';
import { logEvent } from './logger';

function resolveDataDir(): string {
  if (process.env.BHAJAMI_DATA_DIR) {
    return path.resolve(process.env.BHAJAMI_DATA_DIR);
  }
  const repoRootWeb = path.resolve(process.cwd(), 'apps/web');
  return fs.existsSync(repoRootWeb)
    ? path.join(repoRootWeb, 'data')
    : path.resolve(process.cwd(), 'data');
}

function resolveCatalogPath(): string {
  const candidates = [
    path.resolve(process.cwd(), '../../packages/shared/data/catalog.json'),
    path.resolve(process.cwd(), 'packages/shared/data/catalog.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

const CATALOG_PATH = resolveCatalogPath();

function getStorePath(filename: string): string {
  return path.join(resolveDataDir(), filename);
}

type ApprovedOverride = CloudApprovedOverride;

function isLocalArchiveEnabled(): boolean {
  return process.env.LOCAL_ARCHIVE_ENABLED === 'true';
}

function sanitizeRecordingsForEnv(recordings: RecordingSource[]): RecordingSource[] {
  if (isLocalArchiveEnabled()) {
    return recordings;
  }
  return recordings
    .filter((rec) => !rec.localPath || Boolean(rec.externalUrl || rec.youtubeVideoId))
    .map((rec) => {
      if (!rec.localPath) return rec;
      const { localPath: _omitted, ...rest } = rec;
      return rest;
    });
}

function sanitizeBhajanForEnv(bhajan: Bhajan): Bhajan {
  const recordings = sanitizeRecordingsForEnv(bhajan.recordings ?? []);
  const computedMissing = bhajan.missingFields ?? getMissingBhajanFields(bhajan);
  return {
    ...bhajan,
    recordings,
    missingFields: computedMissing,
  };
}

function randomSuffix(length = 4): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function ensureDataDir(): void {
  if (hasCloudConfig()) return;
  const dataDir = resolveDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (hasCloudConfig()) return fallback;
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    logEvent('warn', {
      route: 'catalog-store.readJsonFile',
      errCode: 'json_read_failed',
      message: err instanceof Error ? err.message : `Failed reading ${filePath}`,
    });
    return fallback;
  }
}

function writeJsonFile<T>(filePath: string, data: T): void {
  if (hasCloudConfig()) return;
  ensureDataDir();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

let cachedCatalog: CatalogPayload | null = null;
let cachedRecordingMap: Map<string, RecordingSource> | null = null;

export function getRawCatalog(): CatalogPayload {
  if (!cachedCatalog) {
    cachedCatalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as CatalogPayload;
  }
  return cachedCatalog;
}

export function getRecordingById(recordingId: string): RecordingSource | null {
  if (!cachedRecordingMap) {
    cachedRecordingMap = new Map<string, RecordingSource>();
    for (const bhajan of getRawCatalog().bhajans) {
      for (const rec of bhajan.recordings) {
        cachedRecordingMap.set(rec.id, rec);
      }
    }
  }
  return cachedRecordingMap.get(recordingId) ?? null;
}

function ensureInitialPendingSample(): void {
  if (hasCloudConfig()) return;
  if (fs.existsSync(getStorePath('corrections-store.json'))) return;
  const catalog = getRawCatalog();
  const target =
    catalog.bhajans.find((b) => b.id === 'aao-aao-nandalala') || catalog.bhajans[0];
  if (!target) return;

  const original = target.lyricsSets[0]?.lines ?? [target.title];
  const proposed = [...original];
  if (proposed.length > 0) {
    proposed[0] = `${proposed[0]} (Aao Aao Gopaala)`;
  }
  const createdAt = new Date().toISOString();
  const sample: LyricCorrection = {
    id: 'corr_sample_001',
    bhajanId: target.id,
    bhajanTitle: target.title,
    submissionType: 'lyric_correction',
    script: target.lyricsSets[0]?.language || 'Sanskrit / Hindi',
    originalLyrics: original,
    proposedLyrics: proposed,
    proposedMetadata: {
      tempo: target.tempo ?? undefined,
    },
    reasonOrSource:
      'Sample pending submission from Local Audio Sync — verifies opening chorus refrain sung in the A Bhajan A Day recording.',
    submitterName: 'Prasanthi Choir Volunteer',
    submitterEmail: 'choir.volunteer@example.org',
    submitterUid: null,
    status: 'pending',
    createdAt,
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
  };

  const rendered = buildCorrectionAdminEmail(sample);
  sample.emailNotification = {
    to: ADMIN_EMAIL,
    transport: 'local_dev_outbox',
    sentAt: createdAt,
    subject: rendered.subject,
  };

  writeJsonFile<LyricCorrection[]>(getStorePath('corrections-store.json'), [sample]);
  writeJsonFile<OutboxEmailRecord[]>(getStorePath('email-outbox.json'), [
    {
      id: 'mail_sample_001',
      correctionId: sample.id,
      to: ADMIN_EMAIL,
      subject: rendered.subject,
      textBody: rendered.textBody,
      htmlBody: rendered.htmlBody,
      transport: 'local_dev_outbox',
      createdAt,
    },
  ]);
}

export function inferScriptKind(
  lines: string[],
  scriptLabel?: string,
  alternateKind?: string,
): LyricsScriptKind {
  const joined = lines.join('\n');
  if (/[\u0900-\u097F]/.test(joined)) return 'devanagari';
  if (/[\u0C00-\u0C7F]/.test(joined)) return 'telugu';
  if (/[\u0B80-\u0BFF]/.test(joined)) return 'tamil';
  if (/[\u0C80-\u0CFF]/.test(joined)) return 'kannada';
  if (/[\u0D00-\u0D7F]/.test(joined)) return 'malayalam';
  if (/[\u0980-\u09FF]/.test(joined)) return 'bengali';
  if (/[\u0A80-\u0AFF]/.test(joined)) return 'gujarati';
  if (/[\u0B00-\u0B7F]/.test(joined)) return 'odia';
  if (/[\u0A00-\u0A7F]/.test(joined)) return 'gurmukhi';
  if (/[\u0600-\u06FF]/.test(joined)) return 'arabic';
  if (/[\u0400-\u04FF]/.test(joined)) return 'cyrillic';
  if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(joined)) return 'cjk';

  // Detect non-Latin Unicode scripts outside Latin-1 / Latin Extended / IAST blocks
  for (const ch of joined) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      code > 0x024f &&
      !(code >= 0x1e00 && code <= 0x1eff) &&
      !(code >= 0x2000 && code <= 0x206f) &&
      /\p{L}/u.test(ch)
    ) {
      return 'other';
    }
  }

  const combined = `${scriptLabel || ''} ${alternateKind || ''}`.toLowerCase();
  if (
    combined.includes('devanagari') ||
    combined.includes('hindi') ||
    combined.includes('sanskrit') ||
    combined.includes('marathi') ||
    combined.includes('nepali')
  ) {
    return 'devanagari';
  }
  if (combined.includes('telugu')) return 'telugu';
  if (combined.includes('tamil')) return 'tamil';
  if (combined.includes('kannada')) return 'kannada';
  if (combined.includes('malayalam')) return 'malayalam';
  if (combined.includes('bengali')) return 'bengali';
  if (combined.includes('gujarati')) return 'gujarati';
  if (combined.includes('odia') || combined.includes('oriya')) return 'odia';
  if (combined.includes('gurmukhi') || combined.includes('punjabi')) return 'gurmukhi';
  if (combined.includes('arabic') || combined.includes('urdu') || combined.includes('farsi')) {
    return 'arabic';
  }
  if (combined.includes('cyrillic') || combined.includes('russian')) return 'cyrillic';
  if (combined.includes('cjk') || combined.includes('japanese') || combined.includes('chinese')) {
    return 'cjk';
  }
  if (
    combined.includes('korean') ||
    combined.includes('hangul') ||
    combined.includes('thai') ||
    combined.includes('sinhala') ||
    combined.includes('hebrew') ||
    combined.includes('greek')
  ) {
    return 'other';
  }
  return 'roman';
}

function mergeRecordings(
  existing: RecordingSource[],
  added?: RecordingSource[],
): RecordingSource[] {
  if (!added || added.length === 0) return existing;
  const seenKeys = new Set(added.map((r) => r.externalUrl || r.localPath || r.id));
  const seenIds = new Set(added.map((r) => r.id));
  const filtered = existing.filter(
    (r) => !seenKeys.has(r.externalUrl || r.localPath || r.id) && !seenIds.has(r.id),
  );
  return [...added, ...filtered];
}

function buildBhajanFromOverride(ov: ApprovedOverride): Bhajan {
  const gentsPitch =
    ov.gentsPitch ??
    parsePitchStringOptional(ov.gentsPitchRaw) ??
    null;
  const ladiesPitch =
    ov.ladiesPitch ??
    parsePitchStringOptional(ov.ladiesPitchRaw) ??
    null;

  const raga: RagaInfo | null = ov.raga
    ? ov.raga
    : ov.ragaName || ov.arohanam || ov.avarohanam
      ? {
          name: ov.ragaName || 'Unspecified',
          arohanam: ov.arohanam,
          avarohanam: ov.avarohanam,
        }
      : null;

  const candidate: Bhajan = {
    id: ov.bhajanId,
    slug: ov.slug || ov.bhajanId,
    title: ov.title || ov.bhajanId,
    deity: ov.deity ?? null,
    language: ov.language ?? ov.lyricsSets?.[0]?.language ?? null,
    tempo: ov.tempo ?? null,
    beat: ov.beat ?? null,
    tala: ov.tala ?? null,
    raga,
    gentsPitch,
    ladiesPitch,
    gentsPitchRaw: ov.gentsPitchRaw ?? gentsPitch?.raw ?? null,
    ladiesPitchRaw: ov.ladiesPitchRaw ?? ladiesPitch?.raw ?? null,
    firstLineNotes: ov.firstLineNotes ?? null,
    notesRange: ov.notesRange ?? null,
    meaning: ov.meaning ?? null,
    lyricsSets: ov.lyricsSets ?? [],
    glossary: ov.glossary ?? [],
    recordings: ov.recordings ?? ov.addedRecordings ?? [],
    sheetMusicUrl: ov.sheetMusicUrl ?? null,
    sourceUrl: ov.sourceUrl ?? null,
    metadataSource: ov.metadataSource ?? 'community_contributed',
    isEstimated: ov.isEstimated,
    lyricsMissing: ov.lyricsMissing,
    matchStatus: ov.matchStatus ?? 'verified',
    matchCandidates: ov.matchCandidates,
    slugAliases: ov.slugAliases,
    bhajamiOverride: ov.bhajamiOverride,
    bhajamiNewBhajan: ov.bhajamiNewBhajan,
    createdAt: ov.createdAt,
    updatedAt: ov.updatedAt,
  };
  return sanitizeBhajanForEnv(candidate);
}

function applyOverrideOntoBase(base: Bhajan, ov: ApprovedOverride): Bhajan {
  const mergedRaga: RagaInfo | null =
    ov.raga || ov.ragaName || ov.arohanam || ov.avarohanam
      ? {
          name: ov.raga?.name ?? ov.ragaName ?? base.raga?.name ?? 'Unspecified',
          arohanam: ov.raga?.arohanam ?? ov.arohanam ?? base.raga?.arohanam,
          avarohanam: ov.raga?.avarohanam ?? ov.avarohanam ?? base.raga?.avarohanam,
          westernInC: ov.raga?.westernInC ?? base.raga?.westernInC,
        }
      : base.raga ?? null;

  const mergedFirstLineNotes =
    ov.firstLineNotes || base.firstLineNotes
      ? {
          sargam: ov.firstLineNotes?.sargam ?? base.firstLineNotes?.sargam,
          westernInC: ov.firstLineNotes?.westernInC ?? base.firstLineNotes?.westernInC,
        }
      : null;

  const gentsPitch =
    ov.gentsPitch ??
    (ov.gentsPitchRaw
      ? parsePitchString(ov.gentsPitchRaw, base.gentsPitch?.semitoneFromC ?? 2)
      : base.gentsPitch ?? null);
  const ladiesPitch =
    ov.ladiesPitch ??
    (ov.ladiesPitchRaw
      ? parsePitchString(ov.ladiesPitchRaw, base.ladiesPitch?.semitoneFromC ?? 9)
      : base.ladiesPitch ?? null);

  const mergedRecordings = ov.recordings
    ? mergeRecordings(mergeRecordings(base.recordings, ov.recordings), ov.addedRecordings)
    : mergeRecordings(base.recordings, ov.addedRecordings);

  const next: Bhajan = {
    ...base,
    title: ov.title ?? base.title,
    language: ov.language ?? base.language,
    lyricsSets: ov.lyricsSets ?? base.lyricsSets,
    glossary: ov.glossary ?? base.glossary,
    meaning: ov.meaning ?? base.meaning,
    deity: ov.deity ?? base.deity,
    beat: ov.beat ?? base.beat,
    tala: ov.tala ?? base.tala,
    tempo: ov.tempo ?? base.tempo,
    raga: mergedRaga,
    gentsPitch,
    ladiesPitch,
    gentsPitchRaw: ov.gentsPitchRaw ?? gentsPitch?.raw ?? base.gentsPitchRaw,
    ladiesPitchRaw: ov.ladiesPitchRaw ?? ladiesPitch?.raw ?? base.ladiesPitchRaw,
    firstLineNotes: mergedFirstLineNotes,
    notesRange: ov.notesRange ?? base.notesRange,
    sheetMusicUrl: ov.sheetMusicUrl ?? base.sheetMusicUrl,
    sourceUrl: ov.sourceUrl ?? base.sourceUrl,
    recordings: mergedRecordings,
    isEstimated: ov.isEstimated ?? base.isEstimated,
    lyricsMissing: ov.lyricsMissing ?? base.lyricsMissing,
    matchStatus: ov.matchStatus ?? base.matchStatus,
    matchCandidates: ov.matchCandidates ?? base.matchCandidates,
    slugAliases: ov.slugAliases ?? base.slugAliases,
    metadataSource: ov.metadataSource ?? base.metadataSource,
    updatedAt: ov.updatedAt,
  };
  next.missingFields = ov.missingFields ?? getMissingBhajanFields(next);
  return sanitizeBhajanForEnv(next);
}

function applyOverridesToBhajans(
  bhajans: Bhajan[],
  overrides: Record<string, ApprovedOverride>,
  newBhajans: Bhajan[],
): Bhajan[] {
  const existingIds = new Set(bhajans.map((b) => b.id));
  const newById = new Map<string, Bhajan>();
  for (const nb of newBhajans) {
    if (!existingIds.has(nb.id)) {
      newById.set(nb.id, sanitizeBhajanForEnv(nb));
    }
  }
  for (const ov of Object.values(overrides)) {
    if ((ov.isNewBhajan || ov.bhajamiNewBhajan) && !existingIds.has(ov.bhajanId) && !newById.has(ov.bhajanId)) {
      newById.set(ov.bhajanId, buildBhajanFromOverride(ov));
    }
  }

  const combined = [...Array.from(newById.values()), ...bhajans];

  return combined.map((b) => {
    const ov = overrides[b.id];
    if (!ov) return sanitizeBhajanForEnv(b);
    return applyOverrideOntoBase(b, ov);
  });
}

function readLocalDeletedBhajanIds(): Set<string> {
  if (hasCloudConfig()) return new Set();
  const deleted = readJsonFile<string[]>(getStorePath('curation-deleted-ids.json'), []);
  return new Set(deleted);
}

export function getMergedCatalog(): {
  catalog: CatalogPayload;
  pendingCount: number;
} {
  ensureInitialPendingSample();
  const raw = getRawCatalog();
  const overrides = readJsonFile<Record<string, ApprovedOverride>>(getStorePath('approved-overrides.json'), {});
  const newBhajans = readJsonFile<Bhajan[]>(getStorePath('approved-new-bhajans.json'), []);
  const corrections = readJsonFile<LyricCorrection[]>(getStorePath('corrections-store.json'), []);
  const deletedIds = readLocalDeletedBhajanIds();

  const mergedBhajans = applyOverridesToBhajans(raw.bhajans, overrides, newBhajans).filter(
    (b) => !deletedIds.has(b.id),
  );
  const pendingCount = corrections.filter(
    (c) => c.status === 'pending' || c.status === 'info_requested',
  ).length;
  return {
    catalog: {
      ...raw,
      stats: {
        ...raw.stats,
        totalBhajans: mergedBhajans.length,
      },
      bhajans: mergedBhajans,
    },
    pendingCount,
  };
}

async function fetchOverridesFromAdminOrRest(): Promise<Record<string, ApprovedOverride>> {
  const db = getAdminFirestore();
  if (db) {
    try {
      const snap = await db.collection('bhajans').where('bhajamiOverride', '==', true).get();
      const map: Record<string, ApprovedOverride> = {};
      for (const doc of snap.docs) {
        const fields = doc.data();
        const ragaObj =
          fields.raga && typeof fields.raga === 'object' ? (fields.raga as RagaInfo) : undefined;
        map[doc.id] = {
          bhajanId: doc.id,
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
          raga: ragaObj,
          gentsPitchRaw:
            typeof fields.gentsPitchRaw === 'string' ? fields.gentsPitchRaw : undefined,
          ladiesPitchRaw:
            typeof fields.ladiesPitchRaw === 'string' ? fields.ladiesPitchRaw : undefined,
          gentsPitch:
            fields.gentsPitch && typeof fields.gentsPitch === 'object'
              ? (fields.gentsPitch as Bhajan['gentsPitch']) ?? undefined
              : undefined,
          ladiesPitch:
            fields.ladiesPitch && typeof fields.ladiesPitch === 'object'
              ? (fields.ladiesPitch as Bhajan['ladiesPitch']) ?? undefined
              : undefined,
          firstLineNotes:
            fields.firstLineNotes && typeof fields.firstLineNotes === 'object'
              ? (fields.firstLineNotes as Bhajan['firstLineNotes'])
              : undefined,
          notesRange: typeof fields.notesRange === 'string' ? fields.notesRange : undefined,
          sheetMusicUrl:
            typeof fields.sheetMusicUrl === 'string' ? fields.sheetMusicUrl : undefined,
          sourceUrl: typeof fields.sourceUrl === 'string' ? fields.sourceUrl : undefined,
          recordings: Array.isArray(fields.recordings)
            ? (fields.recordings as RecordingSource[])
            : undefined,
          addedRecordings: Array.isArray(fields.addedRecordings)
            ? (fields.addedRecordings as RecordingSource[])
            : undefined,
          isEstimated: typeof fields.isEstimated === 'boolean' ? fields.isEstimated : undefined,
          lyricsMissing:
            typeof fields.lyricsMissing === 'boolean' ? fields.lyricsMissing : undefined,
          matchStatus: fields.matchStatus as Bhajan['matchStatus'],
          matchCandidates: Array.isArray(fields.matchCandidates)
            ? (fields.matchCandidates as Bhajan['matchCandidates'])
            : undefined,
          missingFields: Array.isArray(fields.missingFields)
            ? (fields.missingFields as Bhajan['missingFields'])
            : undefined,
          slugAliases: Array.isArray(fields.slugAliases)
            ? (fields.slugAliases as string[])
            : undefined,
          metadataSource: fields.metadataSource as Bhajan['metadataSource'],
          bhajamiOverride: fields.bhajamiOverride === true ? true : undefined,
          isNewBhajan: fields.bhajamiNewBhajan === true ? true : undefined,
          bhajamiNewBhajan: fields.bhajamiNewBhajan === true ? true : undefined,
          updatedAt:
            typeof fields.updatedAt === 'string' ? fields.updatedAt : new Date().toISOString(),
        };
      }
      return map;
    } catch (err) {
      logEvent('warn', {
        route: 'catalog-store.fetchOverridesFromAdminOrRest',
        errCode: 'admin_firestore_query_failed',
        docPath: 'bhajans',
        message: err instanceof Error ? err.message : 'Admin query failed; falling back to REST',
      });
    }
  }
  return fetchCloudApprovedOverrides();
}

export async function getMergedCatalogWithCloud(): Promise<{
  catalog: CatalogPayload;
  pendingCount: number;
}> {
  const raw = getRawCatalog();

  if (hasCloudConfig()) {
    const cloudOverrides = await fetchOverridesFromAdminOrRest();
    const mergedBhajans = applyOverridesToBhajans(raw.bhajans, cloudOverrides, []);
    let pendingCount = 0;
    const db = getAdminFirestore();
    if (db) {
      try {
        const snap = await db
          .collection('lyricCorrections')
          .where('status', 'in', ['pending', 'info_requested'])
          .count()
          .get();
        pendingCount = snap.data().count;
      } catch {
        pendingCount = 0;
      }
    }
    return {
      catalog: {
        ...raw,
        stats: {
          ...raw.stats,
          totalBhajans: mergedBhajans.length,
        },
        bhajans: mergedBhajans,
      },
      pendingCount,
    };
  }

  ensureInitialPendingSample();
  const localOverrides = readJsonFile<Record<string, ApprovedOverride>>(getStorePath('approved-overrides.json'), {});
  const newBhajans = readJsonFile<Bhajan[]>(getStorePath('approved-new-bhajans.json'), []);
  const cloudOverrides = await fetchCloudApprovedOverrides();
  const mergedOverrides: Record<string, ApprovedOverride> = {
    ...localOverrides,
    ...cloudOverrides,
  };
  const corrections = readJsonFile<LyricCorrection[]>(getStorePath('corrections-store.json'), []);

  const mergedBhajans = applyOverridesToBhajans(raw.bhajans, mergedOverrides, newBhajans);
  const pendingCount = corrections.filter(
    (c) => c.status === 'pending' || c.status === 'info_requested',
  ).length;
  return {
    catalog: {
      ...raw,
      stats: {
        ...raw.stats,
        totalBhajans: mergedBhajans.length,
      },
      bhajans: mergedBhajans,
    },
    pendingCount,
  };
}

function projectBhajanToIndexEntry(bhajan: Bhajan): BhajanIndexEntry {
  const firstTwoLines = bhajan.lyricsSets?.[0]?.lines?.slice(0, 2).join(' ') ?? '';
  const searchRaw = [bhajan.title, bhajan.deity ?? '', bhajan.raga?.name ?? '', firstTwoLines]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const phoneticTokens = Array.from(
    new Set(
      bhajan.title
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean),
    ),
  );
  return {
    id: bhajan.id,
    slug: bhajan.slug,
    title: bhajan.title,
    deity: bhajan.deity ?? undefined,
    language: bhajan.language ?? undefined,
    ragaName: bhajan.raga?.name ?? undefined,
    beat: bhajan.beat ?? undefined,
    gentsPitchRaw: bhajan.gentsPitchRaw ?? bhajan.gentsPitch?.raw ?? undefined,
    ladiesPitchRaw: bhajan.ladiesPitchRaw ?? bhajan.ladiesPitch?.raw ?? undefined,
    searchText: searchRaw.slice(0, 240),
    phoneticTokens,
    lyricsMissing: bhajan.lyricsMissing === true,
    matchStatus:
      bhajan.matchStatus ??
      (bhajan.metadataSource === 'sairhythms_verified' ? 'verified' : 'verified'),
    missingFields: bhajan.missingFields ?? getMissingBhajanFields(bhajan),
    recordingCount: bhajan.recordings?.length ?? 0,
    metadataSource: bhajan.metadataSource,
    slugAliases: bhajan.slugAliases,
    updatedAt: bhajan.updatedAt,
  };
}

export async function getCatalogIndex(): Promise<CatalogIndexPayload & { pendingCount: number }> {
  if (hasCloudConfig()) {
    const db = getAdminFirestore();
    let meta: CatalogMetaDoc | null = null;
    let shards: CatalogIndexShardDoc[] = [];

    if (db) {
      try {
        const metaSnap = await db.collection('catalogMeta').doc('latest').get();
        if (metaSnap.exists) {
          meta = metaSnap.data() as CatalogMetaDoc;
          if (Array.isArray(meta.shardIds) && meta.shardIds.length > 0) {
            const shardDocs = await Promise.all(
              meta.shardIds.map((sid) => db.collection('catalogIndexShards').doc(sid).get()),
            );
            shards = shardDocs
              .filter((d) => d.exists)
              .map((d) => d.data() as CatalogIndexShardDoc);
          }
        }
      } catch (err) {
        logEvent('warn', {
          route: 'catalog-store.getCatalogIndex',
          errCode: 'admin_shard_read_failed',
          docPath: 'catalogMeta/latest',
          message: err instanceof Error ? err.message : 'Admin shard read failed',
        });
      }
    } else {
      meta = await fetchCatalogMeta();
      if (meta && meta.shardIds.length > 0) {
        shards = await fetchCatalogIndexShards(meta.shardIds);
      }
    }

    if (meta && shards.length > 0 && shards.length === meta.shardIds.length) {
      const entries = shards.flatMap((s) => s.entries ?? []);
      return {
        generatedAt: meta.updatedAt,
        version: meta.version,
        stats: meta.stats,
        entries,
        pendingCount: 0,
      };
    }
  }

  // Fallback projection from local catalog.json + merged overrides before Phase 3 populates shards
  const { catalog, pendingCount } = await getMergedCatalogWithCloud();
  return {
    generatedAt: catalog.generatedAt,
    version: 0,
    stats: catalog.stats,
    entries: catalog.bhajans.map(projectBhajanToIndexEntry),
    pendingCount,
  };
}

export async function getBhajanDetail(id: string): Promise<Bhajan | null> {
  const cleanId = id.trim();
  if (!cleanId) return null;

  const raw = getRawCatalog();
  const baseMatch =
    raw.bhajans.find((b) => b.id === cleanId || b.slug === cleanId || b.slugAliases?.includes(cleanId)) ??
    null;

  if (hasCloudConfig()) {
    let cloudBhajan: Bhajan | null = null;
    const db = getAdminFirestore();
    if (db) {
      try {
        const directSnap = await db.collection('bhajans').doc(cleanId).get();
        if (directSnap.exists) {
          cloudBhajan = parseBhajanRecord(directSnap.id, directSnap.data() ?? {});
        } else {
          const aliasSnap = await db
            .collection('bhajans')
            .where('slugAliases', 'array-contains', cleanId)
            .limit(1)
            .get();
          if (!aliasSnap.empty) {
            const doc = aliasSnap.docs[0];
            cloudBhajan = parseBhajanRecord(doc.id, doc.data());
          }
        }
      } catch (err) {
        logEvent('warn', {
          route: 'catalog-store.getBhajanDetail',
          errCode: 'admin_bhajan_read_failed',
          docPath: `bhajans/${cleanId}`,
          message: err instanceof Error ? err.message : 'Admin bhajan lookup failed',
        });
      }
    } else {
      cloudBhajan = await fetchBhajanById(cleanId);
    }

    if (cloudBhajan && baseMatch) {
      const overrideObj: CloudApprovedOverride = {
        bhajanId: cloudBhajan.id,
        slug: cloudBhajan.slug,
        title: cloudBhajan.title,
        language: cloudBhajan.language ?? undefined,
        lyricsSets: cloudBhajan.lyricsSets.length > 0 ? cloudBhajan.lyricsSets : undefined,
        glossary: cloudBhajan.glossary.length > 0 ? cloudBhajan.glossary : undefined,
        meaning: cloudBhajan.meaning ?? undefined,
        deity: cloudBhajan.deity ?? undefined,
        beat: cloudBhajan.beat ?? undefined,
        tala: cloudBhajan.tala ?? undefined,
        tempo: cloudBhajan.tempo ?? undefined,
        raga: cloudBhajan.raga ?? undefined,
        gentsPitch: cloudBhajan.gentsPitch ?? undefined,
        ladiesPitch: cloudBhajan.ladiesPitch ?? undefined,
        gentsPitchRaw: cloudBhajan.gentsPitchRaw ?? undefined,
        ladiesPitchRaw: cloudBhajan.ladiesPitchRaw ?? undefined,
        firstLineNotes: cloudBhajan.firstLineNotes ?? undefined,
        notesRange: cloudBhajan.notesRange ?? undefined,
        sheetMusicUrl: cloudBhajan.sheetMusicUrl ?? undefined,
        sourceUrl: cloudBhajan.sourceUrl ?? undefined,
        recordings: cloudBhajan.recordings.length > 0 ? cloudBhajan.recordings : undefined,
        addedRecordings: cloudBhajan.addedRecordings,
        isEstimated: cloudBhajan.isEstimated,
        lyricsMissing: cloudBhajan.lyricsMissing,
        matchStatus: cloudBhajan.matchStatus,
        matchCandidates: cloudBhajan.matchCandidates,
        missingFields: cloudBhajan.missingFields,
        slugAliases: cloudBhajan.slugAliases,
        metadataSource: cloudBhajan.metadataSource,
        updatedAt: cloudBhajan.updatedAt || new Date().toISOString(),
      };
      return applyOverrideOntoBase(baseMatch, overrideObj);
    }

    if (cloudBhajan) {
      return sanitizeBhajanForEnv(cloudBhajan);
    }
    return baseMatch ? sanitizeBhajanForEnv(baseMatch) : null;
  }

  const deletedIds = readLocalDeletedBhajanIds();
  if (deletedIds.has(cleanId)) return null;

  const { catalog } = getMergedCatalog();
  const localMatch =
    catalog.bhajans.find(
      (b) => b.id === cleanId || b.slug === cleanId || b.slugAliases?.includes(cleanId),
    ) ?? null;
  return localMatch ? sanitizeBhajanForEnv(localMatch) : null;
}

export function listCorrections(): LyricCorrection[] {
  if (hasCloudConfig()) return [];
  ensureInitialPendingSample();
  const items = readJsonFile<LyricCorrection[]>(getStorePath('corrections-store.json'), []);
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function listCorrectionsWithCloud(
  idToken?: string | null,
  options?: { submitterUid?: string },
): Promise<LyricCorrection[]> {
  if (hasCloudConfig()) {
    const db = getAdminFirestore();
    if (db) {
      try {
        let query: FirebaseFirestore.Query = db.collection('lyricCorrections');
        if (options?.submitterUid) {
          query = query.where('submitterUid', '==', options.submitterUid);
        }
        const snap = await query.orderBy('createdAt', 'desc').limit(500).get();
        return snap.docs.map((doc) => ({
          id: doc.id,
          ...(doc.data() as Omit<LyricCorrection, 'id'>),
        }));
      } catch (err) {
        logEvent('error', {
          route: 'catalog-store.listCorrectionsWithCloud',
          errCode: 'admin_corrections_query_failed',
          docPath: 'lyricCorrections',
          message: err instanceof Error ? err.message : 'Failed reading lyricCorrections',
        });
      }
    }
    if (!idToken) return [];
    const cloud = await fetchCloudCorrections(idToken, options);
    return cloud.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  const local = listCorrections();
  const scopedLocal = options?.submitterUid
    ? local.filter((c) => c.submitterUid === options.submitterUid)
    : local;
  if (!idToken) return scopedLocal;

  const cloud = await fetchCloudCorrections(idToken, options);
  if (cloud.length === 0) return scopedLocal;

  const byId = new Map<string, LyricCorrection>();
  for (const item of scopedLocal) {
    byId.set(item.id, item);
  }
  for (const cloudItem of cloud) {
    const existing = byId.get(cloudItem.id);
    byId.set(cloudItem.id, {
      ...existing,
      ...cloudItem,
      emailNotification: existing?.emailNotification ?? cloudItem.emailNotification,
    });
  }
  return Array.from(byId.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function listOutboxEmails(): OutboxEmailRecord[] {
  if (hasCloudConfig()) return [];
  ensureInitialPendingSample();
  const items = readJsonFile<OutboxEmailRecord[]>(getStorePath('email-outbox.json'), []);
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function listOutboxEmailsWithCloud(): Promise<OutboxEmailRecord[]> {
  if (!hasCloudConfig()) {
    return listOutboxEmails();
  }
  const db = getAdminFirestore();
  if (!db) return [];
  try {
    const snap = await db.collection('mail').orderBy('createdAt', 'desc').limit(100).get();
    return snap.docs.map((doc) => {
      const data = doc.data();
      const msg = (data.message ?? {}) as { subject?: string; text?: string; html?: string };
      return {
        id: doc.id,
        correctionId: String(data.correctionId ?? ''),
        to: Array.isArray(data.to) ? String(data.to[0] ?? '') : String(data.to ?? ''),
        subject: String(msg.subject ?? ''),
        textBody: String(msg.text ?? ''),
        htmlBody: String(msg.html ?? ''),
        transport: 'firestore_mail_queue',
        createdAt: String(data.createdAt ?? ''),
      };
    });
  } catch (err) {
    logEvent('warn', {
      route: 'catalog-store.listOutboxEmailsWithCloud',
      errCode: 'admin_outbox_query_failed',
      docPath: 'mail',
      message: err instanceof Error ? err.message : 'Failed reading mail collection',
    });
    return [];
  }
}

export function listRevisions(): BhajanRevision[] {
  if (hasCloudConfig()) return [];
  const items = readJsonFile<BhajanRevision[]>(getStorePath('revisions-store.json'), []);
  return items.sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : -1));
}

export async function listRevisionsWithCloud(bhajanId?: string): Promise<BhajanRevision[]> {
  if (!hasCloudConfig()) {
    const items = listRevisions();
    return bhajanId ? items.filter((r) => r.bhajanId === bhajanId) : items;
  }
  const db = getAdminFirestore();
  if (!db) return [];
  try {
    const snap = bhajanId
      ? await db
          .collection('bhajans')
          .doc(bhajanId)
          .collection('revisions')
          .orderBy('approvedAt', 'desc')
          .limit(100)
          .get()
      : await db.collectionGroup('revisions').orderBy('approvedAt', 'desc').limit(100).get();
    return snap.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as Omit<BhajanRevision, 'id'>),
    }));
  } catch (err) {
    logEvent('warn', {
      route: 'catalog-store.listRevisionsWithCloud',
      errCode: 'admin_revisions_query_failed',
      docPath: bhajanId ? `bhajans/${bhajanId}/revisions` : 'revisions',
      message: err instanceof Error ? err.message : 'Failed reading revisions',
    });
    return [];
  }
}

export async function saveNewCorrection(
  correction: LyricCorrection,
  outboxEmail: OutboxEmailRecord,
  idToken?: string | null,
): Promise<void> {
  let firestoreSynced = false;
  const db = getAdminFirestore();
  if (db) {
    try {
      await db
        .collection('lyricCorrections')
        .doc(correction.id)
        .set(buildRuleCompliantCorrectionFields(correction, Boolean(correction.submitterUid)));
      firestoreSynced = true;
    } catch (err) {
      logEvent('error', {
        route: 'catalog-store.saveNewCorrection',
        errCode: 'admin_correction_write_failed',
        docPath: `lyricCorrections/${correction.id}`,
        message: err instanceof Error ? err.message : 'Admin SDK write failed',
      });
      firestoreSynced = false;
    }
  } else if (hasCloudConfig()) {
    firestoreSynced = await createCloudCorrection(correction, idToken);
    if (!firestoreSynced) {
      throw new Error('Failed persisting submission to Cloud Firestore.');
    }
  }

  const transport =
    firestoreSynced && !outboxEmail.transport.includes('firestore')
      ? `${outboxEmail.transport} + firestore_cloud`
      : outboxEmail.transport;

  outboxEmail.transport = transport;
  correction.emailNotification = {
    to: outboxEmail.to,
    transport,
    sentAt: outboxEmail.createdAt,
    subject: outboxEmail.subject,
  };

  if (!hasCloudConfig()) {
    ensureInitialPendingSample();
    const corrections = readJsonFile<LyricCorrection[]>(getStorePath('corrections-store.json'), []);
    corrections.unshift(correction);
    writeJsonFile(getStorePath('corrections-store.json'), corrections);

    const outbox = readJsonFile<OutboxEmailRecord[]>(getStorePath('email-outbox.json'), []);
    outbox.unshift(outboxEmail);
    writeJsonFile(getStorePath('email-outbox.json'), outbox);
  }
}

export function getCorrectionById(id: string): LyricCorrection | null {
  if (hasCloudConfig()) return null;
  ensureInitialPendingSample();
  const items = readJsonFile<LyricCorrection[]>(getStorePath('corrections-store.json'), []);
  return items.find((c) => c.id === id) ?? null;
}

export async function getCorrectionByIdWithCloud(
  id: string,
  idToken?: string | null,
): Promise<LyricCorrection | null> {
  if (!hasCloudConfig()) {
    return getCorrectionById(id);
  }
  const db = getAdminFirestore();
  if (db) {
    try {
      const snap = await db.collection('lyricCorrections').doc(id).get();
      if (!snap.exists) return null;
      return {
        id: snap.id,
        ...(snap.data() as Omit<LyricCorrection, 'id'>),
      };
    } catch (err) {
      logEvent('warn', {
        route: 'catalog-store.getCorrectionByIdWithCloud',
        errCode: 'admin_correction_read_failed',
        docPath: `lyricCorrections/${id}`,
        message: err instanceof Error ? err.message : 'Admin correction read failed',
      });
    }
  }
  if (!idToken) return null;
  return fetchCloudCorrectionById(id, idToken);
}

async function syncCorrectionDecisionToCloud(params: {
  updated: LyricCorrection;
  override?: ApprovedOverride;
  existingBhajan?: Bhajan | null;
  revision?: BhajanRevision;
  idToken?: string | null;
}): Promise<boolean> {
  const { updated, override, existingBhajan, revision, idToken } = params;
  const db = getAdminFirestore();
  if (db) {
    try {
      const batch = db.batch();
      const corrRef = db.collection('lyricCorrections').doc(updated.id);
      batch.set(
        corrRef,
        buildRuleCompliantCorrectionFields(updated, Boolean(updated.submitterUid)),
        { merge: true },
      );
      if (updated.status === 'approved' && override) {
        const bhajanRef = db.collection('bhajans').doc(override.bhajanId);
        const canonicalFields = buildCanonicalBhajanFields(override, existingBhajan);
        batch.set(bhajanRef, canonicalFields, { merge: true });
        if (revision) {
          batch.set(bhajanRef.collection('revisions').doc(revision.id), revision);
        }
      }
      await batch.commit();
      if (updated.status === 'approved') {
        invalidateCloudCatalogCaches();
      }
      return true;
    } catch (err) {
      logEvent('error', {
        route: 'catalog-store.syncCorrectionDecisionToCloud',
        errCode: 'admin_batch_commit_failed',
        docPath: `lyricCorrections/${updated.id}`,
        message: err instanceof Error ? err.message : 'Admin SDK batch commit failed',
      });
      return false;
    }
  }

  if (idToken) {
    return publishCloudDecision({
      updated,
      bhajanTitle: updated.bhajanTitle,
      override,
      existingBhajan,
      revision,
      idToken,
    });
  }
  return !hasCloudConfig();
}

function buildUpdatedLyricsSets(
  current: LyricCorrection,
  existingSets: Bhajan['lyricsSets'],
  finalLyrics: string[],
): Bhajan['lyricsSets'] {
  if (finalLyrics.length === 0) return existingSets;

  if (current.submissionType === 'alternate_lyrics') {
    const label = current.alternateScriptKind
      ? `${current.script} (${current.alternateScriptKind})`
      : current.script || 'Alternate';
    const nextSets = [...existingSets];
    const sameIdx = nextSets.findIndex(
      (ls) => ls.language.toLowerCase() === label.toLowerCase(),
    );
    const altEntry: Bhajan['lyricsSets'][number] = {
      language: label,
      script: inferScriptKind(finalLyrics, current.script, current.alternateScriptKind),
      lines: finalLyrics,
    };
    if (sameIdx >= 0) {
      nextSets[sameIdx] = altEntry;
    } else {
      nextSets.push(altEntry);
    }
    return nextSets;
  }

  if (current.submissionType === 'metadata_addition') {
    const sameAsOriginal =
      finalLyrics.length === current.originalLyrics.length &&
      finalLyrics.every((l, i) => l === current.originalLyrics[i]);
    if (sameAsOriginal) return existingSets;
  }

  const nextSets = [...existingSets];
  const targetIdx = nextSets.findIndex(
    (ls) => ls.language.toLowerCase() === (current.script || 'Roman').toLowerCase(),
  );
  if (targetIdx >= 0) {
    nextSets[targetIdx] = {
      ...nextSets[targetIdx],
      script: inferScriptKind(finalLyrics, current.script, nextSets[targetIdx].script),
      lines: finalLyrics,
    };
  } else {
    nextSets.unshift({
      language: current.script || 'Roman',
      script: inferScriptKind(finalLyrics, current.script),
      lines: finalLyrics,
    });
  }
  return nextSets;
}

function mergeMetadataPatch(
  base?: ProposedMetadataPatch,
  edits?: ProposedMetadataPatch,
): ProposedMetadataPatch | undefined {
  if (!base && !edits) return undefined;
  const merged: ProposedMetadataPatch = { ...(base ?? {}) };
  if (edits) {
    for (const [k, v] of Object.entries(edits)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'string' && !v.trim()) continue;
      (merged as Record<string, unknown>)[k] = typeof v === 'string' ? v.trim() : v;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export async function reviewCorrection(params: {
  id: string;
  action: 'approve' | 'request_info' | 'reject';
  reviewNote?: string;
  editedLyrics?: string[];
  editedMetadata?: ProposedMetadataPatch;
  reviewerEmail?: string;
  idToken?: string | null;
}): Promise<LyricCorrection | null> {
  const cloudMode = hasCloudConfig();
  let corrections: LyricCorrection[] = [];
  let idx = -1;
  let current: LyricCorrection | null = null;

  if (cloudMode) {
    current = await getCorrectionByIdWithCloud(params.id, params.idToken);
    if (!current) return null;
  } else {
    ensureInitialPendingSample();
    corrections = readJsonFile<LyricCorrection[]>(getStorePath('corrections-store.json'), []);
    idx = corrections.findIndex((c) => c.id === params.id);
    if (idx === -1 && params.idToken) {
      const cloudMatch = await fetchCloudCorrectionById(params.id, params.idToken);
      if (cloudMatch) {
        corrections.unshift(cloudMatch);
        idx = 0;
      }
    }
    if (idx === -1) return null;
    current = corrections[idx];
  }

  const now = new Date().toISOString();
  const reviewer = params.reviewerEmail || ADMIN_EMAIL;
  const trimmedNote = params.reviewNote?.trim() || '';

  if (params.action === 'request_info') {
    if (!trimmedNote) {
      throw new Error('Please enter a moderator note or question for the contributor.');
    }
    const updated: LyricCorrection = {
      ...current,
      status: 'info_requested',
      infoRequestedAt: now,
      infoRequestNote: trimmedNote,
      reviewNote: trimmedNote,
      reviewedBy: reviewer,
    };

    if (!cloudMode) {
      corrections[idx] = updated;
      writeJsonFile(getStorePath('corrections-store.json'), corrections);
    }

    const synced = await syncCorrectionDecisionToCloud({
      updated,
      idToken: params.idToken,
    });
    if (cloudMode && !synced) {
      throw new Error('Failed updating submission status in Cloud Firestore.');
    }

    const followupMail = await dispatchContributorFollowupEmail({
      correction: updated,
      questionNote: trimmedNote,
      reviewerEmail: reviewer,
    });
    if (!cloudMode) {
      const outbox = readJsonFile<OutboxEmailRecord[]>(getStorePath('email-outbox.json'), []);
      outbox.unshift(followupMail);
      writeJsonFile(getStorePath('email-outbox.json'), outbox);
    }

    return updated;
  }

  if (params.action === 'reject') {
    if (!trimmedNote) {
      throw new Error('Please enter a reason explaining why this submission is being rejected.');
    }
    const updated: LyricCorrection = {
      ...current,
      status: 'rejected',
      reviewedAt: now,
      reviewedBy: reviewer,
      reviewNote: trimmedNote,
    };

    if (!cloudMode) {
      corrections[idx] = updated;
      writeJsonFile(getStorePath('corrections-store.json'), corrections);
    }

    const synced = await syncCorrectionDecisionToCloud({
      updated,
      idToken: params.idToken,
    });
    if (cloudMode && !synced) {
      throw new Error('Failed rejecting submission in Cloud Firestore.');
    }

    const rejectionMail = await dispatchContributorRejectionEmail({
      correction: updated,
      rejectionReason: trimmedNote,
      reviewerEmail: reviewer,
    });
    if (!cloudMode) {
      const outbox = readJsonFile<OutboxEmailRecord[]>(getStorePath('email-outbox.json'), []);
      outbox.unshift(rejectionMail);
      writeJsonFile(getStorePath('email-outbox.json'), outbox);
    }

    return updated;
  }

  // Approve branch
  const finalLyrics =
    params.editedLyrics && params.editedLyrics.length > 0
      ? params.editedLyrics
      : current.proposedLyrics;
  const mergedMeta = mergeMetadataPatch(current.proposedMetadata, params.editedMetadata);

  const updated: LyricCorrection = {
    ...current,
    proposedLyrics: finalLyrics,
    proposedMetadata: mergedMeta,
    status: 'approved',
    reviewedAt: now,
    reviewedBy: reviewer,
    reviewNote: trimmedNote || null,
  };

  const existingBhajan = await getBhajanDetail(current.bhajanId);
  const localOverrides = cloudMode
    ? {}
    : readJsonFile<Record<string, ApprovedOverride>>(getStorePath('approved-overrides.json'), {});
  const existingOv = localOverrides[current.bhajanId];

  const submittedRecording: RecordingSource[] = current.audioSubmission?.url
    ? [
        {
          id: `rec_comm_${current.id}`,
          collection: 'community_upload',
          label: current.audioSubmission.label || `${current.submitterName} Recording`,
          externalUrl: current.audioSubmission.url,
        },
      ]
    : [];

  const tempoStr =
    mergedMeta?.tempo !== undefined && String(mergedMeta.tempo).trim() !== ''
      ? String(mergedMeta.tempo).trim()
      : undefined;

  const ragaNameFromMeta = mergedMeta?.ragaName || mergedMeta?.raga;
  const mergedRaga: RagaInfo | undefined =
    ragaNameFromMeta || mergedMeta?.arohanam || mergedMeta?.avarohanam
      ? {
          name: ragaNameFromMeta || existingBhajan?.raga?.name || 'Unspecified',
          arohanam: mergedMeta?.arohanam ?? existingBhajan?.raga?.arohanam,
          avarohanam: mergedMeta?.avarohanam ?? existingBhajan?.raga?.avarohanam,
          westernInC: existingBhajan?.raga?.westernInC,
        }
      : existingBhajan?.raga ?? undefined;

  const mergedFirstLineNotes =
    mergedMeta?.firstLineSargam || mergedMeta?.firstLineWestern
      ? {
          sargam: mergedMeta?.firstLineSargam ?? existingBhajan?.firstLineNotes?.sargam,
          westernInC: mergedMeta?.firstLineWestern ?? existingBhajan?.firstLineNotes?.westernInC,
        }
      : existingBhajan?.firstLineNotes ?? undefined;

  let nextOverride: ApprovedOverride;
  if (current.submissionType === 'new_bhajan') {
    const newTitle = mergedMeta?.title || current.bhajanTitle;
    const newLang = mergedMeta?.language || current.script || undefined;
    const newLyricsSets: Bhajan['lyricsSets'] =
      finalLyrics.length > 0
        ? [
            {
              language: current.script || newLang || 'Sanskrit / Hindi',
              script: inferScriptKind(finalLyrics, current.script || newLang),
              lines: finalLyrics,
            },
          ]
        : [];

    nextOverride = {
      bhajanId: current.bhajanId,
      slug: current.bhajanId,
      title: newTitle,
      language: newLang,
      lyricsSets: newLyricsSets,
      meaning: mergedMeta?.meaning,
      deity: mergedMeta?.deity,
      beat: mergedMeta?.beat ?? mergedMeta?.tala,
      tala: mergedMeta?.tala,
      tempo: tempoStr,
      raga: mergedRaga,
      gentsPitchRaw: mergedMeta?.gentsPitchRaw,
      ladiesPitchRaw: mergedMeta?.ladiesPitchRaw,
      firstLineNotes: mergedFirstLineNotes,
      notesRange: mergedMeta?.notesRange,
      sheetMusicUrl: mergedMeta?.sheetMusicUrl,
      addedRecordings: mergeRecordings(existingOv?.addedRecordings ?? [], submittedRecording),
      recordings: mergeRecordings(existingOv?.recordings ?? [], submittedRecording),
      lyricsMissing: newLyricsSets.length === 0,
      matchStatus: 'verified',
      metadataSource: 'community_contributed',
      bhajamiOverride: true,
      bhajamiNewBhajan: true,
      isNewBhajan: true,
      createdAt: now,
      updatedAt: now,
    };

    if (!cloudMode) {
      localOverrides[current.bhajanId] = nextOverride;
      writeJsonFile(getStorePath('approved-overrides.json'), localOverrides);

      const newBhajans = readJsonFile<Bhajan[]>(getStorePath('approved-new-bhajans.json'), []);
      const constructed = buildBhajanFromOverride(nextOverride);
      const existingNewIdx = newBhajans.findIndex((b) => b.id === constructed.id);
      if (existingNewIdx >= 0) {
        newBhajans[existingNewIdx] = constructed;
      } else {
        newBhajans.unshift(constructed);
      }
      writeJsonFile(getStorePath('approved-new-bhajans.json'), newBhajans);
    }
  } else {
    const baseLyricsSets = existingOv?.lyricsSets ?? existingBhajan?.lyricsSets ?? [];
    const nextLyricsSets = buildUpdatedLyricsSets(current, baseLyricsSets, finalLyrics);

    nextOverride = {
      bhajanId: current.bhajanId,
      title: mergedMeta?.title || existingOv?.title || existingBhajan?.title,
      language: mergedMeta?.language || existingOv?.language || existingBhajan?.language || undefined,
      lyricsSets: nextLyricsSets,
      meaning: mergedMeta?.meaning || existingOv?.meaning || existingBhajan?.meaning || undefined,
      deity: mergedMeta?.deity || existingOv?.deity || existingBhajan?.deity || undefined,
      beat:
        mergedMeta?.beat ||
        mergedMeta?.tala ||
        existingOv?.beat ||
        existingBhajan?.beat ||
        undefined,
      tala: mergedMeta?.tala || existingOv?.tala || existingBhajan?.tala || undefined,
      tempo: tempoStr || existingOv?.tempo || existingBhajan?.tempo || undefined,
      raga: mergedRaga,
      gentsPitchRaw:
        mergedMeta?.gentsPitchRaw ||
        existingOv?.gentsPitchRaw ||
        existingBhajan?.gentsPitchRaw ||
        existingBhajan?.gentsPitch?.raw,
      ladiesPitchRaw:
        mergedMeta?.ladiesPitchRaw ||
        existingOv?.ladiesPitchRaw ||
        existingBhajan?.ladiesPitchRaw ||
        existingBhajan?.ladiesPitch?.raw,
      firstLineNotes: mergedFirstLineNotes,
      notesRange:
        mergedMeta?.notesRange || existingOv?.notesRange || existingBhajan?.notesRange || undefined,
      sheetMusicUrl:
        mergedMeta?.sheetMusicUrl ||
        existingOv?.sheetMusicUrl ||
        existingBhajan?.sheetMusicUrl ||
        undefined,
      addedRecordings: mergeRecordings(existingOv?.addedRecordings ?? [], submittedRecording),
      lyricsMissing: nextLyricsSets.length === 0,
      isEstimated: false,
      bhajamiOverride: true,
      updatedAt: now,
    };

    if (!cloudMode) {
      localOverrides[current.bhajanId] = nextOverride;
      writeJsonFile(getStorePath('approved-overrides.json'), localOverrides);
    }
  }

  const revision: BhajanRevision = {
    id: `rev_${Date.now()}_${randomSuffix(4)}`,
    bhajanId: current.bhajanId,
    correctionId: current.id,
    previousLyrics: current.originalLyrics,
    newLyrics: finalLyrics,
    script: current.script,
    contributorName: current.submitterName,
    approvedBy: reviewer,
    approvedAt: now,
  };

  if (!cloudMode) {
    corrections[idx] = updated;
    writeJsonFile(getStorePath('corrections-store.json'), corrections);

    const revisions = readJsonFile<BhajanRevision[]>(getStorePath('revisions-store.json'), []);
    revisions.unshift(revision);
    writeJsonFile(getStorePath('revisions-store.json'), revisions);
  }

  const synced = await syncCorrectionDecisionToCloud({
    updated,
    override: nextOverride,
    existingBhajan,
    revision,
    idToken: params.idToken,
  });
  if (cloudMode && !synced) {
    throw new Error('Failed publishing approved bhajan changes to Cloud Firestore.');
  }

  const approvalMail = await dispatchContributorApprovalEmail({
    correction: updated,
    reviewerEmail: reviewer,
  });
  if (!cloudMode) {
    const outbox = readJsonFile<OutboxEmailRecord[]>(getStorePath('email-outbox.json'), []);
    outbox.unshift({
      ...approvalMail,
      id: `mail_${Date.now()}_${randomSuffix(4)}`,
    });
    writeJsonFile(getStorePath('email-outbox.json'), outbox);
  }

  return updated;
}

export async function submitContributorFollowup(params: {
  id: string;
  contributorReply: string;
  proposedLyrics?: string[];
  audioSubmission?: LyricCorrection['audioSubmission'];
  idToken?: string | null;
}): Promise<LyricCorrection | null> {
  const cloudMode = hasCloudConfig();
  let corrections: LyricCorrection[] = [];
  let idx = -1;
  let current: LyricCorrection | null = null;

  if (cloudMode) {
    current = await getCorrectionByIdWithCloud(params.id, params.idToken);
    if (!current) return null;
  } else {
    ensureInitialPendingSample();
    corrections = readJsonFile<LyricCorrection[]>(getStorePath('corrections-store.json'), []);
    idx = corrections.findIndex((c) => c.id === params.id);
    if (idx === -1 && params.idToken) {
      const cloudMatch = await fetchCloudCorrectionById(params.id, params.idToken);
      if (cloudMatch) {
        corrections.unshift(cloudMatch);
        idx = 0;
      }
    }
    if (idx === -1) return null;
    current = corrections[idx];
  }

  if (current.status !== 'info_requested' && current.status !== 'rejected') {
    throw new Error(
      'Follow-up replies can only be sent when a moderator requested info or rejected the submission.',
    );
  }

  const now = new Date().toISOString();
  const updated: LyricCorrection = {
    ...current,
    proposedLyrics:
      params.proposedLyrics && params.proposedLyrics.length > 0
        ? params.proposedLyrics
        : current.proposedLyrics,
    audioSubmission: params.audioSubmission ?? current.audioSubmission,
    contributorReply: params.contributorReply.trim(),
    contributorRepliedAt: now,
    status: 'pending',
  };

  if (!cloudMode) {
    corrections[idx] = updated;
    writeJsonFile(getStorePath('corrections-store.json'), corrections);
  }

  const synced = await syncCorrectionDecisionToCloud({
    updated,
    idToken: params.idToken,
  });
  if (cloudMode && !synced) {
    throw new Error('Failed sending follow-up reply to Cloud Firestore.');
  }

  const adminMail = await dispatchAdminCorrectionEmail(updated);
  if (!cloudMode) {
    const outbox = readJsonFile<OutboxEmailRecord[]>(getStorePath('email-outbox.json'), []);
    outbox.unshift(adminMail);
    writeJsonFile(getStorePath('email-outbox.json'), outbox);
  }

  return updated;
}
