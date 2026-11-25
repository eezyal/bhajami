import type { BhajanIndexEntry } from './types';

export type StreamModeKind = 'discovery' | 'for_you' | 'liked_only';

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

  const hasPlayable = entries.some((e) => e.recordingCount > 0);
  const candidates = entries.filter((e) => {
    if (likedSet.has(e.id)) return false;
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
 * Build a playable-first randomized stream queue for Discovery, For You, or Liked Radio.
 */
export function buildStreamQueue(
  entries: readonly BhajanIndexEntry[],
  options: {
    mode: StreamModeKind;
    likedIds: readonly string[];
    deityFilter?: string;
    ragaFilter?: string;
    seed?: number;
  },
): BhajanIndexEntry[] {
  const rng = makeRng(options.seed);
  const deityWanted = options.deityFilter?.trim().toLowerCase() || '';
  const ragaWanted = normalizeRagaKey(options.ragaFilter);

  const matching = entries.filter((e) => {
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
    const likedSet = resolveLikedSet(options.likedIds, pool);
    const likedEntries = pool.filter((e) => likedSet.has(e.id));
    if (likedEntries.length > 0) {
      return shuffleWithRng(likedEntries, rng);
    }
    // Fallback to all liked entries across `matching` if none had recordings yet
    const fallbackLikedSet = resolveLikedSet(options.likedIds, matching);
    return shuffleWithRng(matching.filter((e) => fallbackLikedSet.has(e.id)), rng);
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
