import {
  canonicalizePhrase,
  normalizedWordSim,
  type Bhajan,
  type BhajanIndexEntry,
  type BhajanMetadataSource,
  type RecordingSource,
} from '@bhajami/shared';

export type PlaybackAction =
  | {
      kind: 'youtube';
      url: string;
      videoId: string;
      chapterLabel: string | null;
      embeddable: boolean;
    }
  | {
      kind: 'audio';
      uri: string;
    }
  | {
      kind: 'none';
      reason: string;
    };

/**
 * Strips leading track numbers ("01 - ") and pipe channel/tag suffixes ("| Sri Sathya Sai Bhajans")
 * while keeping at least the core bhajan title intact.
 */
export function cleanYouTubeDisplayTitle(rawTitle: string): string {
  const trimmed = String(rawTitle || '').trim();
  if (!trimmed) return '';
  let candidate = trimmed.replace(/^\s*\d{1,5}\s*[-–—:.|)]\s*/, '');
  if (candidate.includes('|')) {
    const head = candidate.split('|')[0]?.trim() || '';
    if (head.length >= 3) {
      candidate = head;
    }
  }
  return candidate
    .replace(/^[\s|–—-]+|[\s|–—-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Filters slim `BhajanIndexEntry` records by Deity, Sai Rhythms verification status,
 * and Sanskrit phonetic token / substring match.
 */
export function filterBhajanIndexEntries(
  entries: readonly BhajanIndexEntry[],
  options: {
    query?: string;
    deity?: string;
    onlyVerified?: boolean;
  } = {},
): BhajanIndexEntry[] {
  const q = (options.query || '').trim().toLowerCase();
  const deityFilter = (options.deity || 'All').trim();
  const onlyVerified = options.onlyVerified === true;
  const canonTokens = q ? canonicalizePhrase(q).split(' ').filter(Boolean) : [];

  return entries.filter((entry) => {
    if (onlyVerified && entry.metadataSource !== 'sairhythms_verified') {
      return false;
    }
    if (
      deityFilter &&
      deityFilter !== 'All' &&
      !(entry.deity || '').toLowerCase().includes(deityFilter.toLowerCase())
    ) {
      return false;
    }
    if (!q) return true;

    if (
      entry.title.toLowerCase().includes(q) ||
      (entry.deity || '').toLowerCase().includes(q) ||
      (entry.ragaName || '').toLowerCase().includes(q) ||
      entry.searchText.toLowerCase().includes(q)
    ) {
      return true;
    }
    return (
      canonTokens.length > 0 &&
      canonTokens.every((ct) =>
        entry.phoneticTokens.some(
          (pt) =>
            pt.includes(ct) ||
            (ct.length >= 4 &&
              Math.abs(pt.length - ct.length) <= 2 &&
              normalizedWordSim(ct, pt) >= 0.8),
        ),
      )
    );
  });
}

function formatMmSs(totalSeconds: number): string {
  const clean = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clean / 3600);
  const mins = Math.floor((clean % 3600) / 60);
  const secs = clean % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

/** Formats chapter start/end timestamps as `MM:SS–MM:SS` when present on YouTube volumes. */
export function formatChapterRange(startSec?: number, endSec?: number): string | null {
  if (typeof startSec !== 'number' || !Number.isFinite(startSec) || startSec < 0) {
    return null;
  }
  const startStr = formatMmSs(startSec);
  if (typeof endSec === 'number' && Number.isFinite(endSec) && endSec > startSec) {
    return `${startStr}–${formatMmSs(endSec)}`;
  }
  return `from ${startStr}`;
}

/** Builds a canonical `https://www.youtube.com/watch?v=...` URL with optional `&t=...s` offset. */
export function buildYouTubeWatchUrl(videoId: string, startSec?: number): string {
  const cleanId = encodeURIComponent(videoId.trim());
  const hasStart = typeof startSec === 'number' && Number.isFinite(startSec) && startSec > 0;
  return hasStart
    ? `https://www.youtube.com/watch?v=${cleanId}&t=${Math.floor(startSec)}s`
    : `https://www.youtube.com/watch?v=${cleanId}`;
}

function extractYouTubeIdFromUrl(url?: string): string | null {
  if (!url) return null;
  const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
  if (watchMatch?.[1]) return watchMatch[1];
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
  return shortMatch?.[1] ?? null;
}

/** Selects the highest-priority playable recording from a Bhajan record. */
export function pickPreferredRecording(bhajan?: Bhajan | null): RecordingSource | null {
  if (!bhajan?.recordings?.length) return null;
  return (
    bhajan.recordings.find((r) => Boolean(r.youtubeVideoId) && r.embeddable !== false) ||
    bhajan.recordings.find((r) => Boolean(r.externalUrl || r.localPath || r.youtubeVideoId)) ||
    bhajan.recordings[0] ||
    null
  );
}

/**
 * Resolves how a `RecordingSource` should be played on native mobile:
 * YouTube videos hand off natively via `Linking.openURL`, while direct audio URLs stream in `expo-av`.
 */
export function resolvePlaybackAction(
  recording: RecordingSource | null | undefined,
  apiBaseUrl: string,
): PlaybackAction {
  if (!recording) {
    return { kind: 'none', reason: 'No audio or YouTube recording is linked to this bhajan yet.' };
  }

  const ytId = recording.youtubeVideoId?.trim() || extractYouTubeIdFromUrl(recording.externalUrl);
  if (ytId) {
    return {
      kind: 'youtube',
      url: buildYouTubeWatchUrl(ytId, recording.startSec),
      videoId: ytId,
      chapterLabel: formatChapterRange(recording.startSec, recording.endSec),
      embeddable: recording.embeddable !== false,
    };
  }

  if (recording.externalUrl?.trim()) {
    return { kind: 'audio', uri: recording.externalUrl.trim() };
  }

  if (recording.localPath?.trim()) {
    const cleanBase = apiBaseUrl.replace(/\/+$/, '');
    if (cleanBase) {
      return {
        kind: 'audio',
        uri: `${cleanBase}/api/local-audio?id=${encodeURIComponent(recording.id)}`,
      };
    }
  }

  return { kind: 'none', reason: 'No streamable URI is available for this recording.' };
}

/** Maps a bhajan `metadataSource` to a compact display badge. */
export function formatMetadataSourceBadge(source?: BhajanMetadataSource | string): {
  label: string;
  verified: boolean;
} {
  switch (source) {
    case 'sairhythms_verified':
      return { label: 'Sai Rhythms Verified', verified: true };
    case 'sssmediacentre_verified':
      return { label: 'SSS Media Centre', verified: true };
    case 'youtube_prasanthi_mandir_live':
      return { label: 'Prasanthi Mandir Live', verified: false };
    case 'youtube_sss_bhajans':
      return { label: 'SSS Bhajans YT', verified: false };
    case 'admin_curated':
      return { label: 'Curated', verified: true };
    case 'local_inferred':
      return { label: 'Local Archive', verified: false };
    default:
      return { label: 'Community', verified: false };
  }
}

/**
 * Resolves the default backend API base URL so Expo Web and native Expo Go clients running over
 * Wi-Fi automatically target the Mac's LAN IP (`:3000`) instead of looping back to `localhost`.
 */
export function resolveDefaultApiBase(params: {
  envBaseUrl?: string;
  webHostname?: string;
  bundleScriptUrl?: string;
  platformOs: string;
  port?: number;
}): string {
  const port = params.port ?? 3000;
  const cleanEnv = params.envBaseUrl?.trim().replace(/\/+$/, '');
  if (cleanEnv) {
    return cleanEnv;
  }

  if (params.platformOs === 'web' && params.webHostname?.trim()) {
    return `http://${params.webHostname.trim()}:${port}`;
  }

  const bundleHostMatch = params.bundleScriptUrl?.match(/^https?:\/\/([^:/?#]+)/i);
  if (bundleHostMatch?.[1]) {
    return `http://${bundleHostMatch[1]}:${port}`;
  }

  return params.platformOs === 'android'
    ? `http://10.0.2.2:${port}`
    : `http://localhost:${port}`;
}
