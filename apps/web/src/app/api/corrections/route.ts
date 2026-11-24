import { NextRequest, NextResponse } from 'next/server';
import {
  computeLyricsDiff,
  type AudioSubmissionInfo,
  type LyricCorrection,
  type ProposedMetadataPatch,
  type SubmissionType,
} from '@bhajami/shared';
import {
  getMergedCatalogWithCloud,
  listCorrectionsWithCloud,
  listOutboxEmails,
  listRevisions,
  saveNewCorrection,
} from '@/lib/catalog-store';
import { dispatchAdminCorrectionEmail } from '@/lib/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_SUBMISSION_TYPES = new Set<SubmissionType>([
  'lyric_correction',
  'alternate_lyrics',
  'new_bhajan',
  'metadata_addition',
]);

function extractBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

function slugifyTitle(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'community-bhajan';
}

function sanitizeAudioSubmission(raw: AudioSubmissionInfo | null | undefined): AudioSubmissionInfo | null {
  if (!raw || typeof raw.url !== 'string' || !raw.url.trim()) return null;
  const info: AudioSubmissionInfo = {
    url: raw.url.trim(),
    label: (raw.label || 'Community Audio Recording').trim(),
    sourceKind: raw.sourceKind === 'uploaded_file' ? 'uploaded_file' : 'external_url',
  };
  if (typeof raw.mimeType === 'string' && raw.mimeType.trim()) {
    info.mimeType = raw.mimeType.trim();
  }
  if (typeof raw.durationSec === 'number' && Number.isFinite(raw.durationSec) && raw.durationSec >= 0) {
    info.durationSec = raw.durationSec;
  }
  return info;
}

export async function GET(request: NextRequest) {
  const idToken = extractBearerToken(request);
  return NextResponse.json({
    corrections: await listCorrectionsWithCloud(idToken),
    outbox: listOutboxEmails(),
    revisions: listRevisions(),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      bhajanId?: string;
      bhajanTitle?: string;
      submissionType?: SubmissionType;
      script?: string;
      alternateScriptKind?: string;
      proposedLyrics?: string[] | string;
      proposedMetadata?: ProposedMetadataPatch;
      audioSubmission?: AudioSubmissionInfo | null;
      reasonOrSource?: string;
      submitterName?: string;
      submitterEmail?: string;
      submitterUid?: string | null;
    };

    const submissionType: SubmissionType =
      body.submissionType && VALID_SUBMISSION_TYPES.has(body.submissionType)
        ? body.submissionType
        : 'lyric_correction';

    const submitterName = (body.submitterName || '').trim();
    const submitterEmail = (body.submitterEmail || '').trim();
    const reasonOrSource = (body.reasonOrSource || '').trim();
    const alternateScriptKind =
      (body.alternateScriptKind || '').trim().slice(0, 40) || undefined;
    const audioSubmission = sanitizeAudioSubmission(body.audioSubmission);

    if (!submitterName || !submitterEmail || !reasonOrSource) {
      return NextResponse.json(
        { error: 'Please provide your name, email, and reason/source.' },
        { status: 400 },
      );
    }

    const lines = Array.isArray(body.proposedLyrics)
      ? body.proposedLyrics.map((l) => l.trim()).filter(Boolean)
      : String(body.proposedLyrics || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);

    const hasMetaChanges = Boolean(
      body.proposedMetadata &&
        Object.values(body.proposedMetadata).some((v) => typeof v === 'string' && v.trim() !== ''),
    );

    const { catalog } = await getMergedCatalogWithCloud();

    let resolvedBhajanId = (body.bhajanId || '').trim();
    let resolvedTitle = (body.bhajanTitle || body.proposedMetadata?.title || '').trim();
    let scriptLabel = (body.script || '').trim();
    let originalLines: string[] = [];

    if (submissionType === 'new_bhajan') {
      if (!resolvedTitle) {
        return NextResponse.json(
          { error: 'Please enter a title for the new bhajan submission.' },
          { status: 400 },
        );
      }
      if (lines.length === 0) {
        return NextResponse.json(
          { error: 'New bhajan submissions must include at least one line of lyrics.' },
          { status: 400 },
        );
      }
      const existingIds = new Set(catalog.bhajans.map((b) => b.id));
      const baseSlug = resolvedBhajanId ? slugifyTitle(resolvedBhajanId) : slugifyTitle(resolvedTitle);
      resolvedBhajanId = existingIds.has(baseSlug)
        ? `${baseSlug}-${Date.now().toString(36)}`
        : baseSlug;
      scriptLabel = scriptLabel || body.proposedMetadata?.language?.trim() || 'Sanskrit / Hindi';
      originalLines = [];
    } else {
      if (!resolvedBhajanId) {
        return NextResponse.json({ error: 'Please provide bhajanId.' }, { status: 400 });
      }
      const bhajan = catalog.bhajans.find((b) => b.id === resolvedBhajanId);
      if (!bhajan) {
        return NextResponse.json({ error: 'Bhajan not found.' }, { status: 404 });
      }
      resolvedTitle = bhajan.title;
      scriptLabel = scriptLabel || bhajan.lyricsSets[0]?.language || 'Roman';
      const matchingSet =
        bhajan.lyricsSets.find((ls) => ls.language.toLowerCase() === scriptLabel.toLowerCase()) ||
        bhajan.lyricsSets[0];
      originalLines = matchingSet?.lines ?? [bhajan.title];

      const diff = computeLyricsDiff(originalLines, lines);
      if (submissionType === 'lyric_correction') {
        if (lines.length === 0) {
          return NextResponse.json(
            { error: 'Proposed lyrics must include at least one non-empty line.' },
            { status: 400 },
          );
        }
        if (!diff.hasChanges && !hasMetaChanges && !audioSubmission) {
          return NextResponse.json(
            { error: 'No lyrics, metadata, or audio changes detected compared to the current version.' },
            { status: 400 },
          );
        }
      } else if (submissionType === 'alternate_lyrics') {
        if (lines.length === 0) {
          return NextResponse.json(
            { error: 'Alternate lyrics submission must include at least one non-empty line.' },
            { status: 400 },
          );
        }
      } else if (submissionType === 'metadata_addition') {
        if (!hasMetaChanges && !audioSubmission && !diff.hasChanges) {
          return NextResponse.json(
            {
              error:
                'Please add at least one metadata update (pitch, raga, beat, tempo, deity, meaning) or upload/link an audio recording.',
            },
            { status: 400 },
          );
        }
      }
    }

    const safeScriptLabel = (scriptLabel || 'Roman').slice(0, 40);

    const correction: LyricCorrection = {
      id: `corr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      bhajanId: resolvedBhajanId,
      bhajanTitle: resolvedTitle,
      submissionType,
      script: safeScriptLabel,
      alternateScriptKind,
      originalLyrics: originalLines,
      proposedLyrics: lines,
      proposedMetadata: body.proposedMetadata,
      audioSubmission,
      reasonOrSource,
      submitterName,
      submitterEmail,
      submitterUid: body.submitterUid ?? null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
      infoRequestedAt: null,
      infoRequestNote: null,
      contributorReply: null,
      contributorRepliedAt: null,
    };

    const idToken = extractBearerToken(request);
    const outboxEmail = await dispatchAdminCorrectionEmail(correction);
    await saveNewCorrection(correction, outboxEmail, idToken);

    return NextResponse.json(
      {
        correction,
        emailNotification: correction.emailNotification,
      },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unable to submit correction' },
      { status: 500 },
    );
  }
}
