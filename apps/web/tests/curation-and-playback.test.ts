import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const PORT = 3099;
let baseUrl = `http://127.0.0.1:${PORT}`;
let tempDir = '';
let server: http.Server | null = null;
const prevDisableCloud = process.env.DISABLE_CLOUD_FIRESTORE_SYNC;
const prevDataDir = process.env.BHAJAMI_DATA_DIR;

type RouteModule = {
  GET?: (req: NextRequest, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
  POST?: (req: NextRequest, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
  PATCH?: (req: NextRequest, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
};

let healthRoute: RouteModule;
let curationRoute: RouteModule;
let correctionsRoute: RouteModule;
let correctionByIdRoute: RouteModule;
let catalogStore: typeof import('../src/lib/catalog-store');

async function toNextRequest(req: http.IncomingMessage): Promise<NextRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf-8') : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }
  return new NextRequest(`${baseUrl}${req.url || '/'}`, {
    method: req.method || 'GET',
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
}

describe('Phase 5 curation API, metadata edits, and YouTube TOS playback verification', () => {
  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhajami-phase5-'));
    process.env.DISABLE_CLOUD_FIRESTORE_SYNC = '1';
    process.env.BHAJAMI_DATA_DIR = tempDir;

    // Seed two synthetic unmatched / doubt stubs plus runs into isolated temp BHAJAMI_DATA_DIR
    fs.writeFileSync(
      path.join(tempDir, 'approved-new-bhajans.json'),
      JSON.stringify(
        [
          {
            id: 'yt_stubMissing1',
            slug: 'yt-stubmissing1',
            title: 'Rare Sai Offering Stub',
            deity: 'Sai',
            language: '',
            raga: { name: '' },
            beat: '',
            tempo: '',
            meaning: null,
            lyricsSets: [],
            glossary: [],
            recordings: [
              {
                id: 'yt_stubMissing1',
                label: 'SSS Bhajans: Rare Sai Offering Stub',
                collection: 'youtube_sss_bhajans',
                externalUrl: 'https://www.youtube.com/watch?v=stubMissing1',
                youtubeVideoId: 'stubMissing1',
                embeddable: true,
                durationSec: 210,
              },
            ],
            metadataSource: 'youtube_sss_bhajans',
            lyricsMissing: true,
            matchStatus: 'unmatched',
            missingFields: ['lyrics', 'meaning', 'gentsPitch', 'ladiesPitch', 'raga', 'beat', 'tempo', 'notation', 'alternateScripts'],
          },
          {
            id: 'yt_doubtMerge2',
            slug: 'yt-doubtmerge2',
            title: 'Sundara Vinaayaka Live',
            deity: 'Ganesha',
            language: '',
            raga: { name: '' },
            beat: '',
            tempo: '',
            meaning: null,
            lyricsSets: [],
            glossary: [],
            recordings: [
              {
                id: 'yt_doubtMerge2',
                label: 'SSS Bhajans: Sundara Vinaayaka Live',
                collection: 'youtube_sss_bhajans',
                externalUrl: 'https://www.youtube.com/watch?v=doubtMerge2',
                youtubeVideoId: 'doubtMerge2',
                embeddable: true,
                durationSec: 440,
              },
            ],
            metadataSource: 'youtube_sss_bhajans',
            lyricsMissing: true,
            matchStatus: 'needs_verification',
            matchCandidates: [
              {
                targetBhajanId: 'sundara-sundara-vinayaka',
                targetTitle: 'Sundara Sundara Vinayaka',
                score: 0.84,
                reason: 'doubt_band',
              },
              {
                targetBhajanId: 'aao-aao-nandalala',
                targetTitle: 'Aao Aao Nandalala',
                score: 0.73,
                reason: 'doubt_band',
              },
            ],
            missingFields: ['lyrics', 'meaning', 'gentsPitch', 'ladiesPitch', 'raga', 'beat', 'tempo', 'notation', 'alternateScripts'],
          },
        ],
        null,
        2,
      ),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'curation-runs.json'),
      JSON.stringify([
        {
          runId: 'yt_run_phase5_test',
          source: 'youtube_sss_bhajans',
          startedAt: '2026-11-24T17:00:00Z',
          finishedAt: '2026-11-24T17:00:05Z',
          status: 'success',
          itemsScanned: 12,
          matchedAuto: 8,
          queuedDoubt: 2,
          createdNew: 2,
          skippedDuplicate: 0,
          parseErrors: 0,
          youtubeQuotaUnitsUsed: 3,
          firestoreWrites: 14,
        },
      ]),
      'utf-8',
    );

    healthRoute = await import('../src/app/api/health/route');
    curationRoute = await import('../src/app/api/admin/curation/route');
    correctionsRoute = await import('../src/app/api/corrections/route');
    correctionByIdRoute = await import('../src/app/api/corrections/[id]/route');
    catalogStore = await import('../src/lib/catalog-store');

    server = http.createServer(async (req, res) => {
      try {
        const nextReq = await toNextRequest(req);
        const url = new URL(req.url || '/', baseUrl);
        let response: Response;
        if (url.pathname === '/api/health' && healthRoute.GET) {
          response = await healthRoute.GET();
        } else if (url.pathname === '/api/admin/curation') {
          response =
            req.method === 'POST' && curationRoute.POST
              ? await curationRoute.POST(nextReq)
              : await curationRoute.GET!(nextReq);
        } else if (url.pathname === '/api/corrections') {
          response =
            req.method === 'POST' && correctionsRoute.POST
              ? await correctionsRoute.POST(nextReq)
              : await correctionsRoute.GET!(nextReq);
        } else if (url.pathname.startsWith('/api/corrections/')) {
          const id = decodeURIComponent(url.pathname.slice('/api/corrections/'.length));
          response =
            req.method === 'PATCH' && correctionByIdRoute.PATCH
              ? await correctionByIdRoute.PATCH(nextReq, { params: Promise.resolve({ id }) })
              : await correctionByIdRoute.GET!(nextReq, { params: Promise.resolve({ id }) });
        } else {
          response = new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        }
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(await response.text());
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Server error' }));
      }
    });

    await new Promise<void>((resolve) => {
      server!.listen(PORT, '127.0.0.1', () => resolve());
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (prevDisableCloud === undefined) delete process.env.DISABLE_CLOUD_FIRESTORE_SYNC;
    else process.env.DISABLE_CLOUD_FIRESTORE_SYNC = prevDisableCloud;
    if (prevDataDir === undefined) delete process.env.BHAJAMI_DATA_DIR;
    else process.env.BHAJAMI_DATA_DIR = prevDataDir;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serves /api/health and all 4 GET /api/admin/curation queues over isolated port 3099', async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { ok: boolean; bhajanCount: number };
    assert.equal(healthJson.ok, true);
    assert.ok(healthJson.bhajanCount >= 2);

    const missingRes = await fetch(`${baseUrl}/api/admin/curation?view=missing_lyrics`);
    assert.equal(missingRes.status, 200);
    const missingJson = (await missingRes.json()) as { items: Array<{ id: string }> };
    assert.ok(missingJson.items.some((b) => b.id === 'yt_stubMissing1'));

    const doubtRes = await fetch(`${baseUrl}/api/admin/curation?view=needs_verification`);
    assert.equal(doubtRes.status, 200);
    const doubtJson = (await doubtRes.json()) as { items: Array<{ id: string }> };
    assert.ok(doubtJson.items.some((b) => b.id === 'yt_doubtMerge2'));

    const longRes = await fetch(`${baseUrl}/api/admin/curation?view=ambiguous_long`);
    assert.equal(longRes.status, 200);
    const longJson = (await longRes.json()) as { items: Array<{ id: string }> };
    assert.ok(longJson.items.some((b) => b.id === 'yt_doubtMerge2'));

    const runsRes = await fetch(`${baseUrl}/api/admin/curation?view=runs`);
    assert.equal(runsRes.status, 200);
    const runsJson = (await runsRes.json()) as { runs: Array<{ runId: string }> };
    assert.equal(runsJson.runs[0].runId, 'yt_run_phase5_test');
  });

  it('supports publish_curated with bhajamiOverride and revision history', async () => {
    const res = await fetch(`${baseUrl}/api/admin/curation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'publish_curated',
        bhajanId: 'yt_stubMissing1',
        lyricsText: 'Sai Ram Sai Ram\nPrashanthi Nilayam Sai Ram',
        script: 'Sanskrit / Hindi (Roman)',
        metadata: {
          ragaName: 'Mohanam',
          arohanam: 'S R2 G3 P D2 S',
          gentsPitchRaw: '2 Pancham / D',
        },
      }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; revisionId: string; bhajan: { bhajamiOverride: boolean; lyricsMissing: boolean } };
    assert.equal(json.ok, true);
    assert.ok(json.revisionId.startsWith('rev_'));
    assert.equal(json.bhajan.bhajamiOverride, true);
    assert.equal(json.bhajan.lyricsMissing, false);

    const detail = await catalogStore.getBhajanDetail('yt_stubMissing1');
    assert.ok(detail);
    assert.equal(detail.raga?.arohanam, 'S R2 G3 P D2 S');
    assert.equal(detail.gentsPitch?.semitoneFromC, 2);
  });

  it('supports keep_distinct, approve_merge, and exclude_non_bhajan reason validation', async () => {
    // 0. keep_distinct rejects overly long >500-char notes
    const tooLongNoteRes = await fetch(`${baseUrl}/api/admin/curation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'keep_distinct',
        sourceBhajanId: 'yt_doubtMerge2',
        candidateBhajanId: 'aao-aao-nandalala',
        note: 'x'.repeat(501),
      }),
    });
    assert.equal(tooLongNoteRes.status, 400);

    // 1. keep_distinct removes candidate, stores doNotMergePairs entry with note, and logs clearance decision
    const distinctNote =
      'Same opening deity invocation but completely different middle stanzas and Mohanam tune';
    const kdRes = await fetch(`${baseUrl}/api/admin/curation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'keep_distinct',
        sourceBhajanId: 'yt_doubtMerge2',
        candidateBhajanId: 'aao-aao-nandalala',
        note: distinctNote,
      }),
    });
    assert.equal(kdRes.status, 200);
    const kdJson = (await kdRes.json()) as { doNotMergeKey: string; bhajan: { matchCandidates?: Array<{ targetBhajanId: string }> } };
    assert.equal(kdJson.doNotMergeKey, 'aao-aao-nandalala__yt_doubtMerge2');
    assert.equal(
      kdJson.bhajan.matchCandidates?.some((c) => c.targetBhajanId === 'aao-aao-nandalala'),
      false,
    );

    // 2. approve_merge requires selecting a valid defaultRecordingId from merged recordings
    const missingDefaultRes = await fetch(`${baseUrl}/api/admin/curation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'approve_merge',
        sourceBhajanId: 'yt_doubtMerge2',
        targetBhajanId: 'sundara-sundara-vinayaka',
        saveAliasTitle: 'Sundara Vinaayaka Live',
      }),
    });
    assert.equal(missingDefaultRes.status, 400);

    const invalidDefaultRes = await fetch(`${baseUrl}/api/admin/curation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'approve_merge',
        sourceBhajanId: 'yt_doubtMerge2',
        targetBhajanId: 'sundara-sundara-vinayaka',
        defaultRecordingId: 'nonexistent-rec-id',
      }),
    });
    assert.equal(invalidDefaultRes.status, 400);

    const mergeRes = await fetch(`${baseUrl}/api/admin/curation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'approve_merge',
        sourceBhajanId: 'yt_doubtMerge2',
        targetBhajanId: 'sundara-sundara-vinayaka',
        defaultRecordingId: 'yt_doubtMerge2',
        saveAliasTitle: 'Sundara Vinaayaka Live',
      }),
    });
    assert.equal(mergeRes.status, 200);
    const mergeJson = (await mergeRes.json()) as {
      aliasId?: string;
      bhajan: {
        defaultRecordingId?: string | null;
        recordings: Array<{ id: string; isDefault?: boolean }>;
        slugAliases?: string[];
      };
    };
    assert.ok(mergeJson.aliasId);
    assert.equal(mergeJson.bhajan.defaultRecordingId, 'yt_doubtMerge2');
    assert.equal(mergeJson.bhajan.recordings[0].id, 'yt_doubtMerge2');
    assert.equal(mergeJson.bhajan.recordings[0].isDefault, true);
    assert.ok(mergeJson.bhajan.recordings.some((r) => r.id === 'yt_doubtMerge2'));
    assert.ok(mergeJson.bhajan.recordings.slice(1).every((r) => !r.isDefault));
    assert.ok(mergeJson.bhajan.slugAliases?.includes('yt_doubtMerge2'));
    assert.equal(await catalogStore.getBhajanDetail('yt_doubtMerge2'), null);

    // 2b. duplicate_log view and JSONL mirror record both kept_distinct note and merged default version
    const logRes = await fetch(`${baseUrl}/api/admin/curation?view=duplicate_log`);
    assert.equal(logRes.status, 200);
    const logJson = (await logRes.json()) as {
      duplicateLog: Array<{
        decision: string;
        sourceBhajanId: string;
        targetBhajanId: string;
        candidateScore?: number | null;
        candidateReason?: string | null;
        defaultRecordingId?: string | null;
        adminNote?: string | null;
      }>;
    };
    const distinctLog = logJson.duplicateLog.find(
      (e) =>
        e.decision === 'kept_distinct' &&
        e.sourceBhajanId === 'yt_doubtMerge2' &&
        e.targetBhajanId === 'aao-aao-nandalala',
    );
    assert.ok(distinctLog);
    assert.equal(
      distinctLog.adminNote,
      'Same opening deity invocation but completely different middle stanzas and Mohanam tune',
    );
    assert.equal(distinctLog.candidateScore, 0.73);
    assert.equal(distinctLog.candidateReason, 'doubt_band');

    const mergeLog = logJson.duplicateLog.find(
      (e) =>
        e.decision === 'merged' &&
        e.sourceBhajanId === 'yt_doubtMerge2' &&
        e.targetBhajanId === 'sundara-sundara-vinayaka',
    );
    assert.ok(mergeLog);
    assert.equal(mergeLog.defaultRecordingId, 'yt_doubtMerge2');

    const jsonlPath = path.join(tempDir, 'duplicate-clearance-log.jsonl');
    assert.equal(fs.existsSync(jsonlPath), true);
    const jsonlLines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    assert.equal(jsonlLines.length, 2);

    // 3. exclude_non_bhajan rejects empty reason and succeeds with non-empty reason
    const badExcl = await fetch(`${baseUrl}/api/admin/curation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'exclude_non_bhajan',
        bhajanId: 'yt_stubMissing1',
        reason: '   ',
      }),
    });
    assert.equal(badExcl.status, 400);

    const goodExcl = await fetch(`${baseUrl}/api/admin/curation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'exclude_non_bhajan',
        bhajanId: 'yt_stubMissing1',
        videoId: 'stubMissing1',
        reason: 'Discourse clip without bhajan singing',
      }),
    });
    assert.equal(goodExcl.status, 200);
    assert.equal(await catalogStore.getBhajanDetail('yt_stubMissing1'), null);
  });

  it('persists admin editedMetadata notation fields on PATCH /api/corrections/[id] approve', async () => {
    const postRes = await fetch(`${baseUrl}/api/corrections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bhajanId: 'aao-aao-nandalala',
        bhajanTitle: 'Aao Aao Nandalala',
        submissionType: 'metadata_addition',
        script: 'Roman',
        proposedLyrics: [],
        proposedMetadata: {
          ragaName: 'Misra Khamaj',
          arohanam: 'S G3 M1 P N2 S',
        },
        reasonOrSource: 'Choir sheet notation verified',
        submitterName: 'Devotee Tester',
        submitterEmail: 'devotee@example.com',
      }),
    });
    assert.equal(postRes.status, 201);
    const created = (await postRes.json()) as { correction: { id: string } };

    const approveRes = await fetch(`${baseUrl}/api/corrections/${created.correction.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'approve',
        editedMetadata: {
          ragaName: 'Khamaj',
          arohanam: 'S G3 M1 P D2 N2 S',
          firstLineSargam: 'N S G M P',
          gentsPitchRaw: '5.5 Pancham / G# / Ab',
        },
      }),
    });
    assert.equal(approveRes.status, 200);

    const updatedBhajan = await catalogStore.getBhajanDetail('aao-aao-nandalala');
    assert.ok(updatedBhajan);
    assert.equal(updatedBhajan.raga?.name, 'Khamaj');
    assert.equal(updatedBhajan.raga?.arohanam, 'S G3 M1 P D2 N2 S');
    assert.equal(updatedBhajan.firstLineNotes?.sargam, 'N S G M P');
    assert.equal(updatedBhajan.gentsPitch?.semitoneFromC, 8);
  });

  it('enforces visible YouTube player >= 320x180px CSS and Watch on YouTube fallback', () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), 'apps/web/src/app/globals.css'), 'utf-8');
    assert.match(css, /\.yt-player-frame\s*\{[^}]*min-width:\s*320px/s);
    assert.match(css, /\.yt-player-frame\s*\{[^}]*min-height:\s*180px/s);
    assert.match(css, /\.yt-player-frame-mini\s*\{[^}]*min-width:\s*200px/s);
    assert.match(css, /\.yt-player-frame-mini\s*\{[^}]*min-height:\s*200px/s);
    assert.match(css, /\.mini-stream-host\s*\{[^}]*container-name:\s*mini-dock/s);
    assert.match(css, /\.mini-stream-meta-chips/);
    assert.match(css, /@container mini-dock \(min-width:\s*540px\)/);
    assert.match(css, /@container mini-dock \(min-width:\s*660px\)/);
    assert.match(css, /@container mini-lyrics \(min-width:\s*390px\)/);
    assert.match(css, /column-count:\s*2/);
    assert.match(css, /scrollbar-color:/);

    const playerSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'apps/web/src/components/YouTubeSegmentPlayer.tsx'),
      'utf-8',
    );
    assert.match(playerSrc, /Watch on YouTube/);
    assert.match(playerSrc, /embeddable === false/);

    const streamSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'apps/web/src/components/StreamRadioView.tsx'),
      'utf-8',
    );
    assert.match(streamSrc, /useState\(true\)/);
    assert.match(streamSrc, /nonEmptyLineCount > 7/);
    assert.match(streamSrc, /Hide lyrics/);
    assert.match(streamSrc, /Show lyrics/);
    assert.match(streamSrc, /mini-stream-meta-chips/);

    const mobileAppSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'apps/mobile/App.tsx'),
      'utf-8',
    );
    assert.match(mobileAppSrc, /\[showMiniLyrics, setShowMiniLyrics\] = useState\(false\)/);
    assert.match(mobileAppSrc, /Show Lyrics/);
    assert.match(mobileAppSrc, /Hide Lyrics/);
  });
});
