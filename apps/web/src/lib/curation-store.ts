import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalizePhrase,
  getMissingBhajanFields,
  makeDoNotMergeKey,
  parsePitchStringOptional,
  type Bhajan,
  type BhajanRevision,
  type DoNotMergePairDoc,
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
  hasCloudConfig,
  invalidateCloudCatalogCaches,
  parseBhajanRecord,
  type CloudApprovedOverride,
} from './firestore-rest';
import { getBhajanDetail, getMergedCatalog, inferScriptKind } from './catalog-store';
import { logEvent } from './logger';

export type CurationViewKind =
  | 'missing_lyrics'
  | 'needs_verification'
  | 'ambiguous_long'
  | 'runs';

export type CurationActionPayload =
  | {
      action: 'approve_merge';
      sourceBhajanId: string;
      targetBhajanId: string;
      videoId?: string;
      saveAliasTitle?: string;
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

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function randomSuffix(length = 4): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function hasLongAmbiguousVideo(bhajan: Bhajan): boolean {
  if ((bhajan.recordings ?? []).some((rec) => (rec.durationSec ?? 0) > 390)) {
    return true;
  }
  return false;
}

function filterBhajansByView(
  bhajans: Bhajan[],
  view: Exclude<CurationViewKind, 'runs'>,
  ambiguousVideoIds?: Set<string>,
): Bhajan[] {
  if (view === 'missing_lyrics') {
    return bhajans.filter(
      (b) => b.lyricsMissing === true || getMissingBhajanFields(b).includes('lyrics'),
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

function computeAliasKey(canonicalPhrase: string): string {
  return crypto.createHash('sha1').update(canonicalPhrase, 'utf8').digest('hex').slice(0, 16);
}

export async function listCurationView(params: {
  view: CurationViewKind;
  cursor?: string | null;
  limit?: number;
}): Promise<{
  view: CurationViewKind;
  items: Bhajan[];
  runs?: IngestionRunDoc[];
  nextCursor: string | null;
  totalMatching: number;
}> {
  const safeLimit = Math.max(1, Math.min(100, Number(params.limit || 25) || 25));
  const cloudMode = hasCloudConfig();

  if (cloudMode) {
    const db = getAdminFirestore();
    if (!db) {
      throw new Error('Firebase Admin Firestore is not configured for curation queries.');
    }

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

    let query: FirebaseFirestore.Query = db.collection('bhajans');
    if (params.view === 'missing_lyrics') {
      query = query.where('lyricsMissing', '==', true).orderBy('updatedAt', 'desc');
    } else if (params.view === 'needs_verification') {
      query = query.where('matchStatus', '==', 'needs_verification').orderBy('updatedAt', 'desc');
    } else {
      // ambiguous_long stubs come from youtubeVideos classified 'ambiguous_long'
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

    const snap = await query.limit(safeLimit + 1).get();
    const docs = snap.docs.slice(0, safeLimit);
    const items = docs.map((doc) => parseBhajanRecord(doc.id, doc.data()));
    const nextCursor = snap.docs.length > safeLimit ? docs[docs.length - 1].id : null;
    return {
      view: params.view,
      items,
      nextCursor,
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

export async function executeCurationAction(
  payload: CurationActionPayload & { reviewerEmail: string },
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
    if (!db) {
      throw new Error('Firebase Admin Firestore is required for cloud curation actions.');
    }

    if (payload.action === 'approve_merge') {
      if (!payload.sourceBhajanId || !payload.targetBhajanId || payload.sourceBhajanId === payload.targetBhajanId) {
        throw new Error('Distinct sourceBhajanId and targetBhajanId are required for approve_merge.');
      }
      const sourceRef = db.collection('bhajans').doc(payload.sourceBhajanId);
      const targetRef = db.collection('bhajans').doc(payload.targetBhajanId);
      let aliasId: string | undefined;
      let mergedTarget: Bhajan | undefined;

      await db.runTransaction(async (tx) => {
        const [sourceSnap, targetSnap] = await Promise.all([tx.get(sourceRef), tx.get(targetRef)]);
        if (!sourceSnap.exists) throw new Error(`Source bhajan not found: ${payload.sourceBhajanId}`);
        if (!targetSnap.exists) throw new Error(`Target bhajan not found: ${payload.targetBhajanId}`);

        const source = parseBhajanRecord(sourceSnap.id, sourceSnap.data() ?? {});
        const target = parseBhajanRecord(targetSnap.id, targetSnap.data() ?? {});

        const mergedRecordings = mergeRecordingsUnique(target.recordings, source.recordings);
        const aliasSlugs = Array.from(
          new Set([
            ...(target.slugAliases ?? []),
            source.id,
            source.slug,
            ...(source.slugAliases ?? []),
          ]),
        ).filter((s) => Boolean(s) && s !== target.id && s !== target.slug);

        const nextTarget: Bhajan = {
          ...target,
          recordings: mergedRecordings,
          slugAliases: aliasSlugs,
          updatedAt: now,
        };
        nextTarget.missingFields = getMissingBhajanFields(nextTarget);
        mergedTarget = nextTarget;

        tx.set(
          targetRef,
          {
            recordings: mergedRecordings,
            slugAliases: aliasSlugs,
            missingFields: nextTarget.missingFields,
            updatedAt: now,
          },
          { merge: true },
        );

        const aliasText = payload.saveAliasTitle?.trim();
        if (aliasText) {
          const canonical = canonicalizePhrase(aliasText);
          if (canonical) {
            aliasId = computeAliasKey(canonical);
            const aliasDoc: EntityAliasDoc = {
              id: aliasId,
              variantTitle: aliasText,
              canonicalPhrase: canonical,
              targetBhajanId: target.id,
              source: 'admin_merge',
              createdAt: now,
              approvedBy: reviewer,
            };
            tx.set(db.collection('entityAliases').doc(aliasId), aliasDoc);
          }
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

      invalidateCloudCatalogCaches();
      return { ok: true, action: 'approve_merge', bhajan: mergedTarget, aliasId };
    }

    if (payload.action === 'keep_distinct') {
      const pairKey = makeDoNotMergeKey(payload.sourceBhajanId, payload.candidateBhajanId);
      const sourceRef = db.collection('bhajans').doc(payload.sourceBhajanId);
      const pairRef = db.collection('doNotMergePairs').doc(pairKey);
      let updatedSource: Bhajan | undefined;

      await db.runTransaction(async (tx) => {
        const sourceSnap = await tx.get(sourceRef);
        if (!sourceSnap.exists) throw new Error(`Bhajan not found: ${payload.sourceBhajanId}`);
        const source = parseBhajanRecord(sourceSnap.id, sourceSnap.data() ?? {});
        const nextCandidates = (source.matchCandidates ?? []).filter(
          (c) => c.targetBhajanId !== payload.candidateBhajanId,
        );
        const nextStatus: Bhajan['matchStatus'] =
          nextCandidates.length > 0
            ? 'needs_verification'
            : source.lyricsMissing
              ? 'unmatched'
              : 'verified';

        updatedSource = {
          ...source,
          matchCandidates: nextCandidates,
          matchStatus: nextStatus,
          updatedAt: now,
        };

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
          ...(payload.note?.trim() ? { note: payload.note.trim() } : {}),
        };
        tx.set(pairRef, pairDoc);
        tx.update(sourceRef, {
          matchCandidates: nextCandidates,
          matchStatus: nextStatus,
          updatedAt: now,
        });
      });

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

    const mergedRecordings = mergeRecordingsUnique(target.recordings, source.recordings);
    const aliasSlugs = Array.from(
      new Set([
        ...(target.slugAliases ?? []),
        source.id,
        source.slug,
        ...(source.slugAliases ?? []),
      ]),
    ).filter((s) => Boolean(s) && s !== target.id && s !== target.slug);

    const existingOv = localOverrides[target.id];
    const nextOv: CloudApprovedOverride = {
      ...existingOv,
      bhajanId: target.id,
      recordings: mergedRecordings,
      addedRecordings: mergeRecordingsUnique(existingOv?.addedRecordings ?? [], source.recordings),
      slugAliases: aliasSlugs,
      bhajamiOverride: true,
      updatedAt: now,
    };
    localOverrides[target.id] = nextOv;
    writeLocalJson('approved-overrides.json', localOverrides);

    deletedIds.add(source.id);
    writeLocalJson('curation-deleted-ids.json', Array.from(deletedIds));

    let aliasId: string | undefined;
    const aliasText = payload.saveAliasTitle?.trim();
    if (aliasText) {
      const canonical = canonicalizePhrase(aliasText);
      if (canonical) {
        aliasId = computeAliasKey(canonical);
        const aliases = readLocalJson<Record<string, EntityAliasDoc>>('curation-aliases.json', {});
        aliases[aliasId] = {
          id: aliasId,
          variantTitle: aliasText,
          canonicalPhrase: canonical,
          targetBhajanId: target.id,
          source: 'admin_merge',
          createdAt: now,
          approvedBy: reviewer,
        };
        writeLocalJson('curation-aliases.json', aliases);
      }
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

    const updatedTarget = await getBhajanDetail(target.id);
    return {
      ok: true,
      action: 'approve_merge',
      bhajan: updatedTarget ?? { ...target, recordings: mergedRecordings, slugAliases: aliasSlugs },
      aliasId,
    };
  }

  if (payload.action === 'keep_distinct') {
    const source = await getBhajanDetail(payload.sourceBhajanId);
    if (!source) throw new Error(`Bhajan not found: ${payload.sourceBhajanId}`);
    const pairKey = makeDoNotMergeKey(payload.sourceBhajanId, payload.candidateBhajanId);
    const nextCandidates = (source.matchCandidates ?? []).filter(
      (c) => c.targetBhajanId !== payload.candidateBhajanId,
    );
    const nextStatus: Bhajan['matchStatus'] =
      nextCandidates.length > 0
        ? 'needs_verification'
        : source.lyricsMissing
          ? 'unmatched'
          : 'verified';

    const pairs = readLocalJson<Record<string, DoNotMergePairDoc>>('curation-do-not-merge.json', {});
    pairs[pairKey] = {
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
      ...(payload.note?.trim() ? { note: payload.note.trim() } : {}),
    };
    writeLocalJson('curation-do-not-merge.json', pairs);

    const existingOv = localOverrides[source.id];
    localOverrides[source.id] = {
      ...existingOv,
      bhajanId: source.id,
      matchCandidates: nextCandidates,
      matchStatus: nextStatus,
      updatedAt: now,
    };
    writeLocalJson('approved-overrides.json', localOverrides);

    const updated = await getBhajanDetail(source.id);
    return {
      ok: true,
      action: 'keep_distinct',
      bhajan: updated ?? { ...source, matchCandidates: nextCandidates, matchStatus: nextStatus },
      doNotMergeKey: pairKey,
    };
  }

  if (payload.action === 'publish_curated') {
    const existing = await getBhajanDetail(payload.bhajanId);
    if (!existing) throw new Error(`Bhajan not found: ${payload.bhajanId}`);
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

    const existingOv = localOverrides[existing.id];
    const nextOv: CloudApprovedOverride = {
      ...existingOv,
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
      gentsPitch: meta.gentsPitchRaw
        ? parsePitchStringOptional(meta.gentsPitchRaw) ?? undefined
        : existing.gentsPitch ?? undefined,
      ladiesPitch: meta.ladiesPitchRaw
        ? parsePitchStringOptional(meta.ladiesPitchRaw) ?? undefined
        : existing.ladiesPitch ?? undefined,
      firstLineNotes: nextFirstLineNotes,
      notesRange: meta.notesRange?.trim() || existing.notesRange || undefined,
      sheetMusicUrl: meta.sheetMusicUrl?.trim() || existing.sheetMusicUrl || undefined,
      lyricsSets: nextLyricsSets,
      lyricsMissing: nextLyricsSets.length === 0,
      isEstimated: false,
      matchStatus: 'verified',
      metadataSource: 'admin_curated',
      bhajamiOverride: true,
      updatedAt: now,
    };
    localOverrides[existing.id] = nextOv;
    writeLocalJson('approved-overrides.json', localOverrides);

    // Also update newBhajans entry if present
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
        lyricsSets: nextLyricsSets,
        lyricsMissing: nextLyricsSets.length === 0,
        isEstimated: false,
        matchStatus: 'verified',
        bhajamiOverride: true,
        updatedAt: now,
      };
      updatedEntry.missingFields = getMissingBhajanFields(updatedEntry);
      newBhajans[newIdx] = updatedEntry;
      writeLocalJson('approved-new-bhajans.json', newBhajans);
    }

    const revId = `rev_${Date.now()}_${randomSuffix(4)}`;
    const revisions = readLocalJson<BhajanRevision[]>('revisions-store.json', []);
    revisions.unshift({
      id: revId,
      bhajanId: existing.id,
      correctionId: `curated_${revId}`,
      previousLyrics: existing.lyricsSets[0]?.lines ?? [],
      newLyrics: nextLyricsSets[0]?.lines ?? [],
      script: nextLyricsSets[0]?.language || 'Roman',
      contributorName: reviewer,
      approvedBy: reviewer,
      approvedAt: now,
    });
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
