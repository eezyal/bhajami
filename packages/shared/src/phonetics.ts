import spec from '../data/indic-phonetics.json';
import type { MatchStatus } from './types';

export interface CanonicalWordResult {
  canonical: string;
  schwaFolded: boolean;
}

export interface MatchIndexRecord {
  id: string;
  title: string;
  lyricsLines?: readonly string[];
}

export interface EvaluateMatchInput {
  queryTitle: string;
  queryLyrics?: readonly string[];
  queryId?: string;
  candidates: readonly MatchIndexRecord[];
  entityAliases?: Readonly<Record<string, string>>;
  doNotMergePairs?: ReadonlySet<string> | readonly string[];
}

export interface EvaluatedCandidateScore {
  targetBhajanId: string;
  targetTitle: string;
  score: number;
  reason: string;
  lyricsOverlap?: number;
}

export interface EvaluateMatchResult {
  sanitizedTitle: string;
  canonicalPhrase: string;
  matchStatus: MatchStatus;
  bestTargetId: string | null;
  bestScore: number;
  reason: string;
  matchCandidates: EvaluatedCandidateScore[];
}

const DIACRITIC_MAP: Record<string, string> = spec.diacriticMap;
const IDF_WEIGHTS: Record<string, number> = spec.idfWeights;
const TOKEN_ALIASES: Record<string, string> = spec.tokenAliases ?? {};
const NASAL_EXCEPTIONS = new Set(spec.nasalStemExceptions);

const LEADING_NUM_RE = new RegExp(spec.sanitizer.leadingNumberRegex);
const PIPE_SUFFIX_RES = spec.sanitizer.pipeSuffixRegexes.map((p) => new RegExp(p, 'gi'));
const HASHTAG_RE = new RegExp(spec.sanitizer.hashtagRegex, 'g');
const BRACKETED_TAG_RE = new RegExp(spec.sanitizer.bracketedTagRegex, 'gi');
const TRAILING_TAG_RE = new RegExp(spec.sanitizer.trailingTagRegex, 'i');
const REPETITION_RE = new RegExp(spec.repetitionRegex, 'gi');
const PUNCTUATION_RE = new RegExp(spec.punctuationRegex, 'g');
const VOWEL_CONSONANT_RES: Array<[RegExp, string]> = spec.vowelAndConsonantRules.map(
  ([pattern, repl]) => [new RegExp(pattern, 'g'), repl],
);
const COLLAPSE_CONSONANT_RE = new RegExp(spec.collapseDoubledConsonantsRegex, 'g');

const INTERIOR_VOWEL_COSTS = new Map<string, number>();
for (const [a, b, cost] of spec.substitutionCosts.interiorVowelPairs) {
  const sa = String(a);
  const sb = String(b);
  const c = Number(cost);
  INTERIOR_VOWEL_COSTS.set(`${sa}:${sb}`, c);
  INTERIOR_VOWEL_COSTS.set(`${sb}:${sa}`, c);
}

const SINGLE_CHAR_COSTS = new Map<string, number>();
for (const [a, b, cost] of spec.substitutionCosts.singleCharPairs) {
  const sa = String(a);
  const sb = String(b);
  const c = Number(cost);
  SINGLE_CHAR_COSTS.set(`${sa}:${sb}`, c);
  SINGLE_CHAR_COSTS.set(`${sb}:${sa}`, c);
}

const DIGRAPH_TRANSITIONS: Array<{ from: string; to: string; cost: number }> = [];
for (const [a, b, cost] of spec.substitutionCosts.digraphPairs) {
  const sa = String(a);
  const sb = String(b);
  const c = Number(cost);
  DIGRAPH_TRANSITIONS.push({ from: sa, to: sb, cost: c });
  DIGRAPH_TRANSITIONS.push({ from: sb, to: sa, cost: c });
}

/**
 * Strips catalog numbers, YouTube channel pipe suffixes, hashtags, and arrangement
 * annotations while preserving core bhajan title words.
 */
export function sanitizeTitle(rawTitle: string): string {
  let s = String(rawTitle || '').normalize('NFKC').trim();
  s = s.replace(HASHTAG_RE, ' ');
  for (const re of PIPE_SUFFIX_RES) {
    s = s.replace(re, ' ');
  }
  s = s.replace(BRACKETED_TAG_RE, ' ');
  s = s.replace(LEADING_NUM_RE, '');
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(TRAILING_TAG_RE, '').trim();
  }
  return s.replace(/\s+/g, ' ').trim();
}

