import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Bhajan, BhajanIndexEntry } from '../src/types';
import {
  buildStreamQueue,
  computeSimilarBhajans,
  groupRecommendationsByRaga,
  normalizeRagaKey,
  pickStreamRecording,
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

  it('prefers direct audio in audio mode and YouTube in video mode with graceful fallback', () => {
    const dualBhajan = {
      id: 'dual-1',
      recordings: [
        {
          id: 'yt_abc',
          label: 'YouTube Recording',
          collection: 'youtube_prasanthi_mandir_live',
          youtubeVideoId: 'abc123XYZ',
          embeddable: true,
        },
        {
          id: 'mp3_1',
          label: 'Sai Rhythms Audio',
          collection: 'sairhythms_ref',
          externalUrl: 'https://sairhythms.sathyasai.org/audio/sample.mp3',
        },
      ],
    } as unknown as Bhajan;

    const audioPick = pickStreamRecording(dualBhajan, 'audio');
    assert.equal(audioPick.recording?.id, 'mp3_1');
    assert.equal(audioPick.hasAudioOption, true);
    assert.equal(audioPick.hasVideoOption, true);

    const videoPick = pickStreamRecording(dualBhajan, 'video');
    assert.equal(videoPick.recording?.id, 'yt_abc');

    const audioOnlyBhajan = {
      id: 'audio-only',
      recordings: [dualBhajan.recordings[1]],
    } as unknown as Bhajan;
    assert.equal(pickStreamRecording(audioOnlyBhajan, 'video').recording?.id, 'mp3_1');
    assert.equal(pickStreamRecording(audioOnlyBhajan, 'video').hasVideoOption, false);

    const ytOnlyBhajan = {
      id: 'yt-only',
      recordings: [dualBhajan.recordings[0]],
    } as unknown as Bhajan;
    assert.equal(pickStreamRecording(ytOnlyBhajan, 'audio').recording?.id, 'yt_abc');
    assert.equal(pickStreamRecording(ytOnlyBhajan, 'audio').hasAudioOption, false);

    const multiMp3Bhajan = {
      id: 'multi-mp3',
      recordings: [
        dualBhajan.recordings[1],
        {
          id: 'sssmc_001',
          label: 'SSS Media Centre — A Bhajan A Day',
          collection: 'sssmediacentre_bhajan_a_day',
          externalUrl: 'https://content.sssmediacentre.org/audio/sample.mp3',
        },
      ],
    } as unknown as Bhajan;
    assert.equal(pickStreamRecording(multiMp3Bhajan, 'audio').recording?.id, 'sssmc_001');
  });

  it('includes both direct-audio and YouTube tracks in unified discovery queues across modes', () => {
    const mixedEntries: BhajanIndexEntry[] = [
      {
        id: 'yt-only-track',
        slug: 'yt-only-track',
        title: 'YouTube Only Bhajan',
        searchText: 'youtube only bhajan',
        phoneticTokens: ['bhajan'],
        lyricsMissing: true,
        matchStatus: 'unmatched',
        missingFields: ['lyrics'],
        recordingCount: 1,
        hasDirectAudio: false,
        metadataSource: 'youtube_sss_bhajans',
      },
      {
        id: 'mp3-track',
        slug: 'mp3-track',
        title: 'Direct Audio Bhajan',
        searchText: 'direct audio bhajan',
        phoneticTokens: ['bhajan'],
        lyricsMissing: false,
        matchStatus: 'verified',
        missingFields: [],
        recordingCount: 1,
        hasDirectAudio: true,
        metadataSource: 'sairhythms_verified',
      },
    ];

    const audioQueue = buildStreamQueue(mixedEntries, {
      mode: 'discovery',
      likedIds: [],
      mediaMode: 'audio',
      seed: 1,
    });
    assert.deepEqual(
      audioQueue.map((e) => e.id).sort(),
      ['mp3-track', 'yt-only-track'],
    );

    const videoQueue = buildStreamQueue(mixedEntries, {
      mode: 'discovery',
      likedIds: [],
      mediaMode: 'video',
      seed: 1,
    });
    assert.deepEqual(
      videoQueue.map((e) => e.id).sort(),
      ['mp3-track', 'yt-only-track'],
    );
  });

  it('honors admin defaultRecordingId / isDefault and user preferredRecordingId override', () => {
    const multiVersionBhajan = {
      id: 'multi-ver-1',
      defaultRecordingId: 'yt_best',
      recordings: [
        {
          id: 'sssmc_001',
          label: 'SSS Media Centre MP3',
          collection: 'sssmediacentre_bhajan_a_day',
          externalUrl: 'https://content.sssmediacentre.org/audio/sample.mp3',
        },
        {
          id: 'mp3_alt',
          label: 'Sai Rhythms Reference',
          collection: 'sairhythms_ref',
          externalUrl: 'https://sairhythms.sathyasai.org/audio/alt.mp3',
        },
        {
          id: 'yt_best',
          label: 'Prasanthi Mandir Video',
          collection: 'youtube_prasanthi_mandir_live',
          youtubeVideoId: 'ytBest123',
          embeddable: true,
          isDefault: true,
        },
      ],
    } as unknown as Bhajan;

    // Admin marked yt_best as default -> plays by default in audio stream mode
    const defaultPick = pickStreamRecording(multiVersionBhajan, 'audio');
    assert.equal(defaultPick.recording?.id, 'yt_best');
    assert.equal(defaultPick.defaultRecordingId, 'yt_best');

    // User explicitly picks an alternate MP3 version -> overrides default
    const userPick = pickStreamRecording(multiVersionBhajan, 'audio', 'mp3_alt');
    assert.equal(userPick.recording?.id, 'mp3_alt');
    assert.equal(userPick.defaultRecordingId, 'yt_best');

    // When admin default is direct audio, switching to video mode still picks video
    const audioDefaultBhajan = {
      id: 'multi-ver-2',
      defaultRecordingId: 'mp3_alt',
      recordings: [
        {
          id: 'mp3_alt',
          label: 'Sai Rhythms Reference',
          collection: 'sairhythms_ref',
          externalUrl: 'https://sairhythms.sathyasai.org/audio/alt.mp3',
          isDefault: true,
        },
        {
          id: 'sssmc_001',
          label: 'SSS Media Centre MP3',
          collection: 'sssmediacentre_bhajan_a_day',
          externalUrl: 'https://content.sssmediacentre.org/audio/sample.mp3',
        },
        {
          id: 'yt_best',
          label: 'Prasanthi Mandir Video',
          collection: 'youtube_prasanthi_mandir_live',
          youtubeVideoId: 'ytBest123',
          embeddable: true,
        },
      ],
    } as unknown as Bhajan;

    assert.equal(pickStreamRecording(audioDefaultBhajan, 'audio').recording?.id, 'mp3_alt');
    assert.equal(pickStreamRecording(audioDefaultBhajan, 'video').recording?.id, 'yt_best');
    assert.equal(pickStreamRecording(audioDefaultBhajan, 'video', 'sssmc_001').recording?.id, 'sssmc_001');
  });
});
