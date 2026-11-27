import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  fetchCloudBhajanDetail,
  fetchCloudCatalogIndex,
  fromFirestoreFields,
  parseFirestoreBhajan,
} from '../src/lib/cloud-catalog';
import {
  buildYouTubeWatchUrl,
  cleanYouTubeDisplayTitle,
  filterBhajanIndexEntries,
  resolveDefaultApiBase,
  resolvePlaybackAction,
} from '../src/lib/search-and-playback';
import { SPLASH_STATUS_STEPS, SPLASH_WORDMARK_SEQUENCE } from '../src/lib/splash-sequence';
import { canonicalizePhrase, pickStreamRecording, type BhajanIndexEntry } from '@bhajami/shared';

test('cleanYouTubeDisplayTitle & parseFirestoreBhajan handle legacy YouTube and nullable fields safely', () => {
  assert.equal(
    cleanYouTubeDisplayTitle('160 - Shankara Shankara Sada Shiva | Radio Sai Bhajans'),
    'Shankara Shankara Sada Shiva',
  );
  assert.equal(
    cleanYouTubeDisplayTitle('Kurai Ondrum Illai | Devotional Song | Mystik Vibes'),
    'Kurai Ondrum Illai',
  );

  const plain = fromFirestoreFields({
    title: { stringValue: '01 - Hari Bhajan Bina Sukh Shanti Nahin | Sri Sathya Sai Bhajans' },
    youtubeId: { stringValue: 'RpOGZGsbEK0' },
    lyrics: { stringValue: 'Hari Bhajan Bina Sukh Shanti Nahin\nHari Nam Bina Anand Nahin' },
    source: { stringValue: 'youtube' },
    deity: { nullValue: null },
    raga: { nullValue: null },
  });

  const parsed = parseFirestoreBhajan('6qAybTuzrHsgVcQxgZso', plain);
  assert.equal(parsed.id, '6qAybTuzrHsgVcQxgZso');
  assert.equal(parsed.title, 'Hari Bhajan Bina Sukh Shanti Nahin');
  assert.equal(parsed.deity, null);
  assert.equal(parsed.raga, null);
  assert.equal(parsed.gentsPitch, null);
  assert.equal(parsed.lyricsSets.length, 1);
  assert.equal(parsed.lyricsSets[0].lines.length, 2);
  assert.equal(parsed.recordings.length, 1);
  assert.equal(parsed.recordings[0].youtubeVideoId, 'RpOGZGsbEK0');
  assert.equal(parsed.metadataSource, 'youtube_sss_bhajans');
});