function foldDiacriticsAndPunct(text: string): string {
  const lower = text.normalize('NFKC').toLowerCase();
  let mapped = '';
  for (const ch of lower) {
    mapped += DIACRITIC_MAP[ch] ?? ch;
  }
  return mapped.replace(PUNCTUATION_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Canonicalizes a single transliterated Sanskrit/bhajan token while preserving
 * contrastive final vowels and flagging optional nasal-stem schwa folds.
 */
export function canonicalizeSanskritWordDetailed(rawWord: string): CanonicalWordResult {
  let w = foldDiacriticsAndPunct(rawWord).replace(/\s+/g, '');
  if (!w) {
    return { canonical: '', schwaFolded: false };
  }

  for (const [re, repl] of VOWEL_CONSONANT_RES) {
    w = w.replace(re, repl);
  }
  w = w.replace(COLLAPSE_CONSONANT_RE, '$1');

  if (TOKEN_ALIASES[w]) {
    w = TOKEN_ALIASES[w];
  }

  if (w.endsWith('a') && w.length > 2) {
    const stem = w.slice(0, -1);
    if (NASAL_EXCEPTIONS.has(stem)) {
      return { canonical: stem, schwaFolded: true };
    }
  }

  return { canonical: w, schwaFolded: false };
}

export function canonicalizeSanskritWord(rawWord: string): string {
  return canonicalizeSanskritWordDetailed(rawWord).canonical;
}

export function canonicalizePhrase(rawText: string): string {
  const cleaned = foldDiacriticsAndPunct(sanitizeTitle(rawText));
  if (!cleaned) return '';
  return cleaned
    .split(/\s+/)
    .map((tok) => canonicalizeSanskritWord(tok))
    .filter(Boolean)
    .join(' ');
}

function tokenizePhraseDetailed(rawText: string): CanonicalWordResult[] {
  const cleaned = foldDiacriticsAndPunct(sanitizeTitle(rawText));
  if (!cleaned) return [];
  return cleaned
    .split(/\s+/)
    .map((tok) => canonicalizeSanskritWordDetailed(tok))
    .filter((res) => res.canonical.length > 0);
}

function weightedWordDistance(
  resA: CanonicalWordResult,
  resB: CanonicalWordResult,
): number {
  const a = resA.canonical;
  const b = resB.canonical;
  const m = a.length;
  const n = b.length;

  if (m === 0 && n === 0) return 0;

  const defaultEdit = spec.substitutionCosts.defaultEdit;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array<number>(n + 1).fill(Number.POSITIVE_INFINITY),
  );
  dp[0][0] = 0;

  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= n; j++) {
      const cur = dp[i][j];
      if (i < m && cur + defaultEdit < dp[i + 1][j]) {
        dp[i + 1][j] = cur + defaultEdit;
      }
      if (j < n && cur + defaultEdit < dp[i][j + 1]) {
        dp[i][j + 1] = cur + defaultEdit;
      }
      if (i < m && j < n) {
        const ca = a[i];
        const cb = b[j];
        let subCost = defaultEdit;
        if (ca === cb) {
          subCost = 0;
        } else if (i < m - 1 && j < n - 1 && INTERIOR_VOWEL_COSTS.has(`${ca}:${cb}`)) {
          subCost = INTERIOR_VOWEL_COSTS.get(`${ca}:${cb}`)!;
        } else if (SINGLE_CHAR_COSTS.has(`${ca}:${cb}`)) {
          subCost = SINGLE_CHAR_COSTS.get(`${ca}:${cb}`)!;
        }
        if (cur + subCost < dp[i + 1][j + 1]) {
          dp[i + 1][j + 1] = cur + subCost;
        }
      }

      for (const tr of DIGRAPH_TRANSITIONS) {
        const lenF = tr.from.length;
        const lenT = tr.to.length;
        if (
          i + lenF <= m &&
          j + lenT <= n &&
          a.slice(i, i + lenF) === tr.from &&
          b.slice(j, j + lenT) === tr.to &&
          cur + tr.cost < dp[i + lenF][j + lenT]
        ) {
          dp[i + lenF][j + lenT] = cur + tr.cost;
        }
      }
    }
  }

  let dist = dp[m][n];
  if (resA.schwaFolded !== resB.schwaFolded) {
    dist += spec.schwaFoldPenalty;
  }
  return dist;
}

