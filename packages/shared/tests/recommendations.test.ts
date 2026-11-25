import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BhajanIndexEntry } from '../src/types';
import {
  buildStreamQueue,
  computeSimilarBhajans,
  groupRecommendationsByRaga,
  normalizeRagaKey,
} from '../src/recommendations';

const SAMPLE_ENTRIES: BhajanIndexEntry[] = [
  {
    id: 'sundara-sundara-vinayaka',
    slug: 'sundara-sundara-vinayaka',
    title: 'Sundara Sundara Vinayaka',
    deity: 'Ganesha',
    ragaName: 'Bowli',
    beat: '8 Beat / Keherwa',
    searchText: 'sundara vinayaka ganesha bowli',
    phoneticTokens: ['sundara', 'vinayaka'],
    lyricsMissing: false,
    matchStatus: 'verified',
    missingFields: [],
    recordingCount: 1,
    metadataSource: 'sairhythms_verified',
    slugAliases: ['old-sundara-slug'],
  },
  {
    id: 'vinayaka-bowli-two',
    slug: 'vinayaka-bowli-two',
    title: 'Ganesha Charanam Bowli',
    deity: 'Ganesha',
    ragaName: 'Raga Bowli',
    beat: '8 Beat / Keherwa',
    searchText: 'ganesha charanam bowli',
    phoneticTokens: ['ganesha', 'charanam'],
    lyricsMissing: false,
    matchStatus: 'verified',
    missingFields: [],
    recordingCount: 2,
    metadataSource: 'sairhythms_verified',
  },
  {
    id: 'shiva-bowli-three',
    slug: 'shiva-bowli-three',
    title: 'Shiva Shambho Bowli',
    deity: 'Shiva',
    ragaName: 'Bowli',
    beat: '6 Beat / Dadra',
    searchText: 'shiva shambho bowli',
    phoneticTokens: ['shiva', 'shambho'],
    lyricsMissing: false,
    matchStatus: 'verified',
    missingFields: [],
    recordingCount: 1,
    metadataSource: 'sairhythms_verified',
  },
  {
    id: 'mohanam-devi',
    slug: 'mohanam-devi',
    title: 'Amba Bhavani',
    deity: 'Devi',
    ragaName: 'Mohanam',
    beat: '8 Beat / Keherwa',
    searchText: 'amba bhavani mohanam',
    phoneticTokens: ['amba', 'bhavani'],
    lyricsMissing: false,
    matchStatus: 'verified',
    missingFields: [],
    recordingCount: 1,
    metadataSource: 'sairhythms_verified',
  },
  {
    id: 'ganesha-kalyani',
    slug: 'ganesha-kalyani',
    title: 'Gajanana Kalyani',
    deity: 'Ganesha',
    ragaName: 'Kalyani',
    beat: '7 Beat / Rupak',
    searchText: 'gajanana kalyani',
    phoneticTokens: ['gajanana'],
    lyricsMissing: false,
    matchStatus: 'verified',
    missingFields: [],
    recordingCount: 0,
    metadataSource: 'sairhythms_verified',
  },
];

describe('Similar-Raga Recommendations & Stream Queue Engine', () => {
  it('normalizes raga names and ignores synthetic/unspecified placeholders', () => {
    assert.equal(normalizeRagaKey('Raga Bowli'), 'bowli');
    assert.equal(normalizeRagaKey('Mohanam Ragam'), 'mohanam');
    assert.equal(normalizeRagaKey('Pending Sai Rhythms Sync'), '');
    assert.equal(normalizeRagaKey('Traditional'), '');
  });

  it('ranks same-raga bhajans highest, resolves slugAliases, and groups shelves', () => {
    // Liked via old alias slug -> resolves to sundara-sundara-vinayaka (Bowli, Ganesha)
    const recs = computeSimilarBhajans(['old-sundara-slug'], SAMPLE_ENTRIES, { limit: 10 });
    assert.ok(recs.length >= 2);
    assert.equal(recs[0].entry.id, 'vinayaka-bowli-two');
    assert.ok(recs[0].reasons.some((r) => r.includes('Same Raga')));
    // Already-liked entry must not be recommended again
    assert.equal(recs.some((r) => r.entry.id === 'sundara-sundara-vinayaka'), false);

    // Next best same-raga candidate (even different deity) ranks ahead of different-raga candidates
    const bowliIds = recs.filter((r) => r.matchedRaga).map((r) => r.entry.id);
    assert.deepEqual(bowliIds, ['vinayaka-bowli-two', 'shiva-bowli-three']);

    const shelves = groupRecommendationsByRaga(recs, 3);
    assert.equal(shelves.length, 1);
    assert.equal(shelves[0].items.length, 2);
  });

  it('builds deterministic deduplicated queues for discovery, for_you, and liked_only', () => {
    const disc = buildStreamQueue(SAMPLE_ENTRIES, {
      mode: 'discovery',
      likedIds: ['sundara-sundara-vinayaka'],
      seed: 42,
    });
    // Excludes unplayable 0-recording item when playable items exist
    assert.equal(disc.some((e) => e.id === 'ganesha-kalyani'), false);
    assert.equal(disc.length, 4);

    const forYou = buildStreamQueue(SAMPLE_ENTRIES, {
      mode: 'for_you',
      likedIds: ['sundara-sundara-vinayaka'],
      seed: 42,
    });
    assert.equal(forYou.length, 4);
    assert.equal(new Set(forYou.map((e) => e.id)).size, forYou.length);
    assert.ok(['vinayaka-bowli-two', 'shiva-bowli-three', 'mohanam-devi'].includes(forYou[0].id));

    const likedOnly = buildStreamQueue(SAMPLE_ENTRIES, {
      mode: 'liked_only',
      likedIds: ['old-sundara-slug'],
      seed: 42,
    });
    assert.deepEqual(
      likedOnly.map((e) => e.id),
      ['sundara-sundara-vinayaka'],
    );
  });
});
