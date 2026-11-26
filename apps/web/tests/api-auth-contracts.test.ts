import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { NextRequest } from 'next/server';
import type { Bhajan } from '@bhajami/shared';
import {
  isAdminIdentity,
  verifyAdminBearerToken,
  verifyUserBearerToken,
} from '../src/lib/firebase-admin';
import { formatFirebaseAuthError } from '../src/lib/firebase-client';
import {
  ALLOWED_META_KEYS,
  buildCanonicalBhajanFields,
  buildRuleCompliantCorrectionFields,
  hasCloudConfig,
  sanitizeProposedMetadata,
} from '../src/lib/firestore-rest';
import { inferScriptKind } from '../src/lib/catalog-store';
import { GET as getBhajansRoute } from '../src/app/api/bhajans/route';
import { GET as getBhajanByIdRoute } from '../src/app/api/bhajans/[id]/route';
import { GET as getHealthRoute } from '../src/app/api/health/route';
import {
  GET as getCorrectionsRoute,
  POST as postCorrectionsRoute,
} from '../src/app/api/corrections/route';
import {
  GET as getCorrectionByIdRoute,
  PATCH as patchCorrectionByIdRoute,
} from '../src/app/api/corrections/[id]/route';
import { GET as getLocalAudioRoute } from '../src/app/api/local-audio/route';
import { POST as postUploadedAudioRoute } from '../src/app/api/uploaded-audio/route';