test('fetchCloudCatalogIndex loads parallel Firestore shards and falls back cleanly on error', async () => {
  const mockFetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/catalogMeta/latest')) {
      return new Response(
        JSON.stringify({
          fields: {
            version: { integerValue: '4' },
            totalBhajans: { integerValue: '1' },
            indexHash: { stringValue: 'abc' },
            shardIds: { arrayValue: { values: [{ stringValue: 'v4_shard_001' }] } },
            updatedAt: { stringValue: '2026-11-25T16:00:00Z' },
            stats: {
              mapValue: {
                fields: {
                  totalBhajans: { integerValue: '1' },
                  verifiedSaiRhythmsCount: { integerValue: '1' },
                  totalLocalRecordings: { integerValue: '0' },
                  bhajanDownloaderCount: { integerValue: '0' },
                  raviMp3Count: { integerValue: '0' },
                },
              },
            },
          },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/catalogIndexShards/v4_shard_001')) {
      return new Response(
        JSON.stringify({
          fields: {
            shardId: { stringValue: 'v4_shard_001' },
            version: { integerValue: '4' },
            count: { integerValue: '1' },
            entries: {
              arrayValue: {
                values: [
                  {
                    mapValue: {
                      fields: {
                        id: { stringValue: 'panduranga-vitthala' },
                        slug: { stringValue: 'panduranga-vitthala' },
                        title: { stringValue: 'Panduranga Vitthala' },
                        searchText: { stringValue: 'Panduranga Vitthala Krishna' },
                        phoneticTokens: {
                          arrayValue: {
                            values: [
                              { stringValue: 'panduranga' },
                              { stringValue: 'vitthala' },
                            ],
                          },
                        },
                        lyricsMissing: { booleanValue: false },
                        matchStatus: { stringValue: 'verified' },
                        missingFields: { arrayValue: { values: [] } },
                        recordingCount: { integerValue: '1' },
                        metadataSource: { stringValue: 'sairhythms_verified' },
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  const cloud = await fetchCloudCatalogIndex({ fetchImpl: mockFetch });
  assert.equal(cloud.source, 'cloud');
  assert.equal(cloud.payload.version, 4);
  assert.equal(cloud.payload.entries.length, 1);
  assert.equal(cloud.payload.entries[0].id, 'panduranga-vitthala');

  const offline = await fetchCloudCatalogIndex({
    fetchImpl: (async () => {
      throw new Error('offline');
    }) as typeof fetch,
  });
  assert.equal(offline.source, 'bundled');
  assert.ok(offline.payload.entries.length > 0);
});

test('fetchCloudBhajanDetail supports slugAliases fallback query on direct 404', async () => {
  const mockFetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/bhajans/old-alias')) {
      return new Response('{}', { status: 404 });
    }
    if (url.endsWith(':runQuery')) {
      return new Response(
        JSON.stringify([
          {
            document: {
              name: 'projects/saibhajanverse/databases/(default)/documents/bhajans/canonical-id',
              fields: {
                title: { stringValue: 'Sundara Vinayaka' },
                lyricsSets: { arrayValue: { values: [] } },
                glossary: { arrayValue: { values: [] } },
                recordings: { arrayValue: { values: [] } },
              },
            },
          },
        ]),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  const doc = await fetchCloudBhajanDetail('old-alias', { fetchImpl: mockFetch });
  assert.equal(doc?.id, 'canonical-id');
  assert.equal(doc?.title, 'Sundara Vinayaka');
});

test('filterBhajanIndexEntries supports phonetic Sanskrit search and resolvePlaybackAction handles YouTube chapters + local MP3', () => {
  const sampleEntries: BhajanIndexEntry[] = [
    {
      id: 'panduranga-vitthala',
      slug: 'panduranga-vitthala',
      title: 'Panduranga Vitthala',
      deity: 'Krishna',
      ragaName: 'Mohanam',
      searchText: 'Panduranga Vitthala Krishna Mohanam',
      phoneticTokens: canonicalizePhrase('Panduranga Vitthala').split(' '),
      lyricsMissing: false,
      matchStatus: 'verified',
      missingFields: [],
      recordingCount: 1,
      metadataSource: 'sairhythms_verified',
    },
    {
      id: 'yt_shiva',
      slug: 'yt-shiva',
      title: 'Shiva Shambho',
      deity: 'Shiva',
      searchText: 'Shiva Shambho',
      phoneticTokens: ['shiva', 'shambho'],
      lyricsMissing: true,
      matchStatus: 'unmatched',
      missingFields: ['lyrics'],
      recordingCount: 1,
      metadataSource: 'youtube_sss_bhajans',
    },
  ];

  const phoneticHits = filterBhajanIndexEntries(sampleEntries, { query: 'Vittala' });
  assert.deepEqual(
    phoneticHits.map((e) => e.id),
    ['panduranga-vitthala'],
  );

  const verifiedOnly = filterBhajanIndexEntries(sampleEntries, { onlyVerified: true });
  assert.deepEqual(
    verifiedOnly.map((e) => e.id),
    ['panduranga-vitthala'],
  );

  assert.equal(buildYouTubeWatchUrl('nwTjUoNC54M', 45), 'https://www.youtube.com/watch?v=nwTjUoNC54M&t=45s');

  const ytAction = resolvePlaybackAction(
    {
      id: 'yt_nwTjUoNC54M_t45',
      label: 'Mandir Live (0:45–4:30)',
      collection: 'youtube_volume_chapter',
      youtubeVideoId: 'nwTjUoNC54M',
      startSec: 45,
      endSec: 270,
      embeddable: true,
    },
    'http://localhost:3000',
  );
  assert.equal(ytAction.kind, 'youtube');
  if (ytAction.kind === 'youtube') {
    assert.equal(ytAction.url, 'https://www.youtube.com/watch?v=nwTjUoNC54M&t=45s');
    assert.equal(ytAction.chapterLabel, '0:45–4:30');
  }

  const audioAction = resolvePlaybackAction(
    {
      id: 'mp3_1',
      label: 'Archive MP3',
      collection: 'ravi_mp3',
      localPath: '/tmp/song.mp3',
    },
    'http://localhost:3000/',
  );
  assert.deepEqual(audioAction, {
    kind: 'audio',
    uri: 'http://localhost:3000/api/local-audio?id=mp3_1',
  });
});

test('resolveDefaultApiBase selects env override, Web LAN host, Expo Go bundle host, or simulator default', () => {
  assert.equal(
    resolveDefaultApiBase({
      envBaseUrl: 'http://192.168.1.50:4000/',
      webHostname: '192.168.86.29',
      bundleScriptUrl: 'http://192.168.86.29:8081/node_modules/expo/AppEntry.bundle',
      platformOs: 'ios',
    }),
    'http://192.168.1.50:4000',
  );
  assert.equal(
    resolveDefaultApiBase({ webHostname: '192.168.86.29', platformOs: 'web' }),
    'http://192.168.86.29:3000',
  );
  assert.equal(
    resolveDefaultApiBase({
      bundleScriptUrl: 'http://192.168.86.29:8081/node_modules/expo/AppEntry.bundle?platform=ios',
      platformOs: 'ios',
    }),
    'http://192.168.86.29:3000',
  );
  assert.equal(resolveDefaultApiBase({ platformOs: 'android' }), 'http://10.0.2.2:3000');
  assert.equal(resolveDefaultApiBase({ platformOs: 'ios' }), 'http://localhost:3000');
});

test('parseFirestoreBhajan preserves defaultRecordingId and pickStreamRecording prioritizes default version', () => {
  const plain = fromFirestoreFields({
    title: { stringValue: 'Janani Krupa Karo Ambe' },
    defaultRecordingId: { stringValue: 'yt_mQr8isPmdAc' },
    recordings: {
      arrayValue: {
        values: [
          {
            mapValue: {
              fields: {
                id: { stringValue: 'yt_mQr8isPmdAc' },
                label: { stringValue: 'Prasanthi Mandir Live' },
                collection: { stringValue: 'youtube_prasanthi_mandir_live' },
                youtubeVideoId: { stringValue: 'mQr8isPmdAc' },
                isDefault: { booleanValue: true },
              },
            },
          },
          {
            mapValue: {
              fields: {
                id: { stringValue: 'sair_ref_1' },
                label: { stringValue: 'Sai Rhythms Reference Audio' },
                collection: { stringValue: 'sairhythms_ref' },
                externalUrl: { stringValue: 'https://example.com/ref.mp3' },
              },
            },
          },
        ],
      },
    },
    lyricsSets: { arrayValue: { values: [] } },
    glossary: { arrayValue: { values: [] } },
  });

  const parsed = parseFirestoreBhajan('janani-krupa-karo-ambe', plain);
  assert.equal(parsed.defaultRecordingId, 'yt_mQr8isPmdAc');
  assert.equal(parsed.recordings[0]?.isDefault, true);

  const picked = pickStreamRecording(parsed, 'audio', null);
  assert.equal(picked.defaultRecordingId, 'yt_mQr8isPmdAc');
  assert.equal(picked.recording?.id, 'yt_mQr8isPmdAc');
  assert.equal(picked.hasAudioOption, true);
  assert.equal(picked.hasVideoOption, true);
});

test('BhajamiSplashOverlay exports multilingual BhaJamI wordmark sequence covering Sanskrit, English, Indian, and World scripts', () => {
  const overlaySrc = fs.readFileSync(
    path.resolve(process.cwd(), 'apps/mobile/src/components/BhajamiSplashOverlay.tsx'),
    'utf-8',
  );
  assert.match(overlaySrc, /SPLASH_WORDMARK_SEQUENCE/);
  assert.ok(SPLASH_WORDMARK_SEQUENCE.length >= 90);
  assert.ok(SPLASH_WORDMARK_SEQUENCE.some((e) => e.text === 'भजामि'));
  assert.ok(SPLASH_WORDMARK_SEQUENCE.some((e) => e.kind === 'english' && e.text === 'BhaJamI'));
  assert.ok(SPLASH_WORDMARK_SEQUENCE.some((e) => e.scriptLabel === 'Telugu' && e.text === 'భజామి'));
  assert.ok(SPLASH_WORDMARK_SEQUENCE.some((e) => e.scriptLabel === 'Japanese' && e.text === 'バジャミ'));
  assert.equal(SPLASH_STATUS_STEPS.length, 4);
});
