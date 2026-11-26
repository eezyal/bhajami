'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import {
  computeLyricsDiff,
  type Bhajan,
  type BhajanRevision,
  type CatalogStats,
  type IngestionRunDoc,
  type LyricCorrection,
  type OutboxEmailRecord,
  type ProposedMetadataPatch,
  type SubmissionType,
} from '@bhajami/shared';
import { getCurrentFirebaseIdToken, getFirebaseClientAuth } from '@/lib/firebase-client';
import { ThemeToggle } from './ThemeToggle';
import { YouTubeSegmentPlayer } from './YouTubeSegmentPlayer';

const ADMIN_EMAIL = (process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'pschax@gmail.com').trim().toLowerCase();

type AdminTab =
  | 'pending'
  | 'info_requested'
  | 'approved'
  | 'rejected'
  | 'outbox'
  | 'daily_curation'
  | 'pipeline_health';

type CurationQueueView = 'missing_lyrics' | 'needs_verification' | 'ambiguous_long';

interface AdminModerationClientProps {
  initialCorrections: LyricCorrection[];
  initialOutbox: OutboxEmailRecord[];
  initialRevisions: BhajanRevision[];
  initialSelectedId?: string;
  cloudMode?: boolean;
  catalogVersion?: number;
  catalogStats?: CatalogStats;
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
  cloudMode = false,
  catalogVersion,
  catalogStats,
}: AdminModerationClientProps) {
  const [corrections, setCorrections] = useState(initialCorrections);
  const [outbox, setOutbox] = useState(initialOutbox);
  const [revisions, setRevisions] = useState(initialRevisions);
  const [activeTab, setActiveTab] = useState<AdminTab>('pending');
  const [authResolved, setAuthResolved] = useState(!cloudMode);
  const [isAuthorizedAdmin, setIsAuthorizedAdmin] = useState(!cloudMode);

  const [selectedId, setSelectedId] = useState<string>(
    initialSelectedId ||
      initialCorrections.find((c) => c.status === 'pending')?.id ||
      initialCorrections.find((c) => c.status === 'info_requested')?.id ||
      initialCorrections[0]?.id ||
      '',
  );
  const [editedLyricsText, setEditedLyricsText] = useState('');
  const [editedMetadata, setEditedMetadata] = useState<ProposedMetadataPatch>({});
  const [reviewNote, setReviewNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [adminEmail, setAdminEmail] = useState<string | null>(null);
  const reviewNoteRef = useRef<HTMLTextAreaElement>(null);

  // Daily Curation & Pipeline Health state
  const [curationView, setCurationView] = useState<CurationQueueView>('missing_lyrics');
  const [curationItems, setCurationItems] = useState<Bhajan[]>([]);
  const [selectedCurationId, setSelectedCurationId] = useState('');
  const [curationLoading, setCurationLoading] = useState(false);
  const [curationError, setCurationError] = useState<string | null>(null);
  const [curatedLyricsText, setCuratedLyricsText] = useState('');
  const [curatedScript, setCuratedScript] = useState('Sanskrit / Hindi (Roman)');
  const [curatedMeta, setCuratedMeta] = useState<ProposedMetadataPatch>({});
  const [dismissReason, setDismissReason] = useState('');
  const [pipelineRuns, setPipelineRuns] = useState<IngestionRunDoc[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

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
      const m = selected.proposedMetadata;
      setEditedMetadata({
        title: m?.title || '',
        deity: m?.deity || '',
        language: m?.language || '',
        ragaName: m?.ragaName || m?.raga || '',
        arohanam: m?.arohanam || '',
        avarohanam: m?.avarohanam || '',
        gentsPitchRaw: m?.gentsPitchRaw || '',
        ladiesPitchRaw: m?.ladiesPitchRaw || '',
        beat: m?.beat || m?.tala || '',
        tempo: m?.tempo !== undefined ? String(m.tempo) : '',
        firstLineSargam: m?.firstLineSargam || '',
        firstLineWestern: m?.firstLineWestern || '',
        notesRange: m?.notesRange || '',
        sheetMusicUrl: m?.sheetMusicUrl || '',
        meaning: m?.meaning || '',
      });
      setReviewNote(selected.infoRequestNote || selected.reviewNote || '');
      setActionError(null);
    }
  }, [selected]);

  const loadCurationData = useCallback(
    async (view: CurationQueueView | 'runs', explicitToken?: string | null) => {
      if (view === 'runs') setRunsLoading(true);
      else setCurationLoading(true);
      setCurationError(null);
      try {
        const token =
          explicitToken !== undefined ? explicitToken : await getCurrentFirebaseIdToken();
        const res = await fetch(`/api/admin/curation?view=${encodeURIComponent(view)}&limit=25`, {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        const data = await res.json();
        if (!res.ok) {
          setCurationError(data.error || 'Failed loading curation queue.');
        } else if (view === 'runs') {
          setPipelineRuns(data.runs || []);
        } else {
          const items: Bhajan[] = data.items || [];
          setCurationItems(items);
          setSelectedCurationId((prev) =>
            items.some((b) => b.id === prev) ? prev : items[0]?.id || '',
          );
        }
      } catch (err) {
        setCurationError(err instanceof Error ? err.message : 'Network error loading curation.');
      } finally {
        if (view === 'runs') setRunsLoading(false);
        else setCurationLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (cloudMode && !isAuthorizedAdmin) return;
    if (activeTab === 'daily_curation') {
      void loadCurationData(curationView);
    } else if (activeTab === 'pipeline_health') {
      void loadCurationData('runs');
    }
  }, [activeTab, cloudMode, curationView, isAuthorizedAdmin, loadCurationData]);

  const selectedCurationItem = useMemo(
    () =>
      curationItems.find((b) => b.id === selectedCurationId) ||
      curationItems[0] ||
      null,
    [curationItems, selectedCurationId],
  );

  useEffect(() => {
    if (selectedCurationItem) {
      setCuratedLyricsText(selectedCurationItem.lyricsSets[0]?.lines.join('\n') || '');
      setCuratedScript(selectedCurationItem.lyricsSets[0]?.language || 'Sanskrit / Hindi (Roman)');
      setCuratedMeta({
        deity: selectedCurationItem.deity || '',
        ragaName: selectedCurationItem.raga?.name || '',
        arohanam: selectedCurationItem.raga?.arohanam || '',
        avarohanam: selectedCurationItem.raga?.avarohanam || '',
        beat: selectedCurationItem.beat || '',
        tempo: selectedCurationItem.tempo || '',
        gentsPitchRaw: selectedCurationItem.gentsPitchRaw || selectedCurationItem.gentsPitch?.raw || '',
        ladiesPitchRaw: selectedCurationItem.ladiesPitchRaw || selectedCurationItem.ladiesPitch?.raw || '',
        firstLineSargam: selectedCurationItem.firstLineNotes?.sargam || '',
        meaning: selectedCurationItem.meaning || '',
      });
      setDismissReason('');
    }
  }, [selectedCurationItem]);

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
    if (!fb) {
      setAuthResolved(true);
      if (cloudMode) setIsAuthorizedAdmin(false);
      return;
    }
    return onAuthStateChanged(fb.auth, async (u) => {
      const tokenResult = u ? await u.getIdTokenResult().catch(() => null) : null;
      const normalizedEmail = (u?.email || '').trim().toLowerCase();
      const authorized = Boolean(
        u &&
          !u.isAnonymous &&
          (tokenResult?.claims?.admin === true ||
            (normalizedEmail === ADMIN_EMAIL && u.emailVerified)),
      );
      setAdminEmail(u?.email ?? null);
      setIsAuthorizedAdmin(authorized || !cloudMode);
      setAuthResolved(true);

      if (u && (authorized || !cloudMode)) {
        try {
          const tok = await u.getIdToken();
          await reloadAll(tok);
        } catch {
          // Keep current state if token fetch fails
        }
      } else if (cloudMode) {
        setCorrections([]);
        setOutbox([]);
        setRevisions([]);
        setCurationItems([]);
        setPipelineRuns([]);
      }
    });
  }, [cloudMode]);

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
      const compactMeta: ProposedMetadataPatch = {};
      if (action === 'approve') {
        for (const [key, val] of Object.entries(editedMetadata)) {
          if (typeof val === 'string' && val.trim()) {
            (compactMeta as Record<string, string>)[key] = val.trim();
          }
        }
      }

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
          editedMetadata:
            action === 'approve' && Object.keys(compactMeta).length > 0 ? compactMeta : undefined,
          reviewerEmail: adminEmail || ADMIN_EMAIL,
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
          ? `Approved & published ${submissionTypeLabel(selected.submissionType)} for "${selected.bhajanTitle}". Live catalog updated immediately!`
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

  const handleCurationAction = async (body: Record<string, unknown>, successMsg: string) => {
    setActionBusy(true);
    setCurationError(null);
    setBanner(null);
    try {
      const token = await getCurrentFirebaseIdToken();
      const res = await fetch('/api/admin/curation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setCurationError(json.error || 'Curation action failed.');
        setActionBusy(false);
        return;
      }
      await loadCurationData(curationView, token);
      setBanner(successMsg);
    } catch (err) {
      setCurationError(err instanceof Error ? err.message : 'Network error during curation action.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'focusGroup')) {
      return;
    }
    const order: AdminTab[] = [
      'pending',
      'info_requested',
      'approved',
      'rejected',
      'outbox',
      'daily_curation',
      'pipeline_health',
    ];
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
                Community Contributions Queue · Admin Notifications to {ADMIN_EMAIL}
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
                {isAuthorizedAdmin ? `Admin: ${adminEmail}` : `Signed in: ${adminEmail}`} (Sign out)
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
              Back to bhaJami
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="portal-shell">
        {cloudMode && !isAuthorizedAdmin ? (
          <section className="card" style={{ maxWidth: '640px', marginInline: 'auto' }}>
            {!authResolved ? (
              <p className="field-hint" style={{ margin: 0 }}>
                Checking admin session…
              </p>
            ) : !adminEmail ? (
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Admin Sign-In Required</h1>
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.92rem' }}>
                  Moderation and catalog curation are restricted to the verified admin account (
                  <strong>{ADMIN_EMAIL}</strong>).
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
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
                    Sign in with Google
                  </button>
                  <Link href="/" className="btn">
                    Back to bhaJami
                  </Link>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Admin Access Restricted</h1>
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.92rem' }}>
                  Signed in as <strong>{adminEmail}</strong>. Only verified{' '}
                  <strong>{ADMIN_EMAIL}</strong> has admin privileges to view or moderate queues.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={async () => {
                      const fb = getFirebaseClientAuth();
                      if (fb) await signOut(fb.auth);
                    }}
                  >
                    Sign Out &amp; Switch Account
                  </button>
                  <Link href="/" className="btn">
                    Back to bhaJami
                  </Link>
                </div>
              </div>
            )}
          </section>
        ) : (
          <>
        {catalogStats && (
          <div className="stats-strip" aria-label="Admin Catalog Source Overview">
            {catalogVersion !== undefined && (
              <span className="badge">Catalog v{catalogVersion}</span>
            )}
            <span className="badge">Total Bhajans: {catalogStats.totalBhajans}</span>
            <span className="badge badge-verified">
              Sai Rhythms Enriched: {catalogStats.verifiedSaiRhythmsCount}
            </span>
            <span className="badge">
              BhajanDownloader (SSS Media): {catalogStats.bhajanDownloaderCount} MP3s
            </span>
            <span className="badge">RaviMp3 Archive: {catalogStats.raviMp3Count} MP3s</span>
            {(catalogStats.youtubeVideosCount ?? 0) > 0 && (
              <span className="badge">YouTube Videos: {catalogStats.youtubeVideosCount}</span>
            )}
          </div>
        )}
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
            <button
              id="admin-tab-daily_curation"
              type="button"
              role="tab"
              aria-selected={activeTab === 'daily_curation'}
              {...({ focusgroupstart: activeTab === 'daily_curation' ? '' : undefined } as Record<
                string,
                string | undefined
              >)}
              onClick={() => setActiveTab('daily_curation')}
            >
              Daily Curation
            </button>
            <button
              id="admin-tab-pipeline_health"
              type="button"
              role="tab"
              aria-selected={activeTab === 'pipeline_health'}
              {...({ focusgroupstart: activeTab === 'pipeline_health' ? '' : undefined } as Record<
                string,
                string | undefined
              >)}
              onClick={() => setActiveTab('pipeline_health')}
            >
              Pipeline Health
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
                Every submission and moderator follow-up email (to <strong>{ADMIN_EMAIL}</strong>{' '}
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

          {/* Daily Curation Workbench */}
          <div
            role="tabpanel"
            aria-labelledby="admin-tab-daily_curation"
            hidden={activeTab !== 'daily_curation' ? ('until-found' as unknown as boolean) : false}
            tabIndex={activeTab === 'daily_curation' ? 0 : undefined}
          >
            <div className="tabpanel-inner">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
                {(
                  [
                    ['missing_lyrics', 'Missing Lyrics'],
                    ['needs_verification', 'Needs Verification (Doubt)'],
                    ['ambiguous_long', 'Ambiguous >6.5m'],
                  ] as const
                ).map(([vKey, vLabel]) => (
                  <button
                    key={vKey}
                    type="button"
                    className={`btn btn-sm ${curationView === vKey ? 'btn-primary' : ''}`}
                    onClick={() => setCurationView(vKey)}
                  >
                    {vLabel}
                  </button>
                ))}
              </div>

              {curationError && (
                <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.88rem' }}>
                  {curationError}
                </p>
              )}

              {curationLoading ? (
                <p className="field-hint">Loading curation queue…</p>
              ) : curationItems.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>
                  No items waiting in &quot;{curationView.replace('_', ' ')}&quot;.
                </p>
              ) : (
                <>
                  <div className="table-wrapper" style={{ marginBottom: '1rem' }}>
                    <table className="mod-table">
                      <thead>
                        <tr>
                          <th>Title</th>
                          <th>Status</th>
                          <th>Missing Fields</th>
                          <th>Recordings</th>
                        </tr>
                      </thead>
                      <tbody>
                        {curationItems.map((item) => (
                          <tr
                            key={item.id}
                            data-selected={selectedCurationItem?.id === item.id ? 'true' : undefined}
                            onClick={() => setSelectedCurationId(item.id)}
                            style={{ cursor: 'pointer' }}
                          >
                            <th>
                              <strong>{item.title}</strong>
                              <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                                <code>{item.id}</code>
                              </div>
                            </th>
                            <td>
                              <span className="badge badge-pending">
                                {item.matchStatus || (item.lyricsMissing ? 'missing_lyrics' : 'open')}
                              </span>
                            </td>
                            <td style={{ fontSize: '0.8rem' }}>
                              {(item.missingFields || []).join(', ') || 'none'}
                            </td>
                            <td>{item.recordings.length}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {selectedCurationItem && (
                    <div className="control-box">
                      <h3 style={{ marginTop: 0 }}>{selectedCurationItem.title}</h3>
                      {selectedCurationItem.recordings.find((r) => r.youtubeVideoId) ? (
                        (() => {
                          const ytRec = selectedCurationItem.recordings.find(
                            (r) => r.youtubeVideoId,
                          )!;
                          return (
                            <div style={{ marginBottom: '1rem' }}>
                              <YouTubeSegmentPlayer
                                videoId={ytRec.youtubeVideoId!}
                                title={ytRec.label}
                                startSec={ytRec.startSec}
                                endSec={ytRec.endSec}
                                embeddable={ytRec.embeddable}
                              />
                            </div>
                          );
                        })()
                      ) : selectedCurationItem.recordings[0]?.externalUrl ? (
                        <audio
                          controls
                          preload="metadata"
                          src={selectedCurationItem.recordings[0].externalUrl}
                          style={{ width: '100%', marginBottom: '1rem' }}
                        />
                      ) : null}

                      {(selectedCurationItem.matchCandidates?.length ?? 0) > 0 && (
                        <div style={{ marginBottom: '1rem' }}>
                          <div className="control-label">Candidate Matches (Doubt Resolution)</div>
                          <div style={{ display: 'grid', gap: '0.5rem' }}>
                            {selectedCurationItem.matchCandidates!.map((cand) => (
                              <div
                                key={cand.targetBhajanId}
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  gap: '0.5rem',
                                  padding: '0.55rem 0.75rem',
                                  border: '1px solid var(--border)',
                                  borderRadius: '8px',
                                  background: 'var(--surface)',
                                }}
                              >
                                <div>
                                  <strong>{cand.targetTitle}</strong> (
                                  {(cand.score * 100).toFixed(1)}% · {cand.reason})
                                </div>
                                <div style={{ display: 'flex', gap: '0.4rem' }}>
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-success"
                                    disabled={actionBusy}
                                    onClick={() =>
                                      handleCurationAction(
                                        {
                                          action: 'approve_merge',
                                          sourceBhajanId: selectedCurationItem.id,
                                          targetBhajanId: cand.targetBhajanId,
                                          videoId:
                                            selectedCurationItem.recordings[0]?.youtubeVideoId,
                                          saveAliasTitle: selectedCurationItem.title,
                                        },
                                        `Merged "${selectedCurationItem.title}" into "${cand.targetTitle}" and saved alias.`,
                                      )
                                    }
                                  >
                                    Approve Merge &amp; Save Alias
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    disabled={actionBusy}
                                    onClick={() =>
                                      handleCurationAction(
                                        {
                                          action: 'keep_distinct',
                                          sourceBhajanId: selectedCurationItem.id,
                                          candidateBhajanId: cand.targetBhajanId,
                                        },
                                        `Recorded "${selectedCurationItem.title}" != "${cand.targetTitle}" in doNotMergePairs.`,
                                      )
                                    }
                                  >
                                    Keep Distinct
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="pitch-grid" style={{ marginBottom: '0.75rem' }}>
                        <div className="form-field">
                          <label htmlFor="curate-deity">Deity</label>
                          <input
                            id="curate-deity"
                            type="text"
                            className="input-control"
                            value={curatedMeta.deity || ''}
                            onChange={(e) =>
                              setCuratedMeta((m) => ({ ...m, deity: e.target.value }))
                            }
                          />
                        </div>
                        <div className="form-field">
                          <label htmlFor="curate-raga">Raga</label>
                          <input
                            id="curate-raga"
                            type="text"
                            className="input-control"
                            value={curatedMeta.ragaName || ''}
                            onChange={(e) =>
                              setCuratedMeta((m) => ({ ...m, ragaName: e.target.value }))
                            }
                          />
                        </div>
                        <div className="form-field">
                          <label htmlFor="curate-beat">Beat / Tala</label>
                          <input
                            id="curate-beat"
                            type="text"
                            className="input-control"
                            value={curatedMeta.beat || ''}
                            onChange={(e) =>
                              setCuratedMeta((m) => ({ ...m, beat: e.target.value }))
                            }
                          />
                        </div>
                        <div className="form-field">
                          <label htmlFor="curate-gents">Gents Pitch</label>
                          <input
                            id="curate-gents"
                            type="text"
                            className="input-control"
                            value={curatedMeta.gentsPitchRaw || ''}
                            onChange={(e) =>
                              setCuratedMeta((m) => ({ ...m, gentsPitchRaw: e.target.value }))
                            }
                          />
                        </div>
                        <div className="form-field">
                          <label htmlFor="curate-ladies">Ladies Pitch</label>
                          <input
                            id="curate-ladies"
                            type="text"
                            className="input-control"
                            value={curatedMeta.ladiesPitchRaw || ''}
                            onChange={(e) =>
                              setCuratedMeta((m) => ({ ...m, ladiesPitchRaw: e.target.value }))
                            }
                          />
                        </div>
                        <div className="form-field">
                          <label htmlFor="curate-arohanam">Arohanam</label>
                          <input
                            id="curate-arohanam"
                            type="text"
                            className="input-control"
                            value={curatedMeta.arohanam || ''}
                            onChange={(e) =>
                              setCuratedMeta((m) => ({ ...m, arohanam: e.target.value }))
                            }
                          />
                        </div>
                      </div>

                      <div className="form-field">
                        <label htmlFor="curate-lyrics">Curated Lyrics (one verse per line)</label>
                        <textarea
                          id="curate-lyrics"
                          rows={5}
                          className="textarea-control"
                          value={curatedLyricsText}
                          onChange={(e) => setCuratedLyricsText(e.target.value)}
                        />
                      </div>

                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', alignItems: 'center' }}>
                        <button
                          type="button"
                          className="btn btn-success"
                          disabled={actionBusy}
                          onClick={() =>
                            handleCurationAction(
                              {
                                action: 'publish_curated',
                                bhajanId: selectedCurationItem.id,
                                lyricsText: curatedLyricsText,
                                script: curatedScript,
                                metadata: curatedMeta,
                              },
                              `Published curated lyrics & metadata for "${selectedCurationItem.title}".`,
                            )
                          }
                        >
                          Publish Curated Lyrics &amp; Metadata
                        </button>
                        <input
                          type="text"
                          aria-label="Reason for excluding non-bhajan"
                          placeholder="Reason if non-bhajan discourse/promo..."
                          className="input-control"
                          style={{ maxWidth: '280px' }}
                          value={dismissReason}
                          onChange={(e) => setDismissReason(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-danger"
                          disabled={actionBusy || !dismissReason.trim()}
                          onClick={() =>
                            handleCurationAction(
                              {
                                action: 'exclude_non_bhajan',
                                bhajanId: selectedCurationItem.id,
                                videoId: selectedCurationItem.recordings[0]?.youtubeVideoId,
                                reason: dismissReason.trim(),
                              },
                              `Dismissed "${selectedCurationItem.title}" as non-bhajan.`,
                            )
                          }
                        >
                          Dismiss Non-Bhajan
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Pipeline Health */}
          <div
            role="tabpanel"
            aria-labelledby="admin-tab-pipeline_health"
            hidden={activeTab !== 'pipeline_health' ? ('until-found' as unknown as boolean) : false}
            tabIndex={activeTab === 'pipeline_health' ? 0 : undefined}
          >
            <div className="tabpanel-inner">
              {runsLoading ? (
                <p className="field-hint">Loading ingestion runs…</p>
              ) : pipelineRuns.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>
                  No `ingestionRuns` recorded yet. Runs appear automatically after GitHub Actions or CLI syncs publish to Firestore.
                </p>
              ) : (
                <div className="table-wrapper">
                  <table className="mod-table">
                    <thead>
                      <tr>
                        <th>Run ID</th>
                        <th>Source</th>
                        <th>Status</th>
                        <th>Scanned / Auto / Doubt / New</th>
                        <th>YouTube Quota / Writes</th>
                        <th>Started At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pipelineRuns.map((run) => (
                        <tr key={run.runId}>
                          <th>
                            <code>{run.runId}</code>
                          </th>
                          <td>{run.source}</td>
                          <td>
                            <span
                              className={`badge ${
                                run.status === 'success'
                                  ? 'badge-verified'
                                  : run.status === 'partial'
                                    ? 'badge-pending'
                                    : ''
                              }`}
                            >
                              {run.status}
                            </span>
                          </td>
                          <td>
                            {run.itemsScanned} / {run.matchedAuto} / {run.queuedDoubt} /{' '}
                            {run.createdNew}
                          </td>
                          <td>
                            {run.youtubeQuotaUnitsUsed} units / {run.firestoreWrites} writes
                          </td>
                          <td style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                            {run.startedAt}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Selected Submission Workbench (Approve or Request Further Information) */}
        {selected &&
        (activeTab === 'pending' ||
          activeTab === 'info_requested' ||
          activeTab === 'approved' ||
          activeTab === 'rejected') ? (
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

                {canModerateSelected && (
                  <div className="control-box" style={{ marginBottom: '0.85rem' }}>
                    <div className="control-label" style={{ marginBottom: '0.4rem' }}>
                      Edit Metadata &amp; Notation Before Approving
                    </div>
                    <div className="pitch-grid">
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label htmlFor="admin-meta-raga">Raga</label>
                        <input
                          id="admin-meta-raga"
                          type="text"
                          className="input-control"
                          value={editedMetadata.ragaName || ''}
                          onChange={(e) =>
                            setEditedMetadata((m) => ({ ...m, ragaName: e.target.value }))
                          }
                        />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label htmlFor="admin-meta-arohanam">Arohanam</label>
                        <input
                          id="admin-meta-arohanam"
                          type="text"
                          className="input-control"
                          value={editedMetadata.arohanam || ''}
                          onChange={(e) =>
                            setEditedMetadata((m) => ({ ...m, arohanam: e.target.value }))
                          }
                        />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label htmlFor="admin-meta-avarohanam">Avarohanam</label>
                        <input
                          id="admin-meta-avarohanam"
                          type="text"
                          className="input-control"
                          value={editedMetadata.avarohanam || ''}
                          onChange={(e) =>
                            setEditedMetadata((m) => ({ ...m, avarohanam: e.target.value }))
                          }
                        />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label htmlFor="admin-meta-sargam">First Line Sargam</label>
                        <input
                          id="admin-meta-sargam"
                          type="text"
                          className="input-control"
                          value={editedMetadata.firstLineSargam || ''}
                          onChange={(e) =>
                            setEditedMetadata((m) => ({ ...m, firstLineSargam: e.target.value }))
                          }
                        />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label htmlFor="admin-meta-gents">Gents Pitch</label>
                        <input
                          id="admin-meta-gents"
                          type="text"
                          className="input-control"
                          value={editedMetadata.gentsPitchRaw || ''}
                          onChange={(e) =>
                            setEditedMetadata((m) => ({ ...m, gentsPitchRaw: e.target.value }))
                          }
                        />
                      </div>
                      <div className="form-field" style={{ marginBottom: 0 }}>
                        <label htmlFor="admin-meta-ladies">Ladies Pitch</label>
                        <input
                          id="admin-meta-ladies"
                          type="text"
                          className="input-control"
                          value={editedMetadata.ladiesPitchRaw || ''}
                          onChange={(e) =>
                            setEditedMetadata((m) => ({ ...m, ladiesPitchRaw: e.target.value }))
                          }
                        />
                      </div>
                    </div>
                  </div>
                )}

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
          </>
        )}
      </main>
    </>
  );
}
