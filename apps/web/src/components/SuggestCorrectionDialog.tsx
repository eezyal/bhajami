'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  computeLyricsDiff,
  type AudioSubmissionInfo,
  type Bhajan,
  type LyricCorrection,
  type ProposedMetadataPatch,
  type SubmissionType,
} from '@bhajami/shared';
import { getCurrentFirebaseIdToken } from '@/lib/firebase-client';
import type { SessionUser } from './AuthDialog';

interface SuggestCorrectionDialogProps {
  open: boolean;
  onClose: () => void;
  bhajan: Bhajan;
  activeScriptIndex: number;
  initialMode?: SubmissionType;
  respondToCorrection?: LyricCorrection | null;
  user: SessionUser | null;
  onSubmitted: () => void;
}

const SUBMISSION_OPTIONS: Array<{
  value: SubmissionType;
  title: string;
  description: string;
}> = [
  {
    value: 'lyric_correction',
    title: '1) Correction to Bhajan',
    description: 'Fix typos, missing lines, or wording in existing lyrics with reason',
  },
  {
    value: 'alternate_lyrics',
    title: '2) Alternate Bhajan Lyrics',
    description: 'Add Devanagari, Telugu, Tamil, or an alternate choir stanza',
  },
  {
    value: 'new_bhajan',
    title: '3) New Bhajan Submission',
    description: 'Propose a brand-new bhajan with lyrics, metadata & audio recording',
  },
  {
    value: 'metadata_addition',
    title: '4) Metadata / Audio Update',
    description: 'Add audio recording, raga, Gents/Ladies pitch, beat, or tempo',
  },
];

const SCRIPT_CHOICES = [
  'Devanagari (Hindi / Sanskrit)',
  'Telugu',
  'Tamil',
  'Kannada',
  'Malayalam',
  'Roman Transliteration',
  'Alternate Choir Variant',
];

