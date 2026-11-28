import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Bhajan, BhajanIndexEntry } from '../src/types';
import {
  buildStreamQueue,
  computeSimilarBhajans,
  groupRecommendationsByRaga,
  isKaraokeOrInstrumentalRecording,
  isSpecialOrInstrumentalTrack,
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

  it('excludes instrumental/karaoke/special tracks from Random Stream & prefers vocal recordings over karaoke', () => {
    const entriesWithSpecials: BhajanIndexEntry[] = [
      ...SAMPLE_ENTRIES,
      {
        id: 'inst-veena-1',
        slug: 'inst-veena-1',
        title: 'Durga Bhavani Ma Jaya Jaya Sai Ma (Instrumental)',
        searchText: 'durga bhavani instrumental veena',
        phoneticTokens: ['durga', 'bhavani'],
        lyricsMissing: false,
        matchStatus: 'verified',
        missingFields: [],
        recordingCount: 1,
        metadataSource: 'youtube_sss_bhajans',
        trackType: 'instrumental',
      },
      {
        id: 'karaoke-1',
        slug: 'karaoke-1',
        title: 'Sri Guru Paduka Stotram (Karaoke)',
        searchText: 'guru paduka stotram karaoke',
        phoneticTokens: ['guru', 'paduka'],
        lyricsMissing: false,
        matchStatus: 'verified',
        missingFields: [],
        recordingCount: 1,
        metadataSource: 'youtube_sss_bhajans',
        trackType: 'karaoke',
      },
      {
        id: 'special-sama-1',
        slug: 'special-sama-1',
        title: 'Why Fear When I Am Here (SAMA - 04)',
        searchText: 'why fear when i am here sama',
        phoneticTokens: ['why', 'fear'],
        lyricsMissing: false,
        matchStatus: 'verified',
        missingFields: [],
        recordingCount: 1,
        metadataSource: 'youtube_sss_bhajans',
        trackType: 'special',
      },
    ];

    assert.equal(isSpecialOrInstrumentalTrack({ title: 'Pranamami Sri Durge | Soothing Instrumental' }), true);
    assert.equal(isKaraokeOrInstrumentalRecording({ label: 'Gents_Karaoke_C_Pancham.mp3' }), true);

    const disc = buildStreamQueue(entriesWithSpecials, {
      mode: 'discovery',
      likedIds: [],
      seed: 7,
    });
    assert.equal(disc.some((e) => e.id === 'inst-veena-1'), false);
    assert.equal(disc.some((e) => e.id === 'karaoke-1'), false);
    assert.equal(disc.some((e) => e.id === 'special-sama-1'), false);
    assert.equal(disc.length, 4);

    // Future opt-in instrumental stream explicitly includes only instrumental tracks
    const instOnly = buildStreamQueue(entriesWithSpecials, {
      mode: 'discovery',
      likedIds: [],
      includeTrackTypes: ['instrumental'],
      seed: 7,
    });
    assert.deepEqual(
      instOnly.map((e) => e.id),
      ['inst-veena-1'],
    );

    // For a regular bhajan, pickStreamRecording avoids choosing Karaoke MP3 ahead of Reference vocal MP3
    const withKaraokeFirst = {
      id: 'rama-krishna',
      title: 'Rama Krishna Hari Narayana',
      trackType: 'bhajan',
      recordings: [
        {
          id: 'sair_karaoke',
          label: 'Sai Rhythms Reference Audio (Rama_Krishna_Gents_Karaoke_C_Pancham.mp3)',
          collection: 'sairhythms_ref',
          externalUrl: 'https://sairhythms.sathyasai.org/audio/Rama_Krishna_Gents_Karaoke_C_Pancham.mp3',
        },
        {
          id: 'sair_vocal',
          label: 'Sai Rhythms Reference Audio (rama-krishna-hari-narayana.mp3)',
          collection: 'sairhythms_ref',
          externalUrl: 'https://sairhythms.sathyasai.org/audio/rama-krishna-hari-narayana.mp3',
        },
      ],
    } as unknown as Bhajan;
    assert.equal(pickStreamRecording(withKaraokeFirst, 'audio').recording?.id, 'sair_vocal');
  });

  it('matches both Hanuman and legacy Anjaneya deity entries under Hanuman filter', () => {
    const deityEntries: BhajanIndexEntry[] = [
      {
        id: 'hanuman-1',
        slug: 'hanuman-1',
        title: 'Rama Lakshmana Janaki Jai Bolo Hanuman Ki',
        deity: 'Hanuman',
        searchText: 'rama lakshmana janaki hanuman',
        phoneticTokens: ['rama', 'lakshmana', 'hanuman'],
        lyricsMissing: false,
        matchStatus: 'verified',
        recordingCount: 1,
        metadataSource: 'sairhythms_verified',
      },
      {
        id: 'anjaneya-1',
        slug: 'anjaneya-1',
        title: 'Anjana Nanda Veeram',
        deity: 'Anjaneya',
        searchText: 'anjana nanda veeram anjaneya',
        phoneticTokens: ['anjana', 'nanda', 'veeram'],
        lyricsMissing: false,
        matchStatus: 'verified',
        recordingCount: 1,
        metadataSource: 'sairhythms_verified',
      },
      {
        id: 'shiva-1',
        slug: 'shiva-1',
        title: 'Shiva Shiva Shambho',
        deity: 'Shiva',
        searchText: 'shiva shambho',
        phoneticTokens: ['shiva', 'shambho'],
        lyricsMissing: false,
        matchStatus: 'verified',
        recordingCount: 1,
        metadataSource: 'sairhythms_verified',
      },
    ];
    const filtered = buildStreamQueue(deityEntries, {
      mode: 'discovery',
      likedIds: [],
      deityFilter: 'Hanuman',
      seed: 3,
    });
    assert.deepEqual(filtered.map((e) => e.id).sort(), ['anjaneya-1', 'hanuman-1']);
  });
});
