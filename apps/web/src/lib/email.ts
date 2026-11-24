import nodemailer from 'nodemailer';
import {
  computeLyricsDiff,
  type LyricCorrection,
  type OutboxEmailRecord,
  type SubmissionType,
} from '@bhajami/shared';
import { getAdminFirestore } from './firebase-admin';
import { logEvent } from './logger';

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'pschax@gmail.com';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

export function formatSubmissionTypeLabel(submissionType?: SubmissionType): string {
  switch (submissionType) {
    case 'alternate_lyrics':
      return 'Alternate Bhajan Lyrics';
    case 'new_bhajan':
      return 'New Bhajan Submission';
    case 'metadata_addition':
      return 'Metadata / Audio Addition';
    case 'lyric_correction':
    default:
      return 'Correction to Bhajan Lyrics';
  }
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildCorrectionAdminEmail(correction: LyricCorrection): {
  subject: string;
  textBody: string;
  htmlBody: string;
} {
  const typeLabel = formatSubmissionTypeLabel(correction.submissionType);
  const diff = computeLyricsDiff(correction.originalLyrics, correction.proposedLyrics);
  const subject = `[bhaJami Moderation] ${typeLabel}: ${correction.bhajanTitle}`;
  const reviewUrl = `${APP_URL}/admin/corrections?selected=${encodeURIComponent(correction.id)}`;

  const textDiffLines =
    correction.submissionType === 'metadata_addition' && correction.proposedLyrics.length === 0
      ? '(Metadata / Audio update only — existing lyrics unchanged)'
      : diff.lines
          .map((d) => {
            if (d.type === 'removed') return `- ${d.line}`;
            if (d.type === 'added') return `+ ${d.line}`;
            return `  ${d.line}`;
          })
          .join('\n');

  const meta = correction.proposedMetadata;
  const metaLines: string[] = [];
  if (meta?.title) metaLines.push(`Title: ${meta.title}`);
  if (meta?.deity) metaLines.push(`Deity: ${meta.deity}`);
  if (meta?.language) metaLines.push(`Language: ${meta.language}`);
  if (meta?.ragaName || meta?.raga) metaLines.push(`Raga: ${meta.ragaName || meta.raga}`);
  if (meta?.arohanam) metaLines.push(`Arohanam: ${meta.arohanam}`);
  if (meta?.avarohanam) metaLines.push(`Avarohanam: ${meta.avarohanam}`);
  if (meta?.gentsPitchRaw) metaLines.push(`Gents Pitch: ${meta.gentsPitchRaw}`);
  if (meta?.ladiesPitchRaw) metaLines.push(`Ladies Pitch: ${meta.ladiesPitchRaw}`);
  if (meta?.beat || meta?.tala) metaLines.push(`Beat / Tala: ${meta.beat || meta.tala}`);
  if (meta?.tempo !== undefined && String(meta.tempo).trim() !== '') {
    metaLines.push(`Tempo: ${String(meta.tempo).trim()}`);
  }
  if (meta?.firstLineSargam) metaLines.push(`First Line Sargam: ${meta.firstLineSargam}`);
  if (meta?.firstLineWestern) metaLines.push(`First Line Western (C): ${meta.firstLineWestern}`);
  if (meta?.notesRange) metaLines.push(`Notes Range: ${meta.notesRange}`);
  if (meta?.sheetMusicUrl) metaLines.push(`Sheet Music URL: ${meta.sheetMusicUrl}`);
  if (meta?.meaning) metaLines.push(`Meaning: ${meta.meaning}`);
  if (meta?.notes) metaLines.push(`Notes: ${meta.notes}`);

  const audioSummary = correction.audioSubmission
    ? `${correction.audioSubmission.label} (${correction.audioSubmission.sourceKind || 'audio'}): ${correction.audioSubmission.url}`
    : '';

  const textBody = [
    `Om Sai Ram,`,
    ``,
    `A community submission (${typeLabel}) is waiting for your review in bhaJami.`,
    ``,
    `Type: ${typeLabel}`,
    `Bhajan: ${correction.bhajanTitle} (${correction.bhajanId})`,
    `Script / Variant: ${correction.script}${correction.alternateScriptKind ? ` (${correction.alternateScriptKind})` : ''}`,
    `Submitted by: ${correction.submitterName} <${correction.submitterEmail}>`,
    `Submitted at: ${correction.createdAt}`,
    `Source / Reason: ${correction.reasonOrSource}`,
    audioSummary ? `Audio Submission: ${audioSummary}` : '',
    correction.contributorReply ? `Contributor Clarification Reply:\n${correction.contributorReply}` : '',
    metaLines.length ? `Metadata Suggestions:\n${metaLines.map((m) => `  * ${m}`).join('\n')}` : '',
    ``,
    `Diff / Lyrics Preview (+${diff.addedCount} added / -${diff.removedCount} removed)`,
    `------------------------------------------------------------`,
    textDiffLines,
    `------------------------------------------------------------`,
    ``,
    `Review & Decide in Admin Queue: ${reviewUrl}`,
  ]
    .filter(Boolean)
    .join('\n');

  const htmlDiffRows =
    correction.submissionType === 'metadata_addition' && correction.proposedLyrics.length === 0
      ? `<div style="padding:8px 10px;color:#6E5340;font-style:italic;">Metadata / Audio update only — existing lyrics unchanged.</div>`
      : diff.lines
          .map((d) => {
            const bg =
              d.type === 'removed' ? '#FDE8E8' : d.type === 'added' ? '#E6F4EA' : 'transparent';
            const fg =
              d.type === 'removed' ? '#9B1C1C' : d.type === 'added' ? '#137333' : '#241710';
            const prefix = d.type === 'removed' ? '−' : d.type === 'added' ? '+' : '·';
            return `<div style="padding:4px 10px;background:${bg};color:${fg};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;border-radius:4px;margin:2px 0;"><strong>${prefix}</strong> ${escapeHtml(d.line)}</div>`;
          })
          .join('');

  const htmlMeta = metaLines.length
    ? `<div style="margin:12px 0;padding:10px 12px;background:#FFF7E8;border-left:3px solid #C84B0F;border-radius:6px;">
         <strong style="color:#8C2F05;">Suggested Metadata Updates:</strong>
         <ul style="margin:6px 0 0 18px;padding:0;">${metaLines.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
       </div>`
    : '';

  const htmlAudio = correction.audioSubmission
    ? `<div style="margin:12px 0;padding:10px 12px;background:#EEF6FF;border-left:3px solid #1D4ED8;border-radius:6px;">
         <strong style="color:#1E40AF;">Attached Audio Recording:</strong>
         <div style="margin-top:4px;font-size:13px;">${escapeHtml(correction.audioSubmission.label)} — <code>${escapeHtml(correction.audioSubmission.url)}</code></div>
       </div>`
    : '';

  const htmlReply = correction.contributorReply
    ? `<div style="margin:12px 0;padding:10px 12px;background:#E6F4EA;border-left:3px solid #137333;border-radius:6px;">
         <strong style="color:#137333;">Contributor Follow-up Reply:</strong>
         <div style="margin-top:4px;white-space:pre-wrap;">${escapeHtml(correction.contributorReply)}</div>
       </div>`
    : '';

  const htmlBody = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;background:#FDF8F0;color:#241710;border:1px solid #E6D5BD;border-radius:12px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#C84B0F,#8C2F05);color:#FFFDF9;padding:18px 22px;">
      <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.9;">bhaJami Admin Moderation Queue</div>
      <h2 style="margin:4px 0 0 0;font-size:20px;">${escapeHtml(typeLabel)} Waiting for Review</h2>
    </div>
    <div style="padding:20px 22px;">
      <p style="margin:0 0 12px 0;">Om Sai Ram,</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:14px;">
        <tr><td style="padding:4px 0;color:#6E5340;width:130px;"><strong>Type:</strong></td><td>${escapeHtml(typeLabel)}</td></tr>
        <tr><td style="padding:4px 0;color:#6E5340;"><strong>Bhajan:</strong></td><td>${escapeHtml(correction.bhajanTitle)} (<code>${escapeHtml(correction.bhajanId)}</code>)</td></tr>
        <tr><td style="padding:4px 0;color:#6E5340;"><strong>Script:</strong></td><td>${escapeHtml(correction.script)}${correction.alternateScriptKind ? ` (${escapeHtml(correction.alternateScriptKind)})` : ''}</td></tr>
        <tr><td style="padding:4px 0;color:#6E5340;"><strong>Contributor:</strong></td><td>${escapeHtml(correction.submitterName)} &lt;${escapeHtml(correction.submitterEmail)}&gt;</td></tr>
        <tr><td style="padding:4px 0;color:#6E5340;"><strong>Reason / Source:</strong></td><td>${escapeHtml(correction.reasonOrSource)}</td></tr>
      </table>
      ${htmlReply}
      ${htmlAudio}
      ${htmlMeta}
      <div style="margin:14px 0 8px 0;font-weight:600;">Proposed Lyrics / Diff (+${diff.addedCount} / −${diff.removedCount}):</div>
      <div style="background:#FFFDF9;border:1px solid #E6D5BD;border-radius:8px;padding:10px;">
        ${htmlDiffRows}
      </div>
      <div style="margin-top:20px;">
        <a href="${escapeHtml(reviewUrl)}" style="display:inline-block;background:#C84B0F;color:#FFFFFF;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px;">Open Waiting for Approval Queue</a>
      </div>
    </div>
  </div>`;

  return { subject, textBody, htmlBody };
}

async function deliverEmail(options: {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  correctionId: string;
  replyTo?: string;
}): Promise<OutboxEmailRecord> {
  const transportsUsed: string[] = [];

  // 1. Optional direct Resend email delivery if API key is configured
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'bhaJami Moderation <onboarding@resend.dev>',
          to: [options.to],
          subject: options.subject,
          text: options.textBody,
          html: options.htmlBody,
        }),
      });
      if (res.ok) {
        transportsUsed.push('resend');
      } else {
        logEvent('warn', {
          route: 'email.deliverEmail',
          errCode: 'resend_http_error',
          httpStatus: res.status,
          docPath: `lyricCorrections/${options.correctionId}`,
          message: `Resend email API responded with HTTP ${res.status}`,
        });
      }
    } catch (err) {
      logEvent('warn', {
        route: 'email.deliverEmail',
        errCode: 'resend_fetch_failed',
        docPath: `lyricCorrections/${options.correctionId}`,
        message: err instanceof Error ? err.message : 'Resend delivery failed',
      });
    }
  }

  // 2. Optional direct Gmail SMTP delivery using a 16-character Google App Password
  const gmailPass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  const gmailUser = process.env.GMAIL_USER || ADMIN_EMAIL;
  if (gmailPass && gmailUser) {
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
          user: gmailUser,
          pass: gmailPass,
        },
      });
      await transporter.sendMail({
        from: `"bhaJami Moderation" <${gmailUser}>`,
        to: options.to,
        replyTo: options.replyTo,
        subject: options.subject,
        text: options.textBody,
        html: options.htmlBody,
      });
      transportsUsed.push('gmail_smtp');
    } catch (err) {
      logEvent('warn', {
        route: 'email.deliverEmail',
        errCode: 'gmail_smtp_failed',
        docPath: `lyricCorrections/${options.correctionId}`,
        message: err instanceof Error ? err.message : 'Gmail SMTP delivery failed',
      });
    }
  }

  // 3. Firebase Trigger Email extension collection (`mail`) when Admin SDK is configured
  const db = getAdminFirestore();
  if (db) {
    try {
      await db.collection('mail').add({
        to: [options.to],
        message: {
          subject: options.subject,
          text: options.textBody,
          html: options.htmlBody,
        },
        correctionId: options.correctionId,
        createdAt: new Date().toISOString(),
      });
      transportsUsed.push('firestore_mail_queue');
    } catch (err) {
      logEvent('warn', {
        route: 'email.deliverEmail',
        errCode: 'firestore_mail_queue_failed',
        docPath: `lyricCorrections/${options.correctionId}`,
        message: err instanceof Error ? err.message : 'Failed writing Firestore mail document',
      });
    }
  }

  if (transportsUsed.length === 0) {
    transportsUsed.push('local_dev_outbox');
  }

  return {
    id: `mail_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    correctionId: options.correctionId,
    to: options.to,
    subject: options.subject,
    textBody: options.textBody,
    htmlBody: options.htmlBody,
    transport: transportsUsed.join(' + '),
    createdAt: new Date().toISOString(),
  };
}