function normalizedWordSimFromResults(
  resA: CanonicalWordResult,
  resB: CanonicalWordResult,
): number {
  const maxLen = Math.max(resA.canonical.length, resB.canonical.length, 1);
  if (resA.canonical.length === 0 && resB.canonical.length === 0) return 1.0;
  const dist = weightedWordDistance(resA, resB);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Computes weighted phonetic similarity in [0, 1] between two Sanskrit/bhajan words.
 */
export function normalizedWordSim(wordA: string, wordB: string): number {
  const resA = canonicalizeSanskritWordDetailed(wordA);
  const resB = canonicalizeSanskritWordDetailed(wordB);
  return normalizedWordSimFromResults(resA, resB);
}

function getIdfWeight(canonicalToken: string): number {
  return IDF_WEIGHTS[canonicalToken] ?? 1.0;
}

/**
 * Computes IDF-weighted greedy bipartite similarity in [0, 1] between two bhajan titles.
 */
export function computeTitleSimilarity(titleA: string, titleB: string): number {
  const toksA = tokenizePhraseDetailed(titleA);
  const toksB = tokenizePhraseDetailed(titleB);
  if (toksA.length === 0 && toksB.length === 0) return 1.0;
  if (toksA.length === 0 || toksB.length === 0) return 0.0;

  interface PairCandidate {
    sim: number;
    weight: number;
    i: number;
    j: number;
  }

  const pairs: PairCandidate[] = [];
  for (let i = 0; i < toksA.length; i++) {
    for (let j = 0; j < toksB.length; j++) {
      const sim = normalizedWordSimFromResults(toksA[i], toksB[j]);
      const weight = Math.max(
        getIdfWeight(toksA[i].canonical),
        getIdfWeight(toksB[j].canonical),
      );
      pairs.push({ sim, weight, i, j });
    }
  }

  pairs.sort((p, q) => {
    if (q.sim !== p.sim) return q.sim - p.sim;
    if (q.weight !== p.weight) return q.weight - p.weight;
    if (p.i !== q.i) return p.i - q.i;
    return p.j - q.j;
  });

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  let matchedWeightedSum = 0;
  let totalWeightSum = 0;

  for (const pair of pairs) {
    if (usedA.has(pair.i) || usedB.has(pair.j)) continue;
    usedA.add(pair.i);
    usedB.add(pair.j);
    matchedWeightedSum += pair.weight * pair.sim;
    totalWeightSum += pair.weight;
  }

  for (let i = 0; i < toksA.length; i++) {
    if (!usedA.has(i)) totalWeightSum += getIdfWeight(toksA[i].canonical);
  }
  for (let j = 0; j < toksB.length; j++) {
    if (!usedB.has(j)) totalWeightSum += getIdfWeight(toksB[j].canonical);
  }

  return totalWeightSum > 0 ? matchedWeightedSum / totalWeightSum : 0.0;
}

function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0.0;
}

function buildChar4Grams(text: string): Set<string> {
  const grams = new Set<string>();
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return grams;
  if (compact.length < 4) {
    grams.add(compact);
    return grams;
  }
  for (let i = 0; i <= compact.length - 4; i++) {
    grams.add(compact.slice(i, i + 4));
  }
  return grams;
}

function lineSetJaccardPhonetic(normA: readonly string[], normB: readonly string[]): number {
  const uniqA = Array.from(new Set(normA)).sort();
  const uniqB = Array.from(new Set(normB)).sort();
  if (uniqA.length === 0 && uniqB.length === 0) return 1.0;
  if (uniqA.length === 0 || uniqB.length === 0) return 0.0;

  const setB = new Set(uniqB);
  const remA: string[] = [];
  const matchedB = new Set<string>();
  let matches = 0;

  for (const la of uniqA) {
    if (setB.has(la) && !matchedB.has(la)) {
      matchedB.add(la);
      matches++;
    } else {
      remA.push(la);
    }
  }
  const remB = uniqB.filter((lb) => !matchedB.has(lb));

  const fuzzyPairs: Array<{ sim: number; minStr: string; maxStr: string; ia: number; ib: number }> =
    [];
  for (let ia = 0; ia < remA.length; ia++) {
    for (let ib = 0; ib < remB.length; ib++) {
      const sim = computeTitleSimilarity(remA[ia], remB[ib]);
      if (sim >= spec.thresholds.autoMerge) {
        const la = remA[ia];
        const lb = remB[ib];
        fuzzyPairs.push({
          sim,
          minStr: la <= lb ? la : lb,
          maxStr: la <= lb ? lb : la,
          ia,
          ib,
        });
      }
    }
  }

  fuzzyPairs.sort((p, q) => {
    if (q.sim !== p.sim) return q.sim - p.sim;
    if (p.minStr !== q.minStr) return p.minStr < q.minStr ? -1 : 1;
    if (p.maxStr !== q.maxStr) return p.maxStr < q.maxStr ? -1 : 1;
    return 0;
  });

  const usedRemA = new Set<number>();
  const usedRemB = new Set<number>();
  for (const fp of fuzzyPairs) {
    if (usedRemA.has(fp.ia) || usedRemB.has(fp.ib)) continue;
    usedRemA.add(fp.ia);
    usedRemB.add(fp.ib);
    matches++;
  }

  const union = uniqA.length + uniqB.length - matches;
  return union > 0 ? matches / union : 0.0;
}

