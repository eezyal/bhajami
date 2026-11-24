import type { Bhajan, MissingFieldKey } from './types';

const MISSING_FIELD_ORDER: readonly MissingFieldKey[] = [
  'lyrics',
  'meaning',
  'gentsPitch',
  'ladiesPitch',
  'raga',
  'beat',
  'tempo',
  'notation',
  'alternateScripts',
];

/**
 * Computes which curated metadata or lyric fields are missing or placeholder-estimated
 * for a bhajan record, returning keys in a stable sorted order.
 */
export function getMissingBhajanFields(bhajan: Partial<Bhajan>): MissingFieldKey[] {
  const missing: MissingFieldKey[] = [];

  const lyricsAbsent =
    bhajan.lyricsMissing === true ||
    !bhajan.lyricsSets?.length ||
    bhajan.lyricsSets.every(
      (s) => !s.lines.length || s.lines.some((l) => l.includes('awaiting Sai Rhythms')),
    );
  if (lyricsAbsent) missing.push('lyrics');

  if (!bhajan.meaning?.trim() || bhajan.meaning.startsWith('Synced from local')) {
    missing.push('meaning');
  }

  if (!bhajan.gentsPitch || bhajan.isEstimated === true) {
    missing.push('gentsPitch');
  }

  if (!bhajan.ladiesPitch || bhajan.isEstimated === true) {
    missing.push('ladiesPitch');
  }

  const ragaName = bhajan.raga?.name?.trim() || '';
  if (
    !ragaName ||
    (/^(Traditional|Pending Sai Rhythms Sync)$/i.test(ragaName) && !bhajan.raga?.arohanam)
  ) {
    missing.push('raga');
  }

  if (!bhajan.beat?.trim() || bhajan.isEstimated === true || /\(Est\.\)/i.test(bhajan.beat)) {
    missing.push('beat');
  }

  if (!bhajan.tempo?.trim() || bhajan.isEstimated === true) {
    missing.push('tempo');
  }

  if (!bhajan.firstLineNotes?.sargam?.trim() && !bhajan.firstLineNotes?.westernInC?.trim()) {
    missing.push('notation');
  }

  if ((bhajan.lyricsSets?.length ?? 0) <= 1) {
    missing.push('alternateScripts');
  }

  return missing.sort((a, b) => MISSING_FIELD_ORDER.indexOf(a) - MISSING_FIELD_ORDER.indexOf(b));
}
