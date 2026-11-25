import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminBearerToken } from '@/lib/firebase-admin';
import { hasCloudConfig } from '@/lib/firestore-rest';
import {
  executeCurationAction,
  listCurationView,
  safeLogCurationError,
  type CurationActionPayload,
  type CurationViewKind,
} from '@/lib/curation-store';
import { ADMIN_EMAIL } from '@/lib/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_VIEWS = new Set<CurationViewKind>([
  'missing_lyrics',
  'needs_verification',
  'ambiguous_long',
  'runs',
]);

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (hasCloudConfig()) {
    const auth = await verifyAdminBearerToken(authHeader);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }
  }

  const { searchParams } = new URL(request.url);
  const rawView = (searchParams.get('view') || 'missing_lyrics') as CurationViewKind;
  if (!VALID_VIEWS.has(rawView)) {
    return NextResponse.json(
      { error: `Invalid view parameter "${rawView}". Expected one of missing_lyrics, needs_verification, ambiguous_long, runs.` },
      { status: 400 },
    );
  }

  const cursor = searchParams.get('cursor');
  const limitParam = searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : 25;

  try {
    const result = await listCurationView({
      view: rawView,
      cursor,
      limit: Number.isFinite(limit) ? limit : 25,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed loading curation queue.';
    safeLogCurationError(message, 'curation_get_failed');
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let reviewerEmail = ADMIN_EMAIL;
  if (hasCloudConfig()) {
    const auth = await verifyAdminBearerToken(request.headers.get('authorization'));
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }
    reviewerEmail = auth.user.email || ADMIN_EMAIL;
  }

  try {
    const body = (await request.json()) as Partial<CurationActionPayload>;
    if (!body || !body.action) {
      return NextResponse.json({ error: 'Missing curation action.' }, { status: 400 });
    }

    if (body.action === 'approve_merge') {
      if (!body.sourceBhajanId || !body.targetBhajanId || body.sourceBhajanId === body.targetBhajanId) {
        return NextResponse.json(
          { error: 'approve_merge requires distinct sourceBhajanId and targetBhajanId.' },
          { status: 400 },
        );
      }
    } else if (body.action === 'keep_distinct') {
      if (!body.sourceBhajanId || !body.candidateBhajanId) {
        return NextResponse.json(
          { error: 'keep_distinct requires sourceBhajanId and candidateBhajanId.' },
          { status: 400 },
        );
      }
    } else if (body.action === 'publish_curated') {
      if (!body.bhajanId) {
        return NextResponse.json({ error: 'publish_curated requires bhajanId.' }, { status: 400 });
      }
    } else if (body.action === 'exclude_non_bhajan') {
      if (!body.bhajanId || !body.reason?.trim()) {
        return NextResponse.json(
          { error: 'exclude_non_bhajan requires bhajanId and a non-empty reason.' },
          { status: 400 },
        );
      }
    } else {
      return NextResponse.json(
        { error: 'Unsupported curation action.' },
        { status: 400 },
      );
    }

    const result = await executeCurationAction({
      ...(body as CurationActionPayload),
      reviewerEmail,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed executing curation action.';
    safeLogCurationError(message, 'curation_post_failed');
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