export async function dispatchAdminCorrectionEmail(
  correction: LyricCorrection,
): Promise<OutboxEmailRecord> {
  const { subject, textBody, htmlBody } = buildCorrectionAdminEmail(correction);
  return deliverEmail({
    to: ADMIN_EMAIL,
    subject,
    textBody,
    htmlBody,
    correctionId: correction.id,
    replyTo: correction.submitterEmail,
  });
}

export async function dispatchContributorFollowupEmail(params: {
  correction: LyricCorrection;
  questionNote: string;
  reviewerEmail: string;
}): Promise<OutboxEmailRecord> {
  const { correction, questionNote, reviewerEmail } = params;
  const respondUrl = `${APP_URL}/?respondTo=${encodeURIComponent(correction.id)}`;
  const typeLabel = formatSubmissionTypeLabel(correction.submissionType);
  const subject = `[bhaJami] Clarification requested for "${correction.bhajanTitle}"`;

  const textBody = [
    `Om Sai Ram ${correction.submitterName},`,
    ``,
    `A bhaJami moderator (${reviewerEmail}) reviewed your ${typeLabel} for "${correction.bhajanTitle}" and requested a little more information before publishing:`,
    ``,
    `Moderator Question:`,
    questionNote,
    ``,
    `Reply directly in bhaJami Jam Studio:`,
    respondUrl,
  ].join('\n');

  const htmlBody = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;background:#FDF8F0;color:#241710;border:1px solid #E6D5BD;border-radius:12px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#9A5B13,#7C2D12);color:#FFFDF9;padding:18px 22px;">
      <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.9;">bhaJami Contributor Follow-Up</div>
      <h2 style="margin:4px 0 0 0;font-size:20px;">More Information Requested</h2>
    </div>
    <div style="padding:20px 22px;">
      <p style="margin:0 0 12px 0;">Om Sai Ram ${escapeHtml(correction.submitterName)},</p>
      <p style="margin:0 0 12px 0;">Moderator <strong>${escapeHtml(reviewerEmail)}</strong> reviewed your <strong>${escapeHtml(typeLabel)}</strong> for <strong>${escapeHtml(correction.bhajanTitle)}</strong> and asked:</p>
      <div style="margin:12px 0;padding:12px 14px;background:#FFF7E8;border-left:4px solid #C84B0F;border-radius:6px;white-space:pre-wrap;">${escapeHtml(questionNote)}</div>
      <div style="margin-top:18px;">
        <a href="${escapeHtml(respondUrl)}" style="display:inline-block;background:#C84B0F;color:#FFFFFF;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px;">Provide Follow-Up Details in bhaJami</a>
      </div>
    </div>
  </div>`;

  return deliverEmail({
    to: correction.submitterEmail,
    subject,
    textBody,
    htmlBody,
    correctionId: correction.id,
    replyTo: reviewerEmail,
  });
}

export async function dispatchContributorRejectionEmail(params: {
  correction: LyricCorrection;
  rejectionReason: string;
  reviewerEmail: string;
}): Promise<OutboxEmailRecord> {
  const { correction, rejectionReason, reviewerEmail } = params;
  const respondUrl = `${APP_URL}/?respondTo=${encodeURIComponent(correction.id)}`;
  const typeLabel = formatSubmissionTypeLabel(correction.submissionType);
  const subject = `[bhaJami] Update on your submission for "${correction.bhajanTitle}"`;

  const textBody = [
    `Om Sai Ram ${correction.submitterName},`,
    ``,
    `Thank you for contributing to bhaJami. Moderator ${reviewerEmail} could not approve your ${typeLabel} for "${correction.bhajanTitle}" for the following reason:`,
    ``,
    `Reason:`,
    rejectionReason,
    ``,
    `If you have additional sources, clarification, or revised details, you can reply directly to continue the conversation:`,
    respondUrl,
  ].join('\n');

  const htmlBody = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;background:#FDF8F0;color:#241710;border:1px solid #E6D5BD;border-radius:12px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#991B1B,#7F1D1D);color:#FFFDF9;padding:18px 22px;">
      <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.9;">bhaJami Moderation Update</div>
      <h2 style="margin:4px 0 0 0;font-size:20px;">Submission Not Published (Feedback Included)</h2>
    </div>
    <div style="padding:20px 22px;">
      <p style="margin:0 0 12px 0;">Om Sai Ram ${escapeHtml(correction.submitterName)},</p>
      <p style="margin:0 0 12px 0;">Thank you for contributing to bhaJami. Moderator <strong>${escapeHtml(reviewerEmail)}</strong> declined to publish your <strong>${escapeHtml(typeLabel)}</strong> for <strong>${escapeHtml(correction.bhajanTitle)}</strong> with this reason:</p>
      <div style="margin:12px 0;padding:12px 14px;background:#FEF2F2;border-left:4px solid #DC2626;border-radius:6px;white-space:pre-wrap;">${escapeHtml(rejectionReason)}</div>
      <p style="margin:12px 0 0 0;font-size:14px;color:#574030;">Have a clarified source, recording link, or follow-up comment? Reply directly below to reopen the discussion with the moderator.</p>
      <div style="margin-top:18px;">
        <a href="${escapeHtml(respondUrl)}" style="display:inline-block;background:#C84B0F;color:#FFFFFF;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px;">Reply or Share Follow-Up Details</a>
      </div>
    </div>
  </div>`;

  return deliverEmail({
    to: correction.submitterEmail,
    subject,
    textBody,
    htmlBody,
    correctionId: correction.id,
    replyTo: reviewerEmail,
  });
}

