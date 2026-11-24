import { NextRequest, NextResponse } from 'next/server';
import type { AudioSubmissionInfo, ProposedMetadataPatch } from '@bhajami/shared';
import {
  getCorrectionById,
  reviewCorrection,
  submitContributorFollowup,
} from '@/lib/catalog-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function extractToken(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization');
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() || null : null;
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const correction = getCorrectionById(id);
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

    const idToken = extractToken(request);

    if (body.action === 'submit_followup') {
      const reply = (body.contributorReply || '').trim();
      if (!reply) {
        return NextResponse.json(
          { error: 'Please provide your follow-up response for the moderator.' },
          { status: 400 },
        );
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
        { error: "Invalid action. Expected 'approve', 'request_info', 'reject', or 'submit_followup'." },
        { status: 400 },
      );
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
      reviewerEmail: body.reviewerEmail,
      idToken,
    });

    if (!updated) {
      return NextResponse.json({ error: 'Correction not found.' }, { status: 404 });
    }

    return NextResponse.json({ correction: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unable to update correction' },
      { status: 500 },
    );
  }
}
