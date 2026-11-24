'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import {
  computeLyricsDiff,
  type BhajanRevision,
  type LyricCorrection,
  type OutboxEmailRecord,
  type SubmissionType,
} from '@bhajami/shared';
import { getCurrentFirebaseIdToken, getFirebaseClientAuth } from '@/lib/firebase-client';
import { ThemeToggle } from './ThemeToggle';

type AdminTab = 'pending' | 'info_requested' | 'approved' | 'rejected' | 'outbox';

interface AdminModerationClientProps {
  initialCorrections: LyricCorrection[];
  initialOutbox: OutboxEmailRecord[];
  initialRevisions: BhajanRevision[];
  initialSelectedId?: string;
}

function submissionTypeLabel(submissionType?: SubmissionType): string {
  switch (submissionType) {
    case 'alternate_lyrics':
      return 'Alternate Lyrics';
    case 'new_bhajan':
      return 'New Bhajan';
    case 'metadata_addition':
      return 'Metadata / Audio';
    case 'lyric_correction':
    default:
      return 'Correction';
  }
}

export function AdminModerationClient({
  initialCorrections,
  initialOutbox,
  initialRevisions,
  initialSelectedId,
}: AdminModerationClientProps) {
  const [corrections, setCorrections] = useState(initialCorrections);
  const [outbox, setOutbox] = useState(initialOutbox);
  const [revisions, setRevisions] = useState(initialRevisions);
  const [activeTab, setActiveTab] = useState<AdminTab>('pending');

  const [selectedId, setSelectedId] = useState<string>(
    initialSelectedId ||
      initialCorrections.find((c) => c.status === 'pending')?.id ||
      initialCorrections.find((c) => c.status === 'info_requested')?.id ||
      initialCorrections[0]?.id ||
      '',
  );
  const [editedLyricsText, setEditedLyricsText] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [adminEmail, setAdminEmail] = useState<string | null>(null);
  const reviewNoteRef = useRef<HTMLTextAreaElement>(null);

  const pendingList = useMemo(
    () => corrections.filter((c) => c.status === 'pending'),
    [corrections],
  );
  const infoRequestedList = useMemo(
    () => corrections.filter((c) => c.status === 'info_requested'),
    [corrections],
  );
  const approvedList = useMemo(
    () => corrections.filter((c) => c.status === 'approved'),
    [corrections],
  );
  const rejectedList = useMemo(
    () => corrections.filter((c) => c.status === 'rejected'),
    [corrections],
  );

  const visibleCorrections =
    activeTab === 'pending'
      ? pendingList
      : activeTab === 'info_requested'
        ? infoRequestedList
        : activeTab === 'approved'
          ? approvedList
          : rejectedList;

  const selected = useMemo(
    () =>
      corrections.find((c) => c.id === selectedId) ||
      visibleCorrections[0] ||
      corrections[0],
    [corrections, selectedId, visibleCorrections],
  );

  useEffect(() => {
    if (selected) {
      setEditedLyricsText(selected.proposedLyrics.join('\n'));
      setReviewNote(selected.infoRequestNote || selected.reviewNote || '');
      setActionError(null);
    }
  }, [selected?.id]);

  const reloadAll = async (explicitToken?: string | null) => {
    const token = explicitToken !== undefined ? explicitToken : await getCurrentFirebaseIdToken();
    const res = await fetch('/api/corrections', {
      cache: 'no-store',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) return;
    const data = await res.json();
    setCorrections(data.corrections || []);
    setOutbox(data.outbox || []);
    setRevisions(data.revisions || []);
  };

  useEffect(() => {
    const fb = getFirebaseClientAuth();
    if (!fb) return;
    return onAuthStateChanged(fb.auth, async (u) => {
      setAdminEmail(u?.email ?? null);
      if (u) {
        try {
          const tok = await u.getIdToken();
          await reloadAll(tok);
        } catch {
          // Keep current state if token fetch fails
        }
      }
    });
  }, []);

  const editedLines = useMemo(
    () =>
      editedLyricsText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    [editedLyricsText],
  );

  const diff = useMemo(
    () =>
      selected
        ? computeLyricsDiff(selected.originalLyrics, editedLines)
        : null,
    [editedLines, selected],
  );

  const metadataEntries = useMemo(() => {
    if (!selected?.proposedMetadata) return [];
    const meta = selected.proposedMetadata;
    const labels: Array<[string, string | undefined]> = [
      ['Title', meta.title],
      ['Deity', meta.deity],
      ['Language', meta.language],
      ['Raga', meta.ragaName || meta.raga],
      ['Arohanam', meta.arohanam],
      ['Avarohanam', meta.avarohanam],
      ['Gents Pitch', meta.gentsPitchRaw],
      ['Ladies Pitch', meta.ladiesPitchRaw],
      ['Beat / Tala', meta.beat || meta.tala],
      ['Tempo', meta.tempo !== undefined ? String(meta.tempo) : undefined],
      ['First Line Sargam', meta.firstLineSargam],
      ['First Line Western (C)', meta.firstLineWestern],
      ['Notes Range', meta.notesRange],
      ['Sheet Music URL', meta.sheetMusicUrl],
      ['Meaning', meta.meaning],
      ['Notes', meta.notes],
    ];
    return labels.filter(([, val]) => Boolean(val && val.trim()));
  }, [selected?.proposedMetadata]);

  const handleDecision = async (action: 'approve' | 'request_info' | 'reject') => {
    if (!selected) return;
    setActionError(null);
    setBanner(null);

    if (action === 'request_info' && !reviewNote.trim()) {
      setActionError(
        'Please enter a moderator question or note explaining what information you need from the contributor.',
      );
      reviewNoteRef.current?.focus();
      return;
    }

    if (action === 'reject' && !reviewNote.trim()) {
      setActionError(
        'Please enter a rejection reason explaining why this submission cannot be accepted.',
      );
      reviewNoteRef.current?.focus();
      return;
    }

    setActionBusy(true);
    try {
      const token = await getCurrentFirebaseIdToken();
      const res = await fetch(`/api/corrections/${encodeURIComponent(selected.id)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          action,
          reviewNote,
          editedLyrics: action === 'approve' ? editedLines : undefined,
          reviewerEmail: adminEmail || 'pschax@gmail.com',
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setActionError(json.error || 'Failed to update submission');
        setActionBusy(false);
        return;
      }

      await reloadAll(token);
      setBanner(
        action === 'approve'
          ? `Approved & published ${submissionTypeLabel(selected.submissionType)} for "${selected.bhajanTitle}". Live Jam Studio updated immediately!`
          : action === 'reject'
            ? `Rejected "${selected.bhajanTitle}" with reason and sent feedback + reply link to ${selected.submitterEmail}.`
            : `Sent follow-up question to ${selected.submitterEmail} for "${selected.bhajanTitle}" and moved it to Info Requested.`,
      );
      setActionBusy(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Network error updating submission');
      setActionBusy(false);
    }
  };

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'focusGroup')) {
      return;
    }
    const order: AdminTab[] = ['pending', 'info_requested', 'approved', 'rejected', 'outbox'];
    const idx = order.indexOf(activeTab);
    if (e.key === 'ArrowRight') {
      const next = order[(idx + 1) % order.length];
      setActiveTab(next);
      document.getElementById(`admin-tab-${next}`)?.focus();
    } else if (e.key === 'ArrowLeft') {
      const prev = order[(idx - 1 + order.length) % order.length];
      setActiveTab(prev);
      document.getElementById(`admin-tab-${prev}`)?.focus();
    }
  };

  const canModerateSelected =
    selected?.status === 'pending' || selected?.status === 'info_requested';

  return (
    <>
      <header className="top-header">
        <div className="top-header-inner">
          <Link href="/" className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              भ
            </span>
            <span>
              <span className="brand-title">bhaJami Admin Moderation</span>
              <span className="brand-sub">
                Community Contributions Queue · Admin Notifications to pschax@gmail.com
              </span>
            </span>
          </Link>

          <div className="header-actions">
            {adminEmail ? (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const fb = getFirebaseClientAuth();
                  if (fb) await signOut(fb.auth);
                }}
              >
                Cloud Firestore: {adminEmail} (Sign out)
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const fb = getFirebaseClientAuth();
                  if (!fb) return;
                  try {
                    await signInWithPopup(fb.auth, fb.googleProvider);
                  } catch (err) {
                    setBanner(err instanceof Error ? err.message : 'Google Sign-In failed');
                  }
                }}
              >
                Sign in with Google (Cloud Sync)
              </button>
            )}
            <Link href="/" className="btn btn-primary">
              Back to Jam Studio
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="portal-shell">
        <div className="stats-strip">
          <span className="badge badge-pending">
            Waiting for Approval: {pendingList.length}
          </span>
          <span className="badge badge-info-requested">
            Info Requested: {infoRequestedList.length}
          </span>
          <span className="badge badge-verified">Approved: {approvedList.length}</span>
          <span className="badge">Rejected: {rejectedList.length}</span>
          <span className="badge">Emails Dispatched: {outbox.length}</span>
          <span className="badge">Published Revisions: {revisions.length}</span>
        </div>

        {banner && (
          <div
            role="status"
            className="card"
            style={{
              marginBottom: '1rem',
              borderColor: 'var(--success)',
              background: 'var(--success-bg)',
              color: 'var(--success)',
              fontWeight: 600,
            }}
          >
            {banner}
          </div>
        )}

        <div className="card tabs-wrapper" style={{ marginBottom: '1.2rem' }}>
          <div
            className="tablist-scroller"
            {...({ focusgroup: 'tablist nomemory' } as Record<string, string>)}
            role="tablist"
            aria-label="Moderation Queue Views"
            onKeyDown={handleTabKeyDown}
          >
            <button
              id="admin-tab-pending"
              type="button"
              role="tab"
              aria-selected={activeTab === 'pending'}
              {...({ focusgroupstart: activeTab === 'pending' ? '' : undefined } as Record<
                string,
                string | undefined
              >)}
              onClick={() => setActiveTab('pending')}
            >
              Waiting for Approval ({pendingList.length})
            </button>
            <button
              id="admin-tab-info_requested"
              type="button"
              role="tab"
              aria-selected={activeTab === 'info_requested'}
              {...({ focusgroupstart: activeTab === 'info_requested' ? '' : undefined } as Record<
                string,
                string | undefined
              >)}
              onClick={() => setActiveTab('info_requested')}
            >
              Info Requested ({infoRequestedList.length})
            </button>
            <button
              id="admin-tab-approved"
              type="button"
              role="tab"
              aria-selected={activeTab === 'approved'}
              {...({ focusgroupstart: activeTab === 'approved' ? '' : undefined } as Record<
                string,
                string | undefined
              >)}
              onClick={() => setActiveTab('approved')}
            >
              Approved ({approvedList.length})
            </button>
            <button
              id="admin-tab-rejected"
              type="button"
              role="tab"
              aria-selected={activeTab === 'rejected'}
              {...({ focusgroupstart: activeTab === 'rejected' ? '' : undefined } as Record<
                string,
                string | undefined
              >)}
              onClick={() => setActiveTab('rejected')}
            >
              Rejected ({rejectedList.length})
            </button>
            <button
              id="admin-tab-outbox"
              type="button"
              role="tab"
              aria-selected={activeTab === 'outbox'}
              {...({ focusgroupstart: activeTab === 'outbox' ? '' : undefined } as Record<
                string,
                string | undefined
              >)}
              onClick={() => setActiveTab('outbox')}
            >
              Email Outbox ({outbox.length})
            </button>
          </div>

          {(['pending', 'info_requested', 'approved', 'rejected'] as const).map((tabKey) => {
            const rows =
              tabKey === 'pending'
                ? pendingList
                : tabKey === 'info_requested'
                  ? infoRequestedList
                  : tabKey === 'approved'
                    ? approvedList
                    : rejectedList;
            return (
              <div
                key={tabKey}
                role="tabpanel"
                aria-labelledby={`admin-tab-${tabKey}`}
                hidden={activeTab !== tabKey ? ('until-found' as unknown as boolean) : false}
                tabIndex={activeTab === tabKey ? 0 : undefined}
              >
                <div className="tabpanel-inner">
                  {rows.length === 0 ? (
                    <p style={{ color: 'var(--muted)' }}>
                      No submissions in "{tabKey.replace('_', ' ')}" state right now.
                    </p>
                  ) : (
                    <div
                      tabIndex={0}
                      role="region"
                      aria-labelledby={`queue-caption-${tabKey}`}
                      className="table-wrapper"
                    >
                      <table className="mod-table">
                        <caption id={`queue-caption-${tabKey}`}>
                          {tabKey === 'pending'
                            ? 'Submissions Waiting for Admin Approval'
                            : tabKey === 'info_requested'
                              ? 'Submissions Awaiting Contributor Clarification'
                              : `${tabKey.toUpperCase()} Submissions`}
                        </caption>
                        <thead>
                          <tr>
                            <th>Bhajan</th>
                            <th>Type &amp; Status</th>
                            <th>Contributor</th>
                            <th>Reason / Source</th>
                            <th>Submitted</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((item) => (
                            <tr
                              key={item.id}
                              data-selected={selected?.id === item.id ? 'true' : undefined}
                              onClick={() => setSelectedId(item.id)}
                              style={{ cursor: 'pointer' }}
                            >
                              <th>
                                <button
                                  type="button"
                                  style={{
                                    background: 'none',
                                    border: 0,
                                    padding: 0,
                                    textAlign: 'left',
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                  }}
                                  onClick={() => setSelectedId(item.id)}
                                >
                                  {item.bhajanTitle}
                                </button>
                                <div
                                  style={{
                                    fontSize: '0.75rem',
                                    color: 'var(--muted)',
                                    fontWeight: 400,
                                  }}
                                >
                                  {item.script}
                                  {item.alternateScriptKind ? ` · ${item.alternateScriptKind}` : ''}
                                  {item.audioSubmission ? ' · 🎵 Audio attached' : ''}
                                  {item.contributorReply ? ' · 💬 Reply received' : ''}
                                </div>
                              </th>
                              <td>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                                  <span className="badge badge-type">
                                    {submissionTypeLabel(item.submissionType)}
                                  </span>
                                  <span
                                    className={`badge ${
                                      item.status === 'approved'
                                        ? 'badge-verified'
                                        : item.status === 'pending'
                                          ? 'badge-pending'
                                          : item.status === 'info_requested'
                                            ? 'badge-info-requested'
                                            : ''
                                    }`}
                                  >
                                    {item.status === 'pending' ? 'waiting_approval' : item.status}
                                  </span>
                                </div>
                              </td>
                              <td>
                                <div>{item.submitterName}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                                  {item.submitterEmail}
                                </div>
                              </td>
                              <td>{item.reasonOrSource}</td>
                              <td style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                                {new Date(item.createdAt).toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          <div
            role="tabpanel"
            aria-labelledby="admin-tab-outbox"
            hidden={activeTab !== 'outbox' ? ('until-found' as unknown as boolean) : false}
            tabIndex={activeTab === 'outbox' ? 0 : undefined}
          >
            <div className="tabpanel-inner">
              <p className="field-hint" style={{ marginBottom: '0.85rem' }}>
                Every submission and moderator follow-up email (to <strong>pschax@gmail.com</strong>{' '}
                or the contributor) is prepared for live email delivery and mirrored here in dev.
              </p>
              <div style={{ display: 'grid', gap: '1rem' }}>
                {outbox.map((mail) => (
                  <article key={mail.id} className="control-box">
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        justifyContent: 'space-between',
                        gap: '0.5rem',
                        marginBottom: '0.6rem',
                      }}
                    >
                      <div>
                        <strong>To:</strong> {mail.to} · <strong>Subject:</strong> {mail.subject}
                      </div>
                      <span className="badge">{mail.transport}</span>
                    </div>
                    <div
                      style={{
                        background: '#ffffff',
                        borderRadius: '10px',
                        padding: '0.75rem',
                        border: '1px solid var(--border)',
                        overflowX: 'auto',
                      }}
                      dangerouslySetInnerHTML={{ __html: mail.htmlBody }}
                    />
                  </article>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Selected Submission Workbench (Approve or Request Further Information) */}
        {selected && activeTab !== 'outbox' ? (
          <section className="card" aria-label="Submission Moderator Inspector">
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                gap: '0.75rem',
                marginBottom: '1rem',
              }}
            >
              <div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem', marginBottom: '0.35rem' }}>
                  <span className="badge badge-type">
                    {submissionTypeLabel(selected.submissionType)}
                  </span>
                  <span className="badge">
                    {selected.script}
                    {selected.alternateScriptKind ? ` (${selected.alternateScriptKind})` : ''}
                  </span>
                  <span
                    className={`badge ${
                      selected.status === 'approved'
                        ? 'badge-verified'
                        : selected.status === 'info_requested'
                          ? 'badge-info-requested'
                          : 'badge-pending'
                    }`}
                  >
                    {selected.status}
                  </span>
                </div>
                <h2 style={{ margin: 0 }}>{selected.bhajanTitle}</h2>
                <p style={{ margin: '0.2rem 0 0 0', fontSize: '0.85rem', color: 'var(--muted)' }}>
                  Submitted by <strong>{selected.submitterName}</strong> ({selected.submitterEmail}) ·{' '}
                  {selected.reasonOrSource}
                </p>
              </div>
              {selected.emailNotification && (
                <span className="badge">
                  Email ({selected.emailNotification.to}): {selected.emailNotification.transport}
                </span>
              )}
            </div>

            {selected.audioSubmission && (
              <div className="audio-preview-card" style={{ marginBottom: '1rem' }}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    gap: '0.5rem',
                    marginBottom: '0.45rem',
                  }}
                >
                  <strong>Attached Audio: {selected.audioSubmission.label}</strong>
                  <span className="badge">
                    {selected.audioSubmission.sourceKind === 'uploaded_file'
                      ? 'Uploaded File'
                      : 'External URL'}
                  </span>
                </div>
                <audio
                  controls
                  preload="metadata"
                  src={selected.audioSubmission.url}
                  style={{ width: '100%' }}
                />
                <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.25rem' }}>
                  <code>{selected.audioSubmission.url}</code>
                </div>
              </div>
            )}

            {metadataEntries.length > 0 && (
              <div className="control-box" style={{ marginBottom: '1rem' }}>
                <div className="control-label" style={{ marginBottom: '0.45rem' }}>
                  Proposed Metadata Values
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: '0.5rem 1rem',
                    fontSize: '0.88rem',
                  }}
                >
                  {metadataEntries.map(([label, val]) => (
                    <div key={label}>
                      <span style={{ color: 'var(--muted)' }}>{label}: </span>
                      <strong>{val}</strong>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(selected.infoRequestNote || selected.reviewNote || selected.contributorReply) && (
              <div className="control-box" style={{ marginBottom: '1rem' }}>
                <div className="control-label" style={{ marginBottom: '0.45rem' }}>
                  Moderator &amp; Contributor Discussion Thread
                </div>
                {selected.status === 'rejected' && selected.reviewNote && (
                  <div
                    style={{
                      marginBottom: selected.contributorReply ? '0.6rem' : 0,
                      padding: '0.55rem 0.75rem',
                      borderRadius: '8px',
                      background: '#FEF2F2',
                      color: '#7F1D1D',
                    }}
                  >
                    <strong>Rejection Reason:</strong>{' '}
                    <span style={{ whiteSpace: 'pre-wrap' }}>{selected.reviewNote}</span>
                  </div>
                )}
                {selected.infoRequestNote && selected.status !== 'rejected' && (
                  <div style={{ marginBottom: selected.contributorReply ? '0.6rem' : 0 }}>
                    <strong>Moderator Question:</strong>{' '}
                    <span style={{ whiteSpace: 'pre-wrap' }}>{selected.infoRequestNote}</span>
                  </div>
                )}
                {selected.contributorReply && (
                  <div
                    style={{
                      padding: '0.55rem 0.75rem',
                      borderRadius: '8px',
                      background: 'var(--success-bg)',
                      color: 'var(--success)',
                    }}
                  >
                    <strong>Contributor Reply:</strong>{' '}
                    <span style={{ whiteSpace: 'pre-wrap' }}>{selected.contributorReply}</span>
                  </div>
                )}
              </div>
            )}

            <div className="pitch-grid">
              <div>
                <div className="control-label">
                  {selected.submissionType === 'metadata_addition' &&
                  selected.proposedLyrics.length === 0
                    ? 'Existing Lyrics (Unchanged for Metadata/Audio Addition)'
                    : `Line-by-Line Diff (+${diff?.addedCount ?? 0} / −${diff?.removedCount ?? 0})`}
                </div>
                <div className="diff-box">
                  {selected.submissionType === 'metadata_addition' &&
                  editedLines.length === 0 ? (
                    selected.originalLyrics.map((line, idx) => (
                      <div key={idx} className="diff-line">
                        {'  '}
                        {line}
                      </div>
                    ))
                  ) : (
                    diff?.lines.map((d, idx) => (
                      <div
                        key={`${idx}-${d.type}`}
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
                    ))
                  )}
                </div>
              </div>

              <div>
                <div className="form-field">
                  <label htmlFor="admin-edit-lyrics">
                    Final Lyrics to Publish (editable before approving)
                  </label>
                  <textarea
                    id="admin-edit-lyrics"
                    rows={7}
                    className="textarea-control"
                    disabled={!canModerateSelected}
                    value={editedLyricsText}
                    onChange={(e) => setEditedLyricsText(e.target.value)}
                  />
                </div>

                <div className="form-field">
                  <label htmlFor="admin-review-note">
                    Moderator Note, Question, or Rejection Reason
                  </label>
                  <textarea
                    ref={reviewNoteRef}
                    id="admin-review-note"
                    rows={3}
                    className="textarea-control"
                    aria-invalid={actionError ? 'true' : 'false'}
                    aria-describedby={actionError ? 'admin-review-error' : undefined}
                    placeholder="Optional approval note, OR required reason/question when clicking Request Further Information or Reject Submission..."
                    disabled={!canModerateSelected}
                    value={reviewNote}
                    onChange={(e) => {
                      setReviewNote(e.target.value);
                      if (actionError) setActionError(null);
                    }}
                  />
                </div>

                {actionError && (
                  <p
                    id="admin-review-error"
                    role="alert"
                    style={{ color: 'var(--danger)', fontSize: '0.86rem', marginBottom: '0.7rem' }}
                  >
                    <span role="img" aria-label="Error">
                      ❌
                    </span>{' '}
                    {actionError}
                  </p>
                )}

                {canModerateSelected ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
                    <button
                      type="button"
                      className="btn btn-success"
                      disabled={actionBusy}
                      onClick={() => handleDecision('approve')}
                    >
                      Approve &amp; Publish Live
                    </button>
                    <button
                      type="button"
                      className="btn btn-warn"
                      disabled={actionBusy}
                      onClick={() => handleDecision('request_info')}
                    >
                      Request Further Information
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={actionBusy}
                      onClick={() => handleDecision('reject')}
                    >
                      Reject Submission
                    </button>
                  </div>
                ) : (
                  <p style={{ fontSize: '0.88rem', color: 'var(--muted)' }}>
                    Reviewed by <strong>{selected.reviewedBy}</strong> at{' '}
                    {selected.reviewedAt ? new Date(selected.reviewedAt).toLocaleString() : ''}.
                  </p>
                )}
              </div>
            </div>
          </section>
        ) : null}
      </main>
    </>
  );
}