/**
 * Strips repetition markers like `(2)`, `(2 times)`, `(3x)` and computes
 * `0.60 * lineJaccard + 0.40 * char4gramJaccard` over canonicalized lyric lines.
 */
export function computeLyricsOverlap(
  linesA: readonly string[],
  linesB: readonly string[],
): number {
  const cleanLines = (lines: readonly string[]): string[] =>
    lines
      .map((line) => canonicalizePhrase(line.replace(REPETITION_RE, ' ')))
      .filter((line) => line.length > 0);

  const normA = cleanLines(linesA);
  const normB = cleanLines(linesB);
  if (normA.length === 0 || normB.length === 0) return 0.0;

  const lineJaccard = lineSetJaccardPhonetic(normA, normB);
  const gramJaccard = jaccardSimilarity(
    buildChar4Grams(normA.join(' ')),
    buildChar4Grams(normB.join(' ')),
  );

  return (
    spec.lyricsWeights.lineJaccard * lineJaccard +
    spec.lyricsWeights.char4gramJaccard * gramJaccard
  );
}

export function makeDoNotMergeKey(entityA: string, entityB: string): string {
  const a = String(entityA || '').trim();
  const b = String(entityB || '').trim();
  return a <= b ? `${a}__${b}` : `${b}__${a}`;
}

/**
 * Evaluates a candidate query title (+ optional lyrics) against catalog index records
 * using the ordered verification precedence:
 * `(1) doNotMergePairs -> (2) entityAliases -> (3) lyrics overlap gate -> (4) title similarity`.
 */