const ENV_KEYS = [
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'DISABLE_CLOUD_FIRESTORE_SYNC',
  'LOCAL_ARCHIVE_ENABLED',
  'LOCAL_UPLOADS_ENABLED',
  'BHAJAMI_DATA_DIR',
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const key of ENV_KEYS) {
  savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const val = savedEnv[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

function setCloudTestEnv(): void {
  delete process.env.DISABLE_CLOUD_FIRESTORE_SYNC;
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'test-public-api-key';
}

function setLocalTestEnv(dataDir?: string): void {
  process.env.DISABLE_CLOUD_FIRESTORE_SYNC = '1';
  if (dataDir) {
    process.env.BHAJAMI_DATA_DIR = dataDir;
  }
}

afterEach(() => {
  restoreEnv();
});

describe('Phase 1 cloud config & server auth verification', () => {
  it('toggles hasCloudConfig based on credentials and DISABLE_CLOUD_FIRESTORE_SYNC', () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    delete process.env.DISABLE_CLOUD_FIRESTORE_SYNC;
    assert.equal(hasCloudConfig(), false);

    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'test-key';
    assert.equal(hasCloudConfig(), true);

    process.env.DISABLE_CLOUD_FIRESTORE_SYNC = '1';
    assert.equal(hasCloudConfig(), false);
  });

  it('rejects missing or invalid bearer tokens in verifyUserBearerToken & verifyAdminBearerToken', async () => {
    const missingUser = await verifyUserBearerToken(null);
    assert.equal(missingUser.ok, false);
    if (!missingUser.ok) assert.equal(missingUser.status, 401);

    const badAdmin = await verifyAdminBearerToken('Bearer invalid.jwt.token');
    assert.equal(badAdmin.ok, false);
    if (!badAdmin.ok) assert.equal(badAdmin.status, 401);
  });

  it('grants admin only to verified primary admin email (case-insensitive) or custom admin claim', () => {
    assert.equal(
      isAdminIdentity({ email: 'pschax@gmail.com', emailVerified: true }),
      true,
    );
    assert.equal(
      isAdminIdentity({ email: '  PSCHAX@GMAIL.COM ', emailVerified: true }),
      true,
    );
    assert.equal(
      isAdminIdentity({ email: 'pschax@gmail.com', emailVerified: false }),
      false,
    );
    assert.equal(
      isAdminIdentity({ email: 'other@gmail.com', emailVerified: true }),
      false,
    );
    assert.equal(
      isAdminIdentity({ email: 'other@gmail.com', emailVerified: true, adminClaim: true }),
      true,
    );
  });

  it('formats Google Sign-In errors with unauthorized-domain console links and popup redirect fallbacks', () => {
    const loopbackErr = formatFirebaseAuthError(
      { code: 'auth/unauthorized-domain', message: 'Firebase: Error (auth/unauthorized-domain).' },
      { hostname: '127.0.0.1', isCloud: true },
    );
    assert.equal(loopbackErr.code, 'auth/unauthorized-domain');
    assert.equal(loopbackErr.suggestLocalhost, true);
    assert.equal(loopbackErr.suggestRedirect, false);
    assert.match(loopbackErr.message, /localhost:3000/);
    assert.equal(
      loopbackErr.consoleSettingsUrl,
      'https://console.firebase.google.com/project/saibhajanverse/authentication/settings',
    );

    const lanHostErr = formatFirebaseAuthError(
      new Error('Firebase: Error (auth/unauthorized-domain).'),
      { hostname: 'srinivasas-macbook-pro.local', isCloud: true },
    );
    assert.equal(lanHostErr.suggestLocalhost, false);
    assert.equal(
      lanHostErr.consoleSettingsUrl,
      'https://console.firebase.google.com/project/saibhajanverse/authentication/settings',
    );
    assert.match(lanHostErr.message, /srinivasas-macbook-pro\.local/);

    const lanIpErr = formatFirebaseAuthError(
      { code: 'auth/unauthorized-domain', message: 'Firebase: Error (auth/unauthorized-domain).' },
      { hostname: '192.168.86.21', isCloud: true },
    );
    assert.equal(lanIpErr.suggestLocalhost, false);

    const popupErr = formatFirebaseAuthError(
      { code: 'auth/popup-blocked', message: 'Popup blocked' },
      { isCloud: true },
    );
    assert.equal(popupErr.suggestRedirect, true);
    assert.match(popupErr.message, /auth\/popup-blocked/);

    const closedErr = formatFirebaseAuthError(
      { code: 'auth/popup-closed-by-user', message: 'Closed' },
      { isCloud: true },
    );
    assert.equal(closedErr.suggestRedirect, true);

    const disabledErr = formatFirebaseAuthError(
      { code: 'auth/operation-not-allowed', message: 'Not allowed' },
      { isCloud: true },
    );
    assert.equal(disabledErr.code, 'auth/operation-not-allowed');
    assert.match(disabledErr.message, /Sign-in method/);
  });

  it('returns 401 for unauthenticated protected routes when hasCloudConfig() is true', async () => {
    setCloudTestEnv();

    const corrGet = await getCorrectionsRoute(
      new NextRequest('http://localhost:3000/api/corrections'),
    );
    assert.equal(corrGet.status, 401);

    const corrPost = await postCorrectionsRoute(
      new NextRequest('http://localhost:3000/api/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bhajanId: 'aao-aao-nandalala' }),
      }),
    );
    assert.equal(corrPost.status, 401);

    const corrByIdGet = await getCorrectionByIdRoute(
      new NextRequest('http://localhost:3000/api/corrections/corr_sample_001'),
      { params: Promise.resolve({ id: 'corr_sample_001' }) },
    );
    assert.equal(corrByIdGet.status, 401);

    const corrPatch = await patchCorrectionByIdRoute(
      new NextRequest('http://localhost:3000/api/corrections/corr_sample_001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      }),
      { params: Promise.resolve({ id: 'corr_sample_001' }) },
    );
    assert.equal(corrPatch.status, 401);

    const uploadPost = await postUploadedAudioRoute(
      new Request('http://localhost:3000/api/uploaded-audio', { method: 'POST' }),
    );
    assert.equal(uploadPost.status, 401);
  });
});

describe('Phase 1 Firestore schema unification & sanitizers', () => {
  it('supports all 20 ALLOWED_META_KEYS including notation fields and numeric tempo', () => {
    assert.equal(ALLOWED_META_KEYS.size, 20);
    for (const key of [
      'arohanam',
      'avarohanam',
      'firstLineSargam',
      'firstLineWestern',
      'notesRange',
      'sheetMusicUrl',
    ]) {
      assert.equal(ALLOWED_META_KEYS.has(key), true);
    }

    const cleaned = sanitizeProposedMetadata({
      ragaName: ' Hamsadhwani ',
      arohanam: 'S R2 G3 P N3 S',
      avarohanam: 'S N3 P G3 R2 S',
      firstLineSargam: 'S R G P',
      firstLineWestern: 'C D E G',
      notesRange: 'C4 - E5',
      sheetMusicUrl: 'https://sairhythms.sathyasai.org/sheet/1',
      tempo: 112,
      unknownInjectedKey: 'should be stripped',
    } as Record<string, unknown>);

    assert.ok(cleaned);
    assert.equal(cleaned.ragaName, 'Hamsadhwani');
    assert.equal(cleaned.arohanam, 'S R2 G3 P N3 S');
    assert.equal(cleaned.tempo, 112);
    assert.equal('unknownInjectedKey' in cleaned, false);
  });

  it('preserves existing raga & notation subfields and avoids legacy ragaName/isNewBhajan keys', () => {
    const fields = buildCanonicalBhajanFields(
      {
        bhajanId: 'test-bhajan',
        ragaName: 'Kafi',
        gentsPitchRaw: '2 Pancham / D',
        isNewBhajan: true,
        updatedAt: '2026-11-24T12:00:00Z',
      },
      {
        id: 'test-bhajan',
        slug: 'test-bhajan',
        title: 'Test Bhajan',
        raga: {
          name: 'Old Name',
          arohanam: 'S R G M P D N S',
          avarohanam: 'S N D P M G R S',
        },
        firstLineNotes: {
          sargam: 'S R G',
          westernInC: 'C D Eb',
        },
        lyricsSets: [],
        glossary: [],
        recordings: [],
        metadataSource: 'sairhythms_verified',
      },
    );

    assert.equal('ragaName' in fields, false);
    assert.equal('isNewBhajan' in fields, false);
    assert.equal(fields.bhajamiNewBhajan, true);
    assert.deepEqual(fields.raga, {
      name: 'Kafi',
      arohanam: 'S R G M P D N S',
      avarohanam: 'S N D P M G R S',
    });
    assert.deepEqual(fields.firstLineNotes, {
      sargam: 'S R G',
      westernInC: 'C D Eb',
    });
    assert.ok(Array.isArray(fields.missingFields));
  });

  it('omits disallowed id and emailNotification fields from rule-compliant correction docs', () => {
    const fields = buildRuleCompliantCorrectionFields(
      {
        id: 'corr_test_1',
        bhajanId: 'aao-aao-nandalala',
        bhajanTitle: 'Aao Aao Nandalala',
        submissionType: 'metadata_addition',
        script: 'Roman',
        originalLyrics: [],
        proposedLyrics: [],
        reasonOrSource: 'Verified notebook',
        submitterName: 'Devotee',
        submitterEmail: 'devotee@example.org',
        submitterUid: 'uid_123',
        status: 'pending',
        createdAt: '2026-11-24T12:00:00Z',
        emailNotification: {
          to: 'admin@example.org',
          transport: 'test',
          sentAt: '2026-11-24T12:00:00Z',
          subject: 'Subject',
        },
      },
      true,
    );

    assert.equal('id' in fields, false);
    assert.equal('emailNotification' in fields, false);
    assert.equal(fields.submitterUid, 'uid_123');
  });
});

describe('Phase 1 public catalog APIs, script inference & reject validation', () => {
  it('serves slim CatalogIndexPayload with ETag and 304 Not Modified support', async () => {
    setLocalTestEnv();
    const res1 = await getBhajansRoute(new NextRequest('http://localhost:3000/api/bhajans'));
    assert.equal(res1.status, 200);
    const etag = res1.headers.get('etag');
    assert.ok(etag);
    const body = (await res1.json()) as {
      version: number;
      entries: Array<{ id: string; searchText: string }>;
    };
    assert.ok(body.entries.length > 0);
    assert.equal(typeof body.entries[0].searchText, 'string');
    assert.equal('lyricsSets' in body.entries[0], false);

    const res304 = await getBhajansRoute(
      new NextRequest('http://localhost:3000/api/bhajans', {
        headers: { 'if-none-match': etag },
      }),
    );
    assert.equal(res304.status, 304);
  });

  it('serves single bhajan details lazily via /api/bhajans/[id] and 404 when unknown', async () => {
    setLocalTestEnv();
    const indexRes = await getBhajansRoute(new NextRequest('http://localhost:3000/api/bhajans'));
    const indexJson = (await indexRes.json()) as { entries: Array<{ id: string }> };
    const firstId = indexJson.entries[0].id;

    const okRes = await getBhajanByIdRoute(
      new NextRequest(`http://localhost:3000/api/bhajans/${encodeURIComponent(firstId)}`),
      { params: Promise.resolve({ id: firstId }) },
    );
    assert.equal(okRes.status, 200);
    const detail = (await okRes.json()) as { bhajan: Bhajan };
    assert.equal(detail.bhajan.id, firstId);

    const missRes = await getBhajanByIdRoute(
      new NextRequest('http://localhost:3000/api/bhajans/nonexistent-bhajan-xyz'),
      { params: Promise.resolve({ id: 'nonexistent-bhajan-xyz' }) },
    );
    assert.equal(missRes.status, 404);
  });

  it('returns readiness metadata without secrets from /api/health', async () => {
    setLocalTestEnv();
    const res = await getHealthRoute();
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      ok: boolean;
      cloudConfigured: boolean;
      catalogVersion: number;
      bhajanCount: number;
    };
    assert.equal(json.ok, true);
    assert.ok(json.bhajanCount > 0);
  });

  it('blocks /api/local-audio unless LOCAL_ARCHIVE_ENABLED=true', async () => {
    delete process.env.LOCAL_ARCHIVE_ENABLED;
    const res = await getLocalAudioRoute(
      new NextRequest('http://localhost:3000/api/local-audio?id=anything'),
    );
    assert.equal(res.status, 404);
  });

  it('detects 14 Unicode script kinds accurately before label fallback', () => {
    assert.equal(inferScriptKind(['आओ आओ नन्दलाला'], 'Roman'), 'devanagari');
    assert.equal(inferScriptKind(['సాయి భజన'], 'Roman'), 'telugu');
    assert.equal(inferScriptKind(['சாய் பஜன்'], 'Roman'), 'tamil');
    assert.equal(inferScriptKind(['ಸಾಯಿ ಭಜನ್'], 'Roman'), 'kannada');
    assert.equal(inferScriptKind(['സായി ഭജൻ'], 'Roman'), 'malayalam');
    assert.equal(inferScriptKind(['ساي'], 'Roman'), 'arabic');
    assert.equal(inferScriptKind(['Саи Бхаджан'], 'Roman'), 'cyrillic');
    assert.equal(inferScriptKind(['サイ・バジャン'], 'Roman'), 'cjk');
    assert.equal(inferScriptKind(['Om Śrī Sāī Nārāyaṇa'], 'Roman IAST'), 'roman');
  });

  it('requires a non-empty reason on reject and returns 400 when missing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhajami-phase1-'));
    try {
      setLocalTestEnv(tmpDir);
      const res = await patchCorrectionByIdRoute(
        new NextRequest('http://localhost:3000/api/corrections/corr_sample_001', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reject', reviewNote: '   ' }),
        }),
        { params: Promise.resolve({ id: 'corr_sample_001' }) },
      );
      assert.equal(res.status, 400);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
