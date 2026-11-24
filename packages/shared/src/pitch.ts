import type { PitchInfo } from './types';

export interface ChromaticPitchStep {
  semitoneFromC: number;
  pancham: string;
  western: string;
  /** Tanpura root Sa frequency around C3 (130.81 Hz) -> B3 (246.94 Hz) */
  freqHz: number;
}

export const CHROMATIC_PITCHES: readonly ChromaticPitchStep[] = [
  { semitoneFromC: 0, pancham: '1 Pancham', western: 'C', freqHz: 130.81 },
  { semitoneFromC: 1, pancham: '1.5 Pancham', western: 'C# / Db', freqHz: 138.59 },
  { semitoneFromC: 2, pancham: '2 Pancham', western: 'D', freqHz: 146.83 },
  { semitoneFromC: 3, pancham: '2.5 Pancham', western: 'D# / Eb', freqHz: 155.56 },
  { semitoneFromC: 4, pancham: '3 Pancham', western: 'E', freqHz: 164.81 },
  { semitoneFromC: 5, pancham: '4 Pancham', western: 'F', freqHz: 174.61 },
  { semitoneFromC: 6, pancham: '4.5 Pancham', western: 'F# / Gb', freqHz: 185.0 },
  { semitoneFromC: 7, pancham: '5 Pancham', western: 'G', freqHz: 196.0 },
  { semitoneFromC: 8, pancham: '5.5 Pancham', western: 'G# / Ab', freqHz: 207.65 },
  { semitoneFromC: 9, pancham: '6 Pancham', western: 'A', freqHz: 220.0 },
  { semitoneFromC: 10, pancham: '6.5 Pancham', western: 'A# / Bb', freqHz: 233.08 },
  { semitoneFromC: 11, pancham: '7 Pancham', western: 'B', freqHz: 246.94 },
] as const;

export function parsePitchString(
  raw: string | null | undefined,
  fallbackSemitone = 2,
): PitchInfo {
  const cleaned = typeof raw === 'string' ? raw.trim() : '';
  const normalized = cleaned.toLowerCase();

  for (const step of CHROMATIC_PITCHES) {
    const panchamLower = step.pancham.toLowerCase();
    const westernTokens = step.western.toLowerCase().split('/').map((s) => s.trim());
    if (normalized && normalized.includes(panchamLower)) {
      return {
        raw: cleaned || `${step.pancham} / ${step.western}`,
        pancham: step.pancham,
        western: step.western,
        semitoneFromC: step.semitoneFromC,
      };
    }
    if (
      normalized &&
      westernTokens.some((tok) =>
        new RegExp(`(^|[^a-z#])${tok.replace('#', '\\#')}([^a-z#]|$)`).test(normalized),
      )
    ) {
      return {
        raw: cleaned || `${step.pancham} / ${step.western}`,
        pancham: step.pancham,
        western: step.western,
        semitoneFromC: step.semitoneFromC,
      };
    }
  }

  const safeSemitone = Number.isFinite(fallbackSemitone) ? Math.trunc(fallbackSemitone) : 2;
  const fallback = CHROMATIC_PITCHES[((safeSemitone % 12) + 12) % 12];
  return {
    raw: cleaned || `${fallback.pancham} / ${fallback.western}`,
    pancham: fallback.pancham,
    western: fallback.western,
    semitoneFromC: fallback.semitoneFromC,
  };
}

export function parsePitchStringOptional(raw?: string | null): PitchInfo | undefined {
  if (typeof raw !== 'string' || !raw.trim()) {
    return undefined;
  }
  return parsePitchString(raw);
}

export function transposePitch(
  baseSemitoneFromC: number,
  deltaSemitones: number,
): ChromaticPitchStep & { deltaLabel: string } {
  const safeBase = Number.isFinite(baseSemitoneFromC) ? Math.trunc(baseSemitoneFromC) : 2;
  const safeDelta = Number.isFinite(deltaSemitones) ? Math.trunc(deltaSemitones) : 0;
  const wrapped = (((safeBase + safeDelta) % 12) + 12) % 12;
  const step = CHROMATIC_PITCHES[wrapped];
  const octaveShift = Math.floor((safeBase + safeDelta) / 12);
  const adjustedFreq = step.freqHz * Math.pow(2, octaveShift);
  const deltaLabel =
    safeDelta === 0 ? 'Original (0 st)' : safeDelta > 0 ? `+${safeDelta} st` : `${safeDelta} st`;

  return {
    ...step,
    freqHz: Number(adjustedFreq.toFixed(2)),
    deltaLabel,
  };
}