export function evaluateMatchCandidate(input: EvaluateMatchInput): EvaluateMatchResult {
  const sanitized = sanitizeTitle(input.queryTitle);
  const canonical = canonicalizePhrase(sanitized);
  const doNotMerge =
    input.doNotMergePairs instanceof Set
      ? input.doNotMergePairs
      : new Set(input.doNotMergePairs ?? []);

  const isPairBlocked = (targetId: string): boolean => {
    if (input.queryId && doNotMerge.has(makeDoNotMergeKey(input.queryId, targetId))) {
      return true;
    }
    if (canonical && doNotMerge.has(makeDoNotMergeKey(canonical, targetId))) {
      return true;
    }
    return false;
  };

  if (canonical && input.entityAliases?.[canonical]) {
    const aliasTargetId = input.entityAliases[canonical];
    if (!isPairBlocked(aliasTargetId)) {
      const targetRec = input.candidates.find((c) => c.id === aliasTargetId);
      const targetTitle = targetRec?.title ?? aliasTargetId;
      return {
        sanitizedTitle: sanitized,
        canonicalPhrase: canonical,
        matchStatus: 'verified',
        bestTargetId: aliasTargetId,
        bestScore: 1.0,
        reason: 'entity_alias',
        matchCandidates: [
          {
            targetBhajanId: aliasTargetId,
            targetTitle,
            score: 1.0,
            reason: 'entity_alias',
          },
        ],
      };
    }
  }

  const nonEmptyQueryLyrics = (input.queryLyrics ?? [])
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const scored: EvaluatedCandidateScore[] = [];
  for (const cand of input.candidates) {
    if (isPairBlocked(cand.id)) {
      continue;
    }

    const titleSim = computeTitleSimilarity(sanitized, cand.title);
    const nonEmptyCandLyrics = (cand.lyricsLines ?? [])
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let lyricsOverlap: number | undefined;
    let effectiveScore = titleSim;
    let reason = 'title_similarity';

    if (nonEmptyQueryLyrics.length >= 2 && nonEmptyCandLyrics.length >= 2) {
      lyricsOverlap = computeLyricsOverlap(nonEmptyQueryLyrics, nonEmptyCandLyrics);
      if (lyricsOverlap >= spec.thresholds.lyricsOverlapMin) {
        effectiveScore = Math.max(titleSim, lyricsOverlap);
        reason = 'lyrics_confirmed';
      } else {
        reason = titleSim >= spec.thresholds.autoMerge ? 'lyrics_mismatch' : 'lyrics_low_overlap';
      }
    }

    scored.push({
      targetBhajanId: cand.id,
      targetTitle: cand.title,
      score: effectiveScore,
      reason,
      ...(lyricsOverlap !== undefined ? { lyricsOverlap } : {}),
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.targetBhajanId < b.targetBhajanId
      ? -1
      : a.targetBhajanId > b.targetBhajanId
        ? 1
        : 0;
  });

  if (scored.length === 0) {
    return {
      sanitizedTitle: sanitized,
      canonicalPhrase: canonical,
      matchStatus: 'unmatched',
      bestTargetId: null,
      bestScore: 0.0,
      reason: input.candidates.length > 0 ? 'do_not_merge_excluded' : 'no_candidates',
      matchCandidates: [],
    };
  }

  const best = scored[0];
  const topCandidates = scored
    .filter((c) => c.score >= spec.thresholds.reviewMin || c === best)
    .slice(0, 5);

  if (best.reason === 'lyrics_confirmed' && best.score >= spec.thresholds.reviewMin) {
    const competingConfirmed = scored
      .slice(1)
      .some(
        (c) =>
          c.targetBhajanId !== best.targetBhajanId &&
          c.reason === 'lyrics_confirmed' &&
          c.score >= spec.thresholds.autoMerge &&
          best.score >= spec.thresholds.autoMerge,
      );
    if (competingConfirmed) {
      return {
        sanitizedTitle: sanitized,
        canonicalPhrase: canonical,
        matchStatus: 'needs_verification',
        bestTargetId: best.targetBhajanId,
        bestScore: best.score,
        reason: 'ambiguous_title',
        matchCandidates: topCandidates,
      };
    }
    return {
      sanitizedTitle: sanitized,
      canonicalPhrase: canonical,
      matchStatus: 'verified',
      bestTargetId: best.targetBhajanId,
      bestScore: best.score,
      reason: 'lyrics_confirmed',
      matchCandidates: topCandidates,
    };
  }

  if (best.reason === 'lyrics_mismatch') {
    return {
      sanitizedTitle: sanitized,
      canonicalPhrase: canonical,
      matchStatus: 'needs_verification',
      bestTargetId: best.targetBhajanId,
      bestScore: best.score,
      reason: 'lyrics_mismatch',
      matchCandidates: topCandidates,
    };
  }

  if (best.score >= spec.thresholds.autoMerge) {
    const duplicateHighMatch = scored
      .slice(1)
      .some(
        (c) =>
          c.targetBhajanId !== best.targetBhajanId &&
          c.score >= spec.thresholds.autoMerge,
      );
    if (duplicateHighMatch) {
      return {
        sanitizedTitle: sanitized,
        canonicalPhrase: canonical,
        matchStatus: 'needs_verification',
        bestTargetId: best.targetBhajanId,
        bestScore: best.score,
        reason: 'ambiguous_title',
        matchCandidates: topCandidates,
      };
    }
    return {
      sanitizedTitle: sanitized,
      canonicalPhrase: canonical,
      matchStatus: 'verified',
      bestTargetId: best.targetBhajanId,
      bestScore: best.score,
      reason: 'high_confidence_title',
      matchCandidates: topCandidates,
    };
  }

  if (best.score >= spec.thresholds.reviewMin) {
    return {
      sanitizedTitle: sanitized,
      canonicalPhrase: canonical,
      matchStatus: 'needs_verification',
      bestTargetId: best.targetBhajanId,
      bestScore: best.score,
      reason: best.reason === 'lyrics_low_overlap' ? 'lyrics_mismatch' : 'doubt_band',
      matchCandidates: topCandidates,
    };
  }

  return {
    sanitizedTitle: sanitized,
    canonicalPhrase: canonical,
    matchStatus: 'unmatched',
    bestTargetId: null,
    bestScore: best.score,
    reason: 'below_threshold',
    matchCandidates: [],
  };
}