export function SuggestCorrectionDialog({
  open,
  onClose,
  bhajan,
  activeScriptIndex,
  initialMode = 'lyric_correction',
  respondToCorrection = null,
  user,
  onSubmitted,
}: SuggestCorrectionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const activeSet = bhajan.lyricsSets[activeScriptIndex] || bhajan.lyricsSets[0];

  const [mode, setMode] = useState<SubmissionType>(initialMode);
  const [lyricsText, setLyricsText] = useState('');
  const [altScript, setAltScript] = useState('Devanagari (Hindi / Sanskrit)');
  const [altScriptKind, setAltScriptKind] = useState('');

  // Metadata fields (used by new_bhajan, metadata_addition, and optional overrides)
  const [newTitle, setNewTitle] = useState('');
  const [deity, setDeity] = useState('');
  const [language, setLanguage] = useState('');
  const [ragaName, setRagaName] = useState('');
  const [beat, setBeat] = useState('');
  const [tempo, setTempo] = useState('');
  const [gentsPitchRaw, setGentsPitchRaw] = useState('');
  const [ladiesPitchRaw, setLadiesPitchRaw] = useState('');
  const [meaning, setMeaning] = useState('');

  // Audio upload / URL state
  const [audioLabel, setAudioLabel] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [audioMimeType, setAudioMimeType] = useState<string | undefined>(undefined);
  const [audioSourceKind, setAudioSourceKind] = useState<'uploaded_file' | 'external_url'>(
    'external_url',
  );
  const [uploadingAudio, setUploadingAudio] = useState(false);

  // Submitter + Reason / Follow-up
  const [reasonOrSource, setReasonOrSource] = useState('');
  const [followupReply, setFollowupReply] = useState('');
  const [submitterName, setSubmitterName] = useState(user?.name || '');
  const [submitterEmail, setSubmitterEmail] = useState(
    user?.email && user.email !== 'guest@local' ? user.email : '',
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submittedInfo, setSubmittedInfo] = useState<{
    id: string;
    to: string;
    transport: string;
    message?: string;
  } | null>(null);

  // Sync initial fields when opening or changing bhajan/mode/respondToCorrection
  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    setSubmittedInfo(null);
    setFollowupReply('');

    if (respondToCorrection) {
      setMode(respondToCorrection.submissionType || 'lyric_correction');
      setLyricsText(respondToCorrection.proposedLyrics.join('\n'));
      setAudioUrl(respondToCorrection.audioSubmission?.url || '');
      setAudioLabel(respondToCorrection.audioSubmission?.label || '');
      setAudioMimeType(respondToCorrection.audioSubmission?.mimeType);
      setAudioSourceKind(respondToCorrection.audioSubmission?.sourceKind || 'external_url');
      return;
    }

    setMode(initialMode);
    if (initialMode === 'lyric_correction') {
      setLyricsText((activeSet?.lines || [bhajan.title]).join('\n'));
    } else {
      setLyricsText('');
    }
    setAltScript('Devanagari (Hindi / Sanskrit)');
    setAltScriptKind('');
    setNewTitle('');
    setDeity('');
    setLanguage('');
    setRagaName('');
    setBeat('');
    setTempo('');
    setGentsPitchRaw('');
    setLadiesPitchRaw('');
    setMeaning('');
    setAudioLabel('');
    setAudioUrl('');
    setAudioMimeType(undefined);
    setAudioSourceKind('external_url');
    setReasonOrSource('');
  }, [open, bhajan.id, activeScriptIndex, initialMode, respondToCorrection]);

  // Adjust lyrics pre-fill when user switches between the 4 radio modes interactively
  const handleModeChange = (nextMode: SubmissionType) => {
    setMode(nextMode);
    setErrorMsg(null);
    if (nextMode === 'lyric_correction') {
      setLyricsText((activeSet?.lines || [bhajan.title]).join('\n'));
    } else if (nextMode === 'alternate_lyrics' || nextMode === 'new_bhajan') {
      setLyricsText('');
    }
  };

  useEffect(() => {
    if (user?.name && !submitterName) setSubmitterName(user.name);
    if (user?.email && user.email !== 'guest@local' && !submitterEmail) {
      setSubmitterEmail(user.email);
    }
  }, [user, submitterName, submitterEmail]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const onDialogClose = () => {
      dialog.returnValue = '';
      onClose();
    };
    dialog.addEventListener('close', onDialogClose);

    let pointerDownOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };
    const onPointerDown = (e: PointerEvent) => {
      pointerDownOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!('closedBy' in HTMLDialogElement.prototype) && pointerDownOutside && isOutside(e)) {
        dialog.close();
      }
    };

    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('pointerup', onPointerUp);

    return () => {
      dialog.removeEventListener('close', onDialogClose);
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('pointerup', onPointerUp);
    };
  }, [onClose]);

  const proposedLines = useMemo(
    () =>
      lyricsText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    [lyricsText],
  );

  const diffPreview = useMemo(
    () => computeLyricsDiff(activeSet?.lines || [bhajan.title], proposedLines),
    [activeSet, bhajan.title, proposedLines],
  );

  const handleAudioFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAudio(true);
    setErrorMsg(null);

    try {
      const idToken = await getCurrentFirebaseIdToken();
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/uploaded-audio', {
        method: 'POST',
        headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
        body: formData,
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error || 'Audio upload failed.');
        setUploadingAudio(false);
        return;
      }

      setAudioUrl(json.url);
      setAudioMimeType(json.mimeType);
      setAudioSourceKind('uploaded_file');
      if (!audioLabel.trim()) {
        setAudioLabel(file.name.replace(/\.[^.]+$/, ''));
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to upload audio recording.');
    } finally {
      setUploadingAudio(false);
    }
  };

  const buildAudioSubmission = (): AudioSubmissionInfo | null => {
    const trimmedUrl = audioUrl.trim();
    if (!trimmedUrl) return null;
    return {
      url: trimmedUrl,
      label:
        audioLabel.trim() ||
        (mode === 'new_bhajan' ? `${newTitle.trim() || 'New Bhajan'} Recording` : `${bhajan.title} Audio`),
      mimeType: audioMimeType,
      sourceKind: audioSourceKind,
    };
  };

  const buildProposedMetadata = (): ProposedMetadataPatch | undefined => {
    const patch: ProposedMetadataPatch = {};
    if (mode === 'new_bhajan' && newTitle.trim()) patch.title = newTitle.trim();
    if (deity.trim()) patch.deity = deity.trim();
    if (language.trim()) patch.language = language.trim();
    if (ragaName.trim()) patch.ragaName = ragaName.trim();
    if (beat.trim()) patch.beat = beat.trim();
    if (tempo.trim()) patch.tempo = tempo.trim();
    if (gentsPitchRaw.trim()) patch.gentsPitchRaw = gentsPitchRaw.trim();
    if (ladiesPitchRaw.trim()) patch.ladiesPitchRaw = ladiesPitchRaw.trim();
    if (meaning.trim()) patch.meaning = meaning.trim();
    return Object.keys(patch).length > 0 ? patch : undefined;
  };

  const handleFollowupSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!respondToCorrection) return;
    if (!e.currentTarget.reportValidity()) return;

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const idToken = await getCurrentFirebaseIdToken();
      const res = await fetch(
        `/api/corrections/${encodeURIComponent(respondToCorrection.id)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body: JSON.stringify({
            action: 'submit_followup',
            contributorReply: followupReply,
            proposedLyrics: proposedLines.length > 0 ? proposedLines : undefined,
            audioSubmission: buildAudioSubmission() ?? undefined,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error || 'Could not submit follow-up response.');
        setSubmitting(false);
        return;
      }

      setSubmittedInfo({
        id: respondToCorrection.id,
        to: 'pschax@gmail.com',
        transport: 'moderator_requeued',
        message:
          'Your clarification reply has been attached and returned to the Waiting for Approval queue.',
      });
      setSubmitting(false);
      onSubmitted();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Network error sending follow-up.');
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!e.currentTarget.reportValidity()) return;

    const proposedMetadata = buildProposedMetadata();
    const audioSubmission = buildAudioSubmission();

    if (mode === 'metadata_addition' && !proposedMetadata && !audioSubmission) {
      setErrorMsg(
        'Please enter at least one metadata update (pitch, raga, beat, tempo, deity, meaning) or upload/link an audio recording.',
      );
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    try {
      const idToken = await getCurrentFirebaseIdToken();
      const res = await fetch('/api/corrections', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({
          bhajanId: mode === 'new_bhajan' ? undefined : bhajan.id,
          bhajanTitle: mode === 'new_bhajan' ? newTitle.trim() : bhajan.title,
          submissionType: mode,
          script:
            mode === 'alternate_lyrics'
              ? altScript
              : mode === 'new_bhajan'
                ? language.trim() || 'Sanskrit / Hindi'
                : activeSet?.language || 'Roman',
          alternateScriptKind:
            mode === 'alternate_lyrics' && altScriptKind.trim() ? altScriptKind.trim() : undefined,
          proposedLyrics: proposedLines,
          proposedMetadata,
          audioSubmission,
          reasonOrSource,
          submitterName,
          submitterEmail,
          submitterUid: idToken ? user?.uid || null : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error || 'Could not submit contribution.');
        setSubmitting(false);
        return;
      }

      setSubmittedInfo({
        id: json.correction.id,
        to: json.emailNotification?.to || 'pschax@gmail.com',
        transport: json.emailNotification?.transport || 'local_dev_outbox',
      });
      setSubmitting(false);
      onSubmitted();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Network error submitting contribution.');
      setSubmitting(false);
    }
  };

  const renderAudioSection = (heading: string) => (
    <div className="audio-preview-card" style={{ marginBottom: '0.9rem' }}>
      <div className="control-label" style={{ marginBottom: '0.45rem' }}>
        {heading}
      </div>
      <div className="pitch-grid" style={{ marginBottom: '0.5rem' }}>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label htmlFor="corr-audio-file">Upload Recording (.mp3, .m4a, .wav, .ogg)</label>
          <input
            id="corr-audio-file"
            type="file"
            accept=".mp3,.m4a,.mp4,.aac,.wav,.ogg,.opus,.webm,audio/*"
            className="input-control"
            disabled={uploadingAudio}
            onChange={handleAudioFileUpload}
          />
          {uploadingAudio && (
            <span className="field-hint">Uploading recording to bhaJami audio store…</span>
          )}
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label htmlFor="corr-audio-url">Or Paste Audio URL</label>
          <input
            id="corr-audio-url"
            type="url"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="https://... or auto-filled on upload"
            className="input-control"
            value={audioUrl}
            onChange={(e) => {
              setAudioUrl(e.target.value);
              setAudioSourceKind(
                e.target.value.startsWith('/api/uploaded-audio') ? 'uploaded_file' : 'external_url',
              );
            }}
          />
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label htmlFor="corr-audio-label">Recording Label</label>
          <input
            id="corr-audio-label"
            type="text"
            placeholder="e.g., Sai Bhajan Choir / Solo Take"
            className="input-control"
            value={audioLabel}
            onChange={(e) => setAudioLabel(e.target.value)}
          />
        </div>
      </div>
      {audioUrl && (
        <div style={{ marginTop: '0.5rem' }}>
          <audio controls preload="metadata" src={audioUrl} style={{ width: '100%' }} />
        </div>
      )}
    </div>
  );

  return (
    <dialog
      ref={dialogRef}
      id="suggest-correction-dialog"
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="correction-dialog-title"
    >
      <div className="dialog-inner">
        <div className="dialog-header">
          <div>
            <h2 id="correction-dialog-title">
              {respondToCorrection
                ? respondToCorrection.status === 'rejected'
                  ? 'Respond to Moderator Decision'
                  : 'Respond to Moderator Question'
                : mode === 'new_bhajan'
                  ? 'Submit a New Bhajan'
                  : 'Contribute to Bhajan Catalog'}
            </h2>
            <span className="field-hint">
              {respondToCorrection ? (
                <>
                  Submission: <strong>{respondToCorrection.bhajanTitle}</strong> · ID{' '}
                  <code>{respondToCorrection.id}</code>
                </>
              ) : mode === 'new_bhajan' ? (
                'Creating a brand-new bhajan entry for moderator review'
              ) : (
                <>
                  Bhajan: <strong>{bhajan.title}</strong> ({activeSet?.language || 'Roman'})
                </>
              )}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close contribution dialog"
          >
            Close
          </button>
        </div>

        {submittedInfo ? (
          <div className="control-box">
            <div className="badge badge-pending" style={{ marginBottom: '0.6rem' }}>
              Waiting for Admin Approval · ID {submittedInfo.id}
            </div>
            <p style={{ margin: '0 0 0.75rem 0' }}>
              {submittedInfo.message ||
                `Your submission was saved in the moderation queue and an email notification was prepared for admin review at ${submittedInfo.to} (${submittedInfo.transport}).`}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
              <Link href={`/admin/corrections?selected=${submittedInfo.id}`} className="btn btn-primary">
                View in Admin Moderation Queue
              </Link>
              <button
                type="button"
                className="btn"
                onClick={() => dialogRef.current?.close()}
              >
                Back to Jam Studio
              </button>
            </div>
          </div>
        ) : respondToCorrection ? (
          <form onSubmit={handleFollowupSubmit}>
            {respondToCorrection.status === 'rejected' && respondToCorrection.reviewNote && (
              <div
                className="control-box"
                style={{
                  marginBottom: '0.9rem',
                  borderColor: 'var(--danger)',
                  background: '#FEF2F2',
                  color: '#7F1D1D',
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>
                  Rejection Reason ({respondToCorrection.reviewedBy || 'pschax@gmail.com'}):
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{respondToCorrection.reviewNote}</div>
              </div>
            )}
            {respondToCorrection.infoRequestNote && (
              <div
                className="control-box"
                style={{
                  marginBottom: '0.9rem',
                  borderColor: '#f59e0b',
                  background: '#fef3c7',
                  color: '#78350f',
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>
                  Moderator Question ({respondToCorrection.reviewedBy || 'pschax@gmail.com'}):
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{respondToCorrection.infoRequestNote}</div>
              </div>
            )}

            <div className="form-field">
              <label htmlFor="followup-reply">Your Clarification / Additional Details</label>
              <textarea
                id="followup-reply"
                rows={4}
                required
                autoFocus
                className="textarea-control"
                data-error="followup-reply-error"
                placeholder="Share the source reference, recording context, or clarified lyrics..."
                value={followupReply}
                onChange={(e) => setFollowupReply(e.target.value)}
              />
              <div id="followup-reply-error" className="error-msg">
                <span role="img" aria-label="Error">
                  ❌
                </span>{' '}
                Please enter your follow-up answer for the moderator.
              </div>
            </div>

            {respondToCorrection.submissionType !== 'metadata_addition' && (
              <div className="form-field">
                <label htmlFor="followup-lyrics">Updated Proposed Lyrics (optional refinement)</label>
                <textarea
                  id="followup-lyrics"
                  rows={5}
                  className="textarea-control"
                  value={lyricsText}
                  onChange={(e) => setLyricsText(e.target.value)}
                />
              </div>
            )}

            {renderAudioSection('Attach or Update Audio Recording (optional)')}

            {errorMsg && (
              <p style={{ color: 'var(--danger)', fontSize: '0.88rem', marginBottom: '0.8rem' }}>
                {errorMsg}
              </p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
              <button
                type="button"
                className="btn"
                onClick={() => dialogRef.current?.close()}
              >
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={submitting || uploadingAudio}>
                {submitting ? 'Sending Follow-Up…' : 'Send Follow-Up to Moderator'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSubmit}>
            <fieldset style={{ border: 0, padding: 0, margin: '0 0 1rem 0' }}>
              <legend className="control-label" style={{ marginBottom: '0.45rem' }}>
                Choose Contribution Type
              </legend>
              <div className="mode-selector-grid">
                {SUBMISSION_OPTIONS.map((opt) => (
                  <label key={opt.value} className="mode-option-card">
                    <input
                      type="radio"
                      name="submissionType"
                      value={opt.value}
                      checked={mode === opt.value}
                      onChange={() => handleModeChange(opt.value)}
                    />
                    <span>
                      <span className="mode-option-title">{opt.title}</span>
                      <span className="mode-option-desc">{opt.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {mode === 'new_bhajan' && (
              <div className="pitch-grid" style={{ marginBottom: '0.6rem' }}>
                <div className="form-field">
                  <label htmlFor="corr-new-title">New Bhajan Title</label>
                  <input
                    id="corr-new-title"
                    type="text"
                    required
                    placeholder="e.g., Sai Prem Devara"
                    className="input-control"
                    data-error="corr-new-title-error"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                  />
                  <div id="corr-new-title-error" className="error-msg">
                    <span role="img" aria-label="Error">
                      ❌
                    </span>{' '}
                    Please enter the bhajan title.
                  </div>
                </div>
                <div className="form-field">
                  <label htmlFor="corr-new-deity">Deity / Theme</label>
                  <input
                    id="corr-new-deity"
                    type="text"
                    placeholder="e.g., Sai, Ganesha, Devi, Sarva Dharma"
                    className="input-control"
                    value={deity}
                    onChange={(e) => setDeity(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="corr-new-lang">Primary Language / Script</label>
                  <input
                    id="corr-new-lang"
                    type="text"
                    placeholder="Sanskrit / Hindi"
                    className="input-control"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                  />
                </div>
              </div>
            )}

            {mode === 'alternate_lyrics' && (
              <div className="pitch-grid" style={{ marginBottom: '0.6rem' }}>
                <div className="form-field">
                  <label htmlFor="corr-alt-script">Alternate Script / Language</label>
                  <select
                    id="corr-alt-script"
                    className="select-control"
                    value={altScript}
                    onChange={(e) => setAltScript(e.target.value)}
                  >
                    {SCRIPT_CHOICES.map((sc) => (
                      <option key={sc} value={sc}>
                        {sc}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label htmlFor="corr-alt-kind">Optional Edition / Choir Variant Label</label>
                  <input
                    id="corr-alt-kind"
                    type="text"
                    placeholder="e.g., Prasanthi Bhajanawali or Devanagari"
                    className="input-control"
                    value={altScriptKind}
                    onChange={(e) => setAltScriptKind(e.target.value)}
                  />
                </div>
              </div>
            )}

            {mode !== 'metadata_addition' && (
              <div className="form-field">
                <label htmlFor="corr-lyrics">
                  {mode === 'lyric_correction'
                    ? 'Proposed Lyrics (one line per verse)'
                    : mode === 'alternate_lyrics'
                      ? `Alternate Lyrics in ${altScript}`
                      : 'Complete Lyrics (one line per verse)'}
                </label>
                <span id="corr-lyrics-hint" className="field-hint">
                  {mode === 'lyric_correction'
                    ? 'Edit lines directly; live diff preview updates below'
                    : 'Enter one line per verse for clear karaoke & projector display'}
                </span>
                <textarea
                  id="corr-lyrics"
                  rows={6}
                  required
                  className="textarea-control"
                  aria-describedby="corr-lyrics-hint"
                  data-error="corr-lyrics-error"
                  value={lyricsText}
                  onChange={(e) => setLyricsText(e.target.value)}
                />
                <div id="corr-lyrics-error" className="error-msg">
                  <span role="img" aria-label="Error">
                    ❌
                  </span>{' '}
                  Please enter at least one line of lyrics.
                </div>
              </div>
            )}

            {mode === 'lyric_correction' && (
              <div style={{ marginBottom: '0.9rem' }}>
                <div className="control-label">
                  Live Diff Preview (+{diffPreview.addedCount} / −{diffPreview.removedCount})
                </div>
                <div className="diff-box" style={{ maxHeight: '140px', overflowY: 'auto' }}>
                  {diffPreview.lines.map((d, i) => (
                    <div
                      key={`${i}-${d.type}`}
                      className={`diff-line ${
                        d.type === 'removed'
                          ? 'diff-line-removed'
                          : d.type === 'added'
                            ? 'diff-line-added'
                            : ''
                      }`}
                    >
                      {d.type === 'removed' ? '− ' : d.type === 'added' ? '+ ' : '  '}
                      {d.line}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(mode === 'new_bhajan' || mode === 'metadata_addition') &&
              renderAudioSection(
                mode === 'new_bhajan'
                  ? 'Optional Audio Recording (upload file or link URL)'
                  : 'Audio Recording Addition (upload file or link URL)',
              )}

            <div className="pitch-grid" style={{ marginBottom: '0.6rem' }}>
              <div className="form-field">
                <label htmlFor="corr-raga">
                  {mode === 'metadata_addition' ? 'Raga' : 'Optional Raga'}
                </label>
                <input
                  id="corr-raga"
                  type="text"
                  placeholder={
                    mode === 'new_bhajan'
                      ? 'e.g., Hamsadhwani'
                      : bhajan.raga?.name || 'e.g., Hamsadhwani'
                  }
                  className="input-control"
                  value={ragaName}
                  onChange={(e) => setRagaName(e.target.value)}
                />
              </div>
              <div className="form-field">
                <label htmlFor="corr-gents">
                  {mode === 'metadata_addition' ? 'Gents Pitch' : 'Optional Gents Pitch'}
                </label>
                <input
                  id="corr-gents"
                  type="text"
                  placeholder={
                    mode === 'new_bhajan'
                      ? 'e.g., 1.5 Pancham / C#'
                      : bhajan.gentsPitch?.raw || 'e.g., 1.5 Pancham / C#'
                  }
                  className="input-control"
                  value={gentsPitchRaw}
                  onChange={(e) => setGentsPitchRaw(e.target.value)}
                />
              </div>
              <div className="form-field">
                <label htmlFor="corr-ladies">
                  {mode === 'metadata_addition' ? 'Ladies Pitch' : 'Optional Ladies Pitch'}
                </label>
                <input
                  id="corr-ladies"
                  type="text"
                  placeholder={
                    mode === 'new_bhajan'
                      ? 'e.g., 6 Pancham / A'
                      : bhajan.ladiesPitch?.raw || 'e.g., 6 Pancham / A'
                  }
                  className="input-control"
                  value={ladiesPitchRaw}
                  onChange={(e) => setLadiesPitchRaw(e.target.value)}
                />
              </div>
            </div>

            {(mode === 'new_bhajan' || mode === 'metadata_addition') && (
              <div className="pitch-grid" style={{ marginBottom: '0.6rem' }}>
                <div className="form-field">
                  <label htmlFor="corr-beat">Beat / Tala</label>
                  <input
                    id="corr-beat"
                    type="text"
                    placeholder={
                      mode === 'new_bhajan'
                        ? 'e.g., Kaharwa (4/4)'
                        : bhajan.beat || 'e.g., Kaharwa (4/4)'
                    }
                    className="input-control"
                    value={beat}
                    onChange={(e) => setBeat(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="corr-tempo">Natural Tempo</label>
                  <input
                    id="corr-tempo"
                    type="text"
                    placeholder={
                      mode === 'new_bhajan'
                        ? 'e.g., Slow / Medium / Fast'
                        : bhajan.tempo || 'e.g., Slow / Medium / Fast'
                    }
                    className="input-control"
                    value={tempo}
                    onChange={(e) => setTempo(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="corr-meaning">Meaning / Notes</label>
                  <input
                    id="corr-meaning"
                    type="text"
                    placeholder="Concise devotional translation..."
                    className="input-control"
                    value={meaning}
                    onChange={(e) => setMeaning(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="form-field">
              <label htmlFor="corr-reason">Reason or Reference Source</label>
              <span id="corr-reason-hint" className="field-hint">
                Example: Sai Rhythms entry, Prasanthi Bhajanawali page, or A Bhajan A Day recording
              </span>
              <input
                id="corr-reason"
                type="text"
                required
                className="input-control"
                aria-describedby="corr-reason-hint"
                data-error="corr-reason-error"
                value={reasonOrSource}
                onChange={(e) => setReasonOrSource(e.target.value)}
              />
              <div id="corr-reason-error" className="error-msg">
                <span role="img" aria-label="Error">
                  ❌
                </span>{' '}
                Please explain the source or reason for this submission.
              </div>
            </div>

            <div className="pitch-grid">
              <div className="form-field">
                <label htmlFor="corr-name">Your Name</label>
                <input
                  id="corr-name"
                  type="text"
                  required
                  autoComplete="name"
                  className="input-control"
                  data-error="corr-name-error"
                  value={submitterName}
                  onChange={(e) => setSubmitterName(e.target.value)}
                />
                <div id="corr-name-error" className="error-msg">
                  <span role="img" aria-label="Error">
                    ❌
                  </span>{' '}
                  Please enter your name.
                </div>
              </div>
              <div className="form-field">
                <label htmlFor="corr-email">Your Email (for approval / follow-up updates)</label>
                <input
                  id="corr-email"
                  type="email"
                  required
                  autoComplete="email"
                  spellCheck={false}
                  className="input-control"
                  data-error="corr-email-error"
                  value={submitterEmail}
                  onChange={(e) => setSubmitterEmail(e.target.value)}
                />
                <div id="corr-email-error" className="error-msg">
                  <span role="img" aria-label="Error">
                    ❌
                  </span>{' '}
                  Enter an email address in the format you@example.com.
                </div>
              </div>
            </div>

            {errorMsg && (
              <p style={{ color: 'var(--danger)', fontSize: '0.88rem', marginBottom: '0.8rem' }}>
                {errorMsg}
              </p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
              <button
                type="button"
                className="btn"
                onClick={() => dialogRef.current?.close()}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={submitting || uploadingAudio}
              >
                {submitting
                  ? 'Submitting & Emailing Admin…'
                  : mode === 'new_bhajan'
                    ? 'Submit New Bhajan for Approval'
                    : 'Submit for Admin Approval'}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