export async function dispatchContributorApprovalEmail(params: {
  correction: LyricCorrection;
  reviewerEmail: string;
}): Promise<OutboxEmailRecord> {
  const { correction, reviewerEmail } = params;
  const typeLabel = formatSubmissionTypeLabel(correction.submissionType);
  const subject = `[bhaJami] Your ${typeLabel} for "${correction.bhajanTitle}" was approved!`;
  const textBody = [
    `Om Sai Ram ${correction.submitterName},`,
    ``,
    `Thank you! Your ${typeLabel} for "${correction.bhajanTitle}" was approved by ${reviewerEmail} and is now live in bhaJami.`,
    correction.reviewNote ? `\nModerator Note: ${correction.reviewNote}` : '',
    `\nOpen bhaJami: ${APP_URL}`,
  ]
    .filter(Boolean)
    .join('\n');

  const htmlBody = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;background:#FDF8F0;color:#241710;border:1px solid #E6D5BD;border-radius:12px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#15803D,#166534);color:#FFFDF9;padding:18px 22px;">
      <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.9;">bhaJami Contribution Published</div>
      <h2 style="margin:4px 0 0 0;font-size:20px;">Approved &amp; Live in Jam Studio</h2>
    </div>
    <div style="padding:20px 22px;">
      <p style="margin:0 0 12px 0;">Om Sai Ram ${escapeHtml(correction.submitterName)},</p>
      <p style="margin:0 0 12px 0;">Thank you! Your <strong>${escapeHtml(typeLabel)}</strong> for <strong>${escapeHtml(correction.bhajanTitle)}</strong> was approved by <strong>${escapeHtml(reviewerEmail)}</strong> and is now live in bhaJami.</p>
      ${
        correction.reviewNote
          ? `<div style="margin:12px 0;padding:12px 14px;background:#ECFDF5;border-left:4px solid #16A34A;border-radius:6px;white-space:pre-wrap;">${escapeHtml(correction.reviewNote)}</div>`
          : ''
      }
      <div style="margin-top:18px;">
        <a href="${escapeHtml(APP_URL)}" style="display:inline-block;background:#C84B0F;color:#FFFFFF;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px;">Open bhaJami Studio</a>
      </div>
    </div>
  </div>`;

  return deliverEmail({
    to: correction.submitterEmail,
    subject,
    textBody,
    htmlBody,
    correctionId: correction.id,
    replyTo: reviewerEmail,
  });
}
