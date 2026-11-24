import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import golden from './phonetic-golden.json';
import {
  canonicalizeSanskritWordDetailed,
  computeLyricsOverlap,
  computeTitleSimilarity,
  evaluateMatchCandidate,
  normalizedWordSim,
  sanitizeTitle,
  type MatchIndexRecord,
} from '../src/phonetics';

const PARITY_EPSILON = 1e-9;

describe('Module 0 Sanskrit phonetic golden parity suite (TypeScript)', () => {
  it('contains at least 100 golden vectors across all categories', () => {
    const total =
      golden.wordCanonical.length +
      golden.sanitize.length +
      golden.wordPair.length +
      golden.titleSimilarity.length +
      golden.lyricsOverlap.length +
      golden.evaluateMatch.length;
    assert.ok(total >= 100, `Expected >= 100 golden vectors, found ${total}`);
  });

  it('canonicalizes Sanskrit word stems while preserving contrastive endings', () => {
    for (const v of golden.wordCanonical) {
      const actual = canonicalizeSanskritWordDetailed(v.input);
      assert.equal(actual.canonical, v.expectedCanonical, `input=${v.input}`);
      assert.equal(actual.schwaFolded, v.expectedSchwaFolded, `schwaFolded input=${v.input}`);
    }
  });

  it('sanitizes YouTube channel prefixes, hashtags, pipe suffixes, and tags', () => {
    for (const v of golden.sanitize) {
      assert.equal(sanitizeTitle(v.raw), v.expected, `raw=${v.raw}`);
    }
  });

  it('scores transliteration word pairs within strict parity & threshold bounds', () => {
    for (const v of golden.wordPair) {
      const score = normalizedWordSim(v.a, v.b);
      if ('minScore' in v && typeof v.minScore === 'number') {
        assert.ok(score >= v.minScore, `${v.a} ~ ${v.b}: ${score} < ${v.minScore}`);
      }
      if ('maxScore' in v && typeof v.maxScore === 'number') {
        assert.ok(score <= v.maxScore, `${v.a} ~ ${v.b}: ${score} > ${v.maxScore}`);
      }
      if ('expectedScore' in v && typeof v.expectedScore === 'number') {
        assert.ok(
          Math.abs(score - v.expectedScore) <= PARITY_EPSILON,
          `${v.a} ~ ${v.b}: expected ${v.expectedScore}, got ${score}`,
        );
      }
    }
  });

  it('scores bhajan title pairs with IDF stopword weighting and parity tolerance', () => {
    for (const v of golden.titleSimilarity) {
      const score = computeTitleSimilarity(v.a, v.b);
      const specItem = v as {
        a: string;
        b: string;
        minScore?: number;
        maxScore?: number;
        expectedScore?: number;
      };
      if (specItem.minScore !== undefined) {
        assert.ok(
          score >= specItem.minScore,
          `"${v.a}" vs "${v.b}": ${score} < ${specItem.minScore}`,
        );
      }
      if (specItem.maxScore !== undefined) {
        assert.ok(
          score <= specItem.maxScore,
          `"${v.a}" vs "${v.b}": ${score} > ${specItem.maxScore}`,
        );
      }
      if (specItem.expectedScore !== undefined) {
        assert.ok(
          Math.abs(score - specItem.expectedScore) <= PARITY_EPSILON,
          `"${v.a}" vs "${v.b}": expected ${specItem.expectedScore}, got ${score}`,
        );
      }
    }
  });

  it('evaluates lyrics overlap stripping repetition cues within parity tolerance', () => {
    for (const v of golden.lyricsOverlap) {
      const score = computeLyricsOverlap(v.linesA, v.linesB);
      const specItem = v as {
        linesA: string[];
        linesB: string[];
        minScore?: number;
        maxScore?: number;
        expectedScore?: number;
      };
      if (specItem.minScore !== undefined) {
        assert.ok(score >= specItem.minScore, `lyrics overlap ${score} < ${specItem.minScore}`);
      }
      if (specItem.maxScore !== undefined) {
        assert.ok(score <= specItem.maxScore, `lyrics overlap ${score} > ${specItem.maxScore}`);
      }
      if (specItem.expectedScore !== undefined) {
        assert.ok(
          Math.abs(score - specItem.expectedScore) <= PARITY_EPSILON,
          `lyrics overlap expected ${specItem.expectedScore}, got ${score}`,
        );
      }
    }
  });

  it('enforces ordered match evaluation precedence (doNotMerge -> alias -> lyrics -> title)', () => {
    for (const v of golden.evaluateMatch) {
      const item = v as {
        name: string;
        queryTitle: string;
        queryLyrics?: string[];
        queryId?: string;
        candidates: MatchIndexRecord[];
        entityAliases?: Record<string, string>;
        doNotMergePairs?: string[];
        expectedStatus: string;
        expectedBestTargetId: string | null;
        expectedReason?: string;
        expectedScore?: number;
      };
      const result = evaluateMatchCandidate({
        queryTitle: item.queryTitle,
        queryLyrics: item.queryLyrics,
        queryId: item.queryId,
        candidates: item.candidates,
        entityAliases: item.entityAliases,
        doNotMergePairs: item.doNotMergePairs,
      });
      assert.equal(result.matchStatus, item.expectedStatus, `${item.name} status`);
      assert.equal(result.bestTargetId, item.expectedBestTargetId, `${item.name} target`);
      if (item.expectedReason !== undefined) {
        assert.equal(result.reason, item.expectedReason, `${item.name} reason`);
      }
      if (item.expectedScore !== undefined) {
        assert.ok(
          Math.abs(result.bestScore - item.expectedScore) <= PARITY_EPSILON,
          `${item.name} score: expected ${item.expectedScore}, got ${result.bestScore}`,
        );
      }
    }
  });
});
