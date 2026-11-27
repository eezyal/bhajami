import type { Bhajan, BhajanIndexEntry, RecordingSource, TrackType } from './types';

export type StreamModeKind = 'discovery' | 'for_you' | 'liked_only';
export type StreamMediaMode = 'audio' | 'video';

const SPECIAL_TRACK_TITLE_RE =
  /\b(?:karaoke|instrumental|nadasudha|nada\s+sudha|on\s+veena|violin\s+instrumental|flute\s+instrumental|sitar\s+instrumental|episode\s+\d+|sama\s*[-–]\s*\d+|ramayana\s+through\s+sai\s+bhajans|100\s+million\s+views|channel\s+launching|global\s+akhanda\s+bhajan|story\s+of\s+the\s+vibhuti\s+mantra|who\s+is\s+sri\s+sathya\s+sai)\b/i;

const SPECIAL_RECORDING_RE =
  /(?:^|[\s_\-/|])(?:karaoke|gents_karaoke|ladies_karaoke|instrumental|nadasudha|nada_sudha|on_veena|on\s+veena|violin\s+instrumental)(?:$|[\s_\-./|])/i;

/**
 * Returns true when a catalog item is an instrumental, karaoke, or special non-bhajan track
 * that should be excluded from standard vocal random streams and missing-lyrics queues.
 */
export function isSpecialOrInstrumentalTrack(item: {
  title?: string | null;
  trackType?: TrackType | null;
} | null | undefined): boolean {
  if (!item) return false;
  if (
    item.trackType === 'instrumental' ||
    item.trackType === 'karaoke' ||
    item.trackType === 'special'
  ) {
    return true;
  }
  return Boolean(item.title && SPECIAL_TRACK_TITLE_RE.test(item.title));
}

/**
 * Returns true when an individual recording inside a bhajan entry is karaoke or instrumental.
 */
export function isKaraokeOrInstrumentalRecording(
  rec: Pick<RecordingSource, 'label' | 'externalUrl' | 'localPath'> | null | undefined,
): boolean {
  if (!rec) return false;
  const text = `${rec.label || ''} ${rec.externalUrl || ''} ${rec.localPath || ''}`;
  return SPECIAL_RECORDING_RE.test(text);
}

export interface BhajanRecommendation {
  entry: BhajanIndexEntry;
  score: number;
  reasons: string[];
  matchedRaga?: string;
  matchedDeity?: string;
}

const IGNORED_RAGA_KEYS = new Set([
  '',
  'traditional',
  'unspecified',
  'pending sai rhythms sync',
  'unknown',
  'n/a',
]);

/**
 * Normalize a Raga label to a canonical lowercase comparison key (`""` when non-specific).
 */
