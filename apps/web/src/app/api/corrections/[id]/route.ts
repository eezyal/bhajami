import { NextRequest, NextResponse } from 'next/server';
import type { AudioSubmissionInfo, ProposedMetadataPatch } from '@bhajami/shared';
import {
  getCorrectionByIdWithCloud,
  reviewCorrection,
  submitContributorFollowup,
} from '@/lib/catalog-store';
import { ADMIN_EMAIL } from '@/lib/email';
import {
  extractBearerToken,
  verifyAdminBearerToken,
  verifyUserBearerToken,
} from '@/lib/firebase-admin';
import { hasCloudConfig } from '@/lib/firestore-rest';
import { logEvent } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const authHeader = request.headers.get('authorization');

  if (hasCloudConfig()) {
    const auth = await verifyUserBearerToken(authHeader);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }
    const correction = await getCorrectionByIdWithCloud(id, auth.token);
    if (!correction) {
      return NextResponse.json({ error: 'Correction not found.' }, { status: 404 });
    }
    if (!auth.user.isAdmin && correction.submitterUid !== auth.user.uid) {
      return NextResponse.json(
        { error: 'You do not have permission to view this submission.' },
        { status: 403 },
      );
    }
    return NextResponse.json({ correction });
  }

  const correction = await getCorrectionByIdWithCloud(id);
  if (!correction) {
    return NextResponse.json({ error: 'Correction not found.' }, { status: 404 });
  }
  return NextResponse.json({ correction });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const authHeader = request.headers.get('authorization');
    const body = (await request.json()) as {
      action?: 'approve' | 'request_info' | 'reject' | 'submit_followup';
      reviewNote?: string;
      contributorReply?: string;
      editedLyrics?: string[] | string;
      editedMetadata?: ProposedMetadataPatch;
      proposedLyrics?: string[] | string;
      audioSubmission?: AudioSubmissionInfo | null;
      reviewerEmail?: string;
    };

    const cloud = hasCloudConfig();
    let idToken: string | null = extractBearerToken(authHeader);

    if (body.action === 'submit_followup') {
      const reply = (body.contributorReply || '').trim();
      if (!reply) {
        return NextResponse.json(
          { error: 'Please provide your follow-up response for the moderator.' },
          { status: 400 },
        );
      }

      if (cloud) {
        const auth = await verifyUserBearerToken(authHeader);
        if (!auth.ok) {
          return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
        }
        const existing = await getCorrectionByIdWithCloud(id, auth.token);
        if (!existing) {
          return NextResponse.json({ error: 'Submission not found.' }, { status: 404 });
        }
        if (!auth.user.isAdmin && existing.submitterUid !== auth.user.uid) {
          return NextResponse.json(
            { error: 'Only the original contributor can respond to this submission.' },
            { status: 403 },
          );
        }
        idToken = auth.token;
      }

      const nextLyrics = Array.isArray(body.proposedLyrics)
        ? body.proposedLyrics.map((l) => l.trim()).filter(Boolean)
        : typeof body.proposedLyrics === 'string'
          ? body.proposedLyrics
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
          : undefined;

      const updated = await submitContributorFollowup({
        id,
        contributorReply: reply,
        proposedLyrics: nextLyrics,
        audioSubmission: body.audioSubmission,
        idToken,
      });
      if (!updated) {
        return NextResponse.json({ error: 'Submission not found.' }, { status: 404 });
      }
      return NextResponse.json({ correction: updated });
    }

    if (body.action !== 'approve' && body.action !== 'request_info' && body.action !== 'reject') {
      return NextResponse.json(
        {
          error:
            "Invalid action. Expected 'approve', 'request_info', 'reject', or 'submit_followup'.",
        },
        { status: 400 },
      );
    }

    let reviewerEmail = body.reviewerEmail;
    if (cloud) {
      const adminAuth = await verifyAdminBearerToken(authHeader);
      if (!adminAuth.ok) {
        return NextResponse.json(
          { error: adminAuth.error, code: adminAuth.code },
          { status: adminAuth.status },
        );
      }
      idToken = adminAuth.token;
      reviewerEmail = adminAuth.user.email || ADMIN_EMAIL;
    }

    if (body.action === 'request_info' && !(body.reviewNote || '').trim()) {
      return NextResponse.json(
        { error: 'Please include a moderator question or note when requesting further information.' },
        { status: 400 },
      );
    }

    if (body.action === 'reject' && !(body.reviewNote || '').trim()) {
      return NextResponse.json(
        { error: 'Please include a rejection reason explaining why this submission cannot be accepted.' },
        { status: 400 },
      );
    }

    const editedLyrics = Array.isArray(body.editedLyrics)
      ? body.editedLyrics.map((l) => l.trim()).filter(Boolean)
      : typeof body.editedLyrics === 'string'
        ? body.editedLyrics
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
        : undefined;

    const updated = await reviewCorrection({
      id,
      action: body.action,
      reviewNote: body.reviewNote,
      editedLyrics,
      editedMetadata: body.editedMetadata,
      reviewerEmail,
      idToken,
    });

    if (!updated) {
      return NextResponse.json({ error: 'Correction not found.' }, { status: 404 });
    }

    return NextResponse.json({ correction: updated });
  } catch (err) {
    logEvent('error', {
      route: '/api/corrections/[id] PATCH',
      errCode: 'correction_patch_failed',
      httpStatus: 500,
      message: err instanceof Error ? err.message : 'Unable to update correction',
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unable to update correction' },
      { status: 500 },
    );
  }
}