export function normalizeRagaKey(raga?: string | null): string {
  if (!raga) return '';
  let cleaned = raga
    .toLowerCase()
    .replace(/^(?:raga|ragam)\s+/i, '')
    .replace(/\s+(?:raga|ragam)$/i, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (IGNORED_RAGA_KEYS.has(cleaned)) {
    cleaned = '';
  }
  return cleaned;
}

/**
 * Resolve any saved liked IDs (including old slugs in `slugAliases`) against current entries.
 */
export function resolveLikedSet(
  likedIds: readonly string[],
  entries: readonly BhajanIndexEntry[],
): Set<string> {
  const rawSet = new Set(likedIds.map((id) => id.trim()).filter(Boolean));
  const resolved = new Set<string>();
  for (const entry of entries) {
    if (
      rawSet.has(entry.id) ||
      rawSet.has(entry.slug) ||
      entry.slugAliases?.some((alias) => rawSet.has(alias))
    ) {
      resolved.add(entry.id);
    }
  }
  return resolved;
}

function makeRng(seed?: number): () => number {
  if (seed === undefined) {
    return () => Math.random();
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithRng<T>(items: readonly T[], rng: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Recommend unliked bhajans matching the user's liked Ragas, Deities, and Beats.
 * When `likedIds` produces zero liked profile entries, falls back to verified playable picks.
 */
export function computeSimilarBhajans(
  likedIds: readonly string[],
  entries: readonly BhajanIndexEntry[],
  options?: { limit?: number; onlyPlayable?: boolean },
): BhajanRecommendation[] {
  const limit = Math.max(1, options?.limit ?? 18);
  const onlyPlayable = options?.onlyPlayable ?? false;
  const likedSet = resolveLikedSet(likedIds, entries);

  const ragaCounts = new Map<string, { count: number; display: string }>();
  const deityCounts = new Map<string, number>();
  const beatCounts = new Map<string, number>();

  for (const entry of entries) {
    if (!likedSet.has(entry.id)) continue;
    const rKey = normalizeRagaKey(entry.ragaName);
    if (rKey) {
      const prev = ragaCounts.get(rKey);
      ragaCounts.set(rKey, {
        count: (prev?.count ?? 0) + 1,
        display: prev?.display ?? (entry.ragaName || rKey),
      });
    }
    const deity = entry.deity?.trim().toLowerCase();
    if (deity && deity !== 'universal') {
      deityCounts.set(deity, (deityCounts.get(deity) ?? 0) + 1);
    }
    const beat = entry.beat?.trim().toLowerCase();
    if (beat) {
      beatCounts.set(beat, (beatCounts.get(beat) ?? 0) + 1);
    }
  }

  const hasPlayable = entries.some((e) => e.recordingCount > 0 && !isSpecialOrInstrumentalTrack(e));
  const candidates = entries.filter((e) => {
    if (likedSet.has(e.id)) return false;
    if (isSpecialOrInstrumentalTrack(e)) return false;
    if (onlyPlayable && hasPlayable && e.recordingCount <= 0) return false;
    return true;
  });

  if (ragaCounts.size === 0 && deityCounts.size === 0 && beatCounts.size === 0) {
    return candidates
      .filter((e) => e.recordingCount > 0 || e.metadataSource === 'sairhythms_verified')
      .sort((a, b) => {
        const aVer = a.metadataSource === 'sairhythms_verified' ? 1 : 0;
        const bVer = b.metadataSource === 'sairhythms_verified' ? 1 : 0;
        if (bVer !== aVer) return bVer - aVer;
        if (b.recordingCount !== a.recordingCount) return b.recordingCount - a.recordingCount;
        return a.title.localeCompare(b.title);
      })
      .slice(0, limit)
      .map((entry) => ({
        entry,
        score: (entry.recordingCount > 0 ? 1.0 : 0.2) + (entry.metadataSource === 'sairhythms_verified' ? 0.5 : 0),
        reasons: [
          ...(entry.ragaName ? [`Raga: ${entry.ragaName}`] : []),
          ...(entry.deity ? [`Deity: ${entry.deity}`] : []),
        ],
      }));
  }

  const scored: BhajanRecommendation[] = [];
  for (const entry of candidates) {
    let score = 0;
    const reasons: string[] = [];
    let matchedRaga: string | undefined;
    let matchedDeity: string | undefined;

    const rKey = normalizeRagaKey(entry.ragaName);
    const rInfo = rKey ? ragaCounts.get(rKey) : undefined;
    if (rInfo) {
      score += 4.0 * (1 + Math.min(rInfo.count - 1, 3) * 0.25);
      matchedRaga = entry.ragaName || rInfo.display;
      reasons.push(`Same Raga: ${matchedRaga}`);
    }

    const deityLow = entry.deity?.trim().toLowerCase() || '';
    const dCount = deityLow ? deityCounts.get(deityLow) ?? 0 : 0;
    if (dCount > 0) {
      score += 2.0 * (1 + Math.min(dCount - 1, 3) * 0.2);
      matchedDeity = entry.deity;
      reasons.push(`Deity: ${entry.deity}`);
    }

    const beatLow = entry.beat?.trim().toLowerCase() || '';
    const bCount = beatLow ? beatCounts.get(beatLow) ?? 0 : 0;
    if (bCount > 0) {
      score += 1.2;
      reasons.push(`Beat: ${entry.beat}`);
    }

    if (score <= 0) continue;

    if (entry.recordingCount > 0) {
      score += 0.8;
    }
    if (entry.metadataSource === 'sairhythms_verified') {
      score += 0.4;
    }

    if (score > 1.2) {
      scored.push({
        entry,
        score: Math.round(score * 1000) / 1000,
        reasons,
        matchedRaga,
        matchedDeity,
      });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.entry.recordingCount !== a.entry.recordingCount) {
      return b.entry.recordingCount - a.entry.recordingCount;
    }
    return a.entry.title.localeCompare(b.entry.title);
  });

  return scored.slice(0, limit);
}

/**
 * Group similar-raga recommendations into browseable shelves by matched Raga.
 */
export function groupRecommendationsByRaga(
  recs: readonly BhajanRecommendation[],
  maxGroups = 4,
): Array<{ ragaName: string; items: BhajanRecommendation[] }> {
  const byKey = new Map<string, { ragaName: string; items: BhajanRecommendation[]; topScore: number }>();
  for (const rec of recs) {
    if (!rec.matchedRaga) continue;
    const key = normalizeRagaKey(rec.matchedRaga);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.items.push(rec);
      if (rec.score > bucket.topScore) bucket.topScore = rec.score;
    } else {
      byKey.set(key, { ragaName: rec.matchedRaga, items: [rec], topScore: rec.score });
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => {
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      return b.topScore - a.topScore;
    })
    .slice(0, maxGroups)
    .map(({ ragaName, items }) => ({ ragaName, items }));
}

/**
 * Returns true if an index entry has at least one direct non-YouTube audio recording (e.g. Sai Rhythms MP3).
 */
export function entryHasDirectAudio(entry: BhajanIndexEntry): boolean {
  if (typeof entry.hasDirectAudio === 'boolean') return entry.hasDirectAudio;
  return entry.recordingCount > 0 && entry.metadataSource === 'sairhythms_verified';
}

/**
 * Build a playable-first randomized stream queue for Discovery, For You, or Liked Radio.
 * Includes all playable bhajans (both direct-audio MP3 and YouTube A/V entries) in a unified
 * stream; `pickStreamRecording` handles preferring MP3 audio or YouTube video per track.
 */
export function buildStreamQueue(
  entries: readonly BhajanIndexEntry[],
  options: {
    mode: StreamModeKind;
    likedIds: readonly string[];
    deityFilter?: string;
    ragaFilter?: string;
    mediaMode?: StreamMediaMode;
    includeTrackTypes?: readonly TrackType[];
    seed?: number;
  },
): BhajanIndexEntry[] {
  const rng = makeRng(options.seed);
  const deityWanted = options.deityFilter?.trim().toLowerCase() || '';
  const ragaWanted = normalizeRagaKey(options.ragaFilter);
  const allowedTrackTypes =
    options.includeTrackTypes && options.includeTrackTypes.length > 0
      ? new Set<TrackType>(options.includeTrackTypes)
      : null;

  const matching = entries.filter((e) => {
    if (allowedTrackTypes) {
      const resolvedType: TrackType =
        e.trackType ?? (isSpecialOrInstrumentalTrack(e) ? 'special' : 'bhajan');
      if (!allowedTrackTypes.has(resolvedType)) return false;
    } else if (options.mode !== 'liked_only' && isSpecialOrInstrumentalTrack(e)) {
      return false;
    }
    if (deityWanted && deityWanted !== 'all') {
      if (!(e.deity || '').toLowerCase().includes(deityWanted)) return false;
    }
    if (ragaWanted) {
      if (normalizeRagaKey(e.ragaName) !== ragaWanted) return false;
    }
    return true;
  });

  const playable = matching.filter((e) => e.recordingCount > 0);
  const pool = playable.length > 0 ? playable : matching;

  if (options.mode === 'liked_only') {
    const likedAllSet = resolveLikedSet(options.likedIds, matching);
    const likedMatches = matching.filter((e) => likedAllSet.has(e.id));
    const likedPlayable = likedMatches.filter((e) => e.recordingCount > 0);
    return shuffleWithRng(likedPlayable.length > 0 ? likedPlayable : likedMatches, rng);
  }

  if (options.mode === 'discovery') {
    return shuffleWithRng(pool, rng);
  }

  // 'for_you': blend ~70% similar-raga/deity picks with ~30% fresh discovery shuffles
  const recs = computeSimilarBhajans(options.likedIds, pool, { limit: 80, onlyPlayable: true }).map(
    (r) => r.entry,
  );
  const recIds = new Set(recs.map((e) => e.id));
  const discoveries = shuffleWithRng(
    pool.filter((e) => !recIds.has(e.id)),
    rng,
  );

  // Lightly shuffle top similarity bands while preserving high relevance early
  const bandSize = 6;
  const slightlyVariedRecs: BhajanIndexEntry[] = [];
  for (let i = 0; i < recs.length; i += bandSize) {
    slightlyVariedRecs.push(...shuffleWithRng(recs.slice(i, i + bandSize), rng));
  }

  const interleaved: BhajanIndexEntry[] = [];
  const seen = new Set<string>();
  let rIdx = 0;
  let dIdx = 0;
  while (rIdx < slightlyVariedRecs.length || dIdx < discoveries.length) {
    for (let k = 0; k < 2 && rIdx < slightlyVariedRecs.length; k += 1) {
      const item = slightlyVariedRecs[rIdx++];
      if (!seen.has(item.id)) {
        seen.add(item.id);
        interleaved.push(item);
      }
    }
    if (dIdx < discoveries.length) {
      const item = discoveries[dIdx++];
      if (!seen.has(item.id)) {
        seen.add(item.id);
        interleaved.push(item);
      }
    }
  }
  return interleaved;
}

/** Returns true if a recording provides a direct non-YouTube audio stream or file. */
export function isDirectAudioRecording(rec: RecordingSource): boolean {
  if (rec.youtubeVideoId) return false;
  const url = rec.externalUrl?.trim() || '';
  if (url && /(?:youtube\.com|youtu\.be)/i.test(url)) return false;
  return Boolean(url || rec.localPath?.trim());
}

/** Returns true if a recording references a YouTube video (embeddable or link). */
export function isYouTubeRecording(rec: RecordingSource): boolean {
  if (rec.youtubeVideoId?.trim()) return true;
  return Boolean(rec.externalUrl && /(?:youtube\.com|youtu\.be)/i.test(rec.externalUrl));
}

/** Returns true if a recording has an audio URL/path or YouTube video reference. */
export function isPlayableRecording(rec: RecordingSource): boolean {
  return Boolean(rec.localPath?.trim() || rec.externalUrl?.trim() || rec.youtubeVideoId?.trim());
}

/**
 * Selects the optimal recording according to:
 *   1. Explicit user version selection (`preferredRecordingId`) when playable
 *   2. Admin-designated default version (`isDefault` / `bhajan.defaultRecordingId`),
 *      while respecting explicit `'video'` mode when a video option exists
 *   3. Sticky `'audio'` (direct MP3 first, preferring SSS Media Centre over Sai Rhythms)
 *      vs `'video'` (YouTube first) fallback across the unified stream queue.
 */
export function pickStreamRecording(
  bhajan: Bhajan | null | undefined,
  mediaMode: StreamMediaMode,
  preferredRecordingId?: string | null,
): {
  recording: RecordingSource | null;
  hasAudioOption: boolean;
  hasVideoOption: boolean;
  defaultRecordingId: string | null;
} {
  const recs = bhajan?.recordings ?? [];
  if (recs.length === 0) {
    return {
      recording: null,
      hasAudioOption: false,
      hasVideoOption: false,
      defaultRecordingId: null,
    };
  }

  const adminDefault =
    recs.find((r) => r.isDefault === true) ??
    (bhajan?.defaultRecordingId
      ? recs.find((r) => r.id === bhajan.defaultRecordingId)
      : undefined);
  const playableDefault = adminDefault && isPlayableRecording(adminDefault) ? adminDefault : null;

  const userPicked = preferredRecordingId
    ? recs.find((r) => r.id === preferredRecordingId && isPlayableRecording(r))
    : undefined;

  const vocalPreferred = !isSpecialOrInstrumentalTrack(bhajan ?? {});
  const candidateRecs = vocalPreferred
    ? (() => {
        const nonSpecial = recs.filter((r) => !isKaraokeOrInstrumentalRecording(r));
        return nonSpecial.length > 0 ? nonSpecial : recs;
      })()
    : recs;

  const sssmcAudio =
    candidateRecs.find(
      (r) => isDirectAudioRecording(r) && r.collection === 'sssmediacentre_bhajan_a_day',
    ) ?? null;
  const directAudio = sssmcAudio ?? candidateRecs.find(isDirectAudioRecording) ?? null;
  const embeddableYt =
    candidateRecs.find((r) => isYouTubeRecording(r) && r.embeddable !== false) ?? null;
  const anyYt = embeddableYt ?? candidateRecs.find(isYouTubeRecording) ?? null;

  const preferred = userPicked
    ? userPicked
    : mediaMode === 'video'
      ? (playableDefault && isYouTubeRecording(playableDefault) ? playableDefault : null) ??
        anyYt ??
        playableDefault ??
        directAudio ??
        candidateRecs[0]
      : playableDefault ?? directAudio ?? anyYt ?? candidateRecs[0];

  return {
    recording: preferred,
    hasAudioOption: Boolean(directAudio),
    hasVideoOption: Boolean(anyYt),
    defaultRecordingId: adminDefault?.id ?? null,
  };
}
