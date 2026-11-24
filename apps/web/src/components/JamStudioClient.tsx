'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import {
  transposePitch,
  type Bhajan,
  type CatalogIndexPayload,
  type CatalogStats,
  type LyricCorrection,
  type SubmissionType,
} from '@bhajami/shared';
import {
  getCurrentFirebaseIdToken,
  getFirebaseClientAuth,
  getFirebaseClientFirestore,
} from '@/lib/firebase-client';
import {
  getCachedBhajan,
  getCachedCatalogIndex,
  setCachedBhajan,
  setCachedCatalogIndex,
} from '@/lib/index-cache';
import { ThemeToggle } from './ThemeToggle';
import { AuthDialog, type SessionUser } from './AuthDialog';
import { SuggestCorrectionDialog } from './SuggestCorrectionDialog';

interface JamStudioClientProps {
  initialIndex: CatalogIndexPayload;
  initialBhajan: Bhajan | null;
  initialPendingCount: number;
  cloudMode?: boolean;
}

const DEITY_FILTERS = [
  'All',
  'Ganesha',
  'Guru',
  'Devi',
  'Shiva',
  'Rama',
  'Krishna',
  'Hanuman',
  'Sai',
  'Sarva Dharma',
] as const;

type StudioTabId = 'lyrics' | 'notation' | 'glossary' | 'meaning';

export function JamStudioClient({
  initialIndex,
  initialBhajan,
  initialPendingCount,
  cloudMode = false,
}: JamStudioClientProps) {
  const [catalogIndex, setCatalogIndex] = useState<CatalogIndexPayload>(initialIndex);
  const [bhajanCache, setBhajanCache] = useState<Record<string, Bhajan>>(() =>
    initialBhajan ? { [initialBhajan.id]: initialBhajan } : {},
  );
  const [pendingCount, setPendingCount] = useState(initialPendingCount);
  const [query, setQuery] = useState('');
  const [deityFilter, setDeityFilter] = useState<string>('All');
  const [onlyVerified, setOnlyVerified] = useState(false);

  const [selectedId, setSelectedId] = useState<string>(
    initialBhajan?.id || initialIndex.entries[0]?.id || '',
  );
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeScriptIdx, setActiveScriptIdx] = useState(0);
  const [activeLineIdx, setActiveLineIdx] = useState(0);
  const [activeTab, setActiveTab] = useState<StudioTabId>('lyrics');

  // Pitch & Shruti state
  const [voiceProfile, setVoiceProfile] = useState<'gents' | 'ladies'>('gents');
  const [semitoneShift, setSemitoneShift] = useState(0);
  const [pitchFormat, setPitchFormat] = useState<'both' | 'pancham' | 'western'>('both');
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [selectedRecordingIdx, setSelectedRecordingIdx] = useState(0);

  // 4-stem practice mixer state
  const [stems, setStems] = useState({
    vocals: 90,
    harmonium: 75,
    tabla: 80,
    tanpura: 60,
  });

  // Web Audio Sa-Pa-Sa Tanpura Shruti drone
  const [shrutiOn, setShrutiOn] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const droneGainRef = useRef<GainNode | null>(null);
  const droneOscsRef = useRef<OscillatorNode[]>([]);
  const mediaAudioRef = useRef<HTMLAudioElement>(null);

  // Modals & Projector
  const [authOpen, setAuthOpen] = useState(false);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionMode, setCorrectionMode] = useState<SubmissionType>('lyric_correction');
  const [respondToCorrection, setRespondToCorrection] = useState<LyricCorrection | null>(null);
  const [projectorOpen, setProjectorOpen] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);

  // Persist Firebase client authentication across reloads
  useEffect(() => {
    const fb = getFirebaseClientAuth();
    if (!fb) return;
    const unsub = onAuthStateChanged(fb.auth, (fbUser) => {
      if (fbUser && !fbUser.isAnonymous) {
        setUser({
          name: fbUser.displayName || fbUser.email?.split('@')[0] || 'Sai Devotee',
          email: fbUser.email || '',
          uid: fbUser.uid,
          provider: fbUser.providerData.some((p) => p.providerId === 'google.com')
            ? 'google'
            : 'email',
        });
      } else if (fbUser === null && cloudMode) {
        setUser(null);
      }
    });
    return () => unsub();
  }, [cloudMode]);

  // Open ?respondTo=<correctionId> flow with verified Bearer token
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const respondToId = params.get('respondTo')?.trim();
    if (!respondToId) return;

    let cancelled = false;
    (async () => {
      try {
        const token = await getCurrentFirebaseIdToken();
        const res = await fetch(`/api/corrections/${encodeURIComponent(respondToId)}`, {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (cancelled) return;
        if (res.status === 401 && cloudMode && !token) {
          setAuthOpen(true);
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as { correction?: LyricCorrection };
        if (!cancelled && data?.correction) {
          setRespondToCorrection(data.correction);
          setCorrectionOpen(true);
        }
      } catch {
        // Ignore if submission cannot be loaded
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cloudMode, user?.uid]);

  const fetchAndCacheBhajanDetail = useCallback(async (id: string, signal?: AbortSignal) => {
    if (!id) return null;
    try {
      const res = await fetch(`/api/bhajans/${encodeURIComponent(id)}`, {
        cache: 'no-store',
        signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { bhajan?: Bhajan };
      if (!json.bhajan) return null;
      setBhajanCache((prev) => ({
        ...prev,
        [id]: json.bhajan!,
        [json.bhajan!.id]: json.bhajan!,
      }));
      void setCachedBhajan(json.bhajan);
      return json.bhajan;
    } catch {
      return null;
    }
  }, []);

  const refreshCatalog = useCallback(async () => {
    try {
      const res = await fetch('/api/bhajans', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as CatalogIndexPayload & {
        pendingCorrectionsCount?: number;
      };
      const nextPayload: CatalogIndexPayload = {
        generatedAt: data.generatedAt,
        version: data.version,
        stats: data.stats as CatalogStats,
        entries: data.entries,
      };
      setCatalogIndex(nextPayload);
      void setCachedCatalogIndex(nextPayload);
      if (typeof data.pendingCorrectionsCount === 'number') {
        setPendingCount(data.pendingCorrectionsCount);
      }
      if (selectedId) {
        void fetchAndCacheBhajanDetail(selectedId);
      }
    } catch {
      // Keep current catalog snapshot on offline/network errors
    }
  }, [fetchAndCacheBhajanDetail, selectedId]);

  // Boot & check IndexedDB `bhajami_cache_v1` against Firestore `catalogMeta/latest`
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (initialBhajan) {
        void setCachedBhajan(initialBhajan);
      }
      const cached = await getCachedCatalogIndex();
      let currentVersion = initialIndex.version;
      if (!cancelled && cached && cached.version > initialIndex.version) {
        setCatalogIndex(cached);
        currentVersion = cached.version;
      } else {
        void setCachedCatalogIndex(initialIndex);
      }

      const db = getFirebaseClientFirestore();
      if (!db) return;
      try {
        const snap = await getDoc(doc(db, 'catalogMeta', 'latest'));
        if (!cancelled && snap.exists()) {
          const remoteVersion = Number(snap.data()?.version ?? 0);
          if (remoteVersion > currentVersion) {
            await refreshCatalog();
          }
        }
      } catch {
        // Offline or catalogMeta not yet seeded
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialBhajan, initialIndex, refreshCatalog]);

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalogIndex.entries.filter((b) => {
      if (onlyVerified && b.metadataSource !== 'sairhythms_verified') return false;
      if (
        deityFilter !== 'All' &&
        !(b.deity || '').toLowerCase().includes(deityFilter.toLowerCase())
      ) {
        return false;
      }
      if (!q) return true;
      return (
        b.title.toLowerCase().includes(q) ||
        (b.ragaName || '').toLowerCase().includes(q) ||
        (b.deity || '').toLowerCase().includes(q) ||
        b.searchText.toLowerCase().includes(q)
      );
    });
  }, [catalogIndex.entries, deityFilter, onlyVerified, query]);

  const activeEntry = useMemo(
    () =>
      catalogIndex.entries.find((b) => b.id === selectedId) ||
      filteredEntries[0] ||
      catalogIndex.entries[0],
    [catalogIndex.entries, filteredEntries, selectedId],
  );

  const targetId = activeEntry?.id || '';
  const activeBhajan: Bhajan | undefined = targetId ? bhajanCache[targetId] : undefined;

  useEffect(() => {
    if (!targetId || bhajanCache[targetId]) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoadingDetail(true);

    (async () => {
      const fromDb = await getCachedBhajan(targetId);
      if (!cancelled && fromDb) {
        setBhajanCache((prev) => ({ ...prev, [targetId]: fromDb }));
        setLoadingDetail(false);
        return;
      }
      await fetchAndCacheBhajanDetail(targetId, controller.signal);
      if (!cancelled) {
        setLoadingDetail(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [bhajanCache, fetchAndCacheBhajanDetail, targetId]);

  useEffect(() => {
    setActiveScriptIdx(0);
    setActiveLineIdx(0);
    setSelectedRecordingIdx(0);
    setSemitoneShift(0);
  }, [activeBhajan?.id]);

  const basePitch =
    voiceProfile === 'gents'
      ? activeBhajan?.gentsPitch
      : activeBhajan?.ladiesPitch;

  const targetPitch = useMemo(
    () => transposePitch(basePitch?.semitoneFromC ?? 2, semitoneShift),
    [basePitch?.semitoneFromC, semitoneShift],
  );

  // Sync HTML5 audio playback rate
  useEffect(() => {
    if (mediaAudioRef.current) {
      mediaAudioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, selectedRecordingIdx, activeBhajan?.id]);

  // Manage live Web Audio Sa-Pa-Sa Tanpura drone frequency and gain
  useEffect(() => {
    if (!shrutiOn) {
      for (const osc of droneOscsRef.current) {
        try {
          osc.stop();
          osc.disconnect();
        } catch {
          // ignore
        }
      }
      droneOscsRef.current = [];
      return;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioCtx();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    const masterGain = ctx.createGain();
    masterGain.gain.value = (stems.tanpura / 100) * 0.14;
    masterGain.connect(ctx.destination);
    droneGainRef.current = masterGain;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 920;
    filter.connect(masterGain);

    // Sa (lower + tonic), Pa (fifth 1.5x), upper Sa (2x)
    const freqs = [
      targetPitch.freqHz,
      targetPitch.freqHz * 1.5,
      targetPitch.freqHz * 2,
    ];
    const oscs = freqs.map((f, idx) => {
      const osc = ctx.createOscillator();
      osc.type = idx === 1 ? 'triangle' : 'sawtooth';
      osc.frequency.setValueAtTime(f, ctx.currentTime);
      const voiceGain = ctx.createGain();
      voiceGain.gain.value = idx === 0 ? 0.45 : idx === 1 ? 0.3 : 0.25;
      osc.connect(voiceGain);
      voiceGain.connect(filter);
      osc.start();
      return osc;
    });
    droneOscsRef.current = oscs;

    return () => {
      for (const osc of oscs) {
        try {
          osc.stop();
          osc.disconnect();
        } catch {
          // ignore
        }
      }
      filter.disconnect();
      masterGain.disconnect();
    };
  }, [shrutiOn, targetPitch.freqHz]);

  useEffect(() => {
    if (droneGainRef.current && audioCtxRef.current) {
      droneGainRef.current.gain.setTargetAtTime(
        (stems.tanpura / 100) * 0.14,
        audioCtxRef.current.currentTime,
        0.04,
      );
    }
  }, [stems.tanpura]);

  const activeRecording =
    activeBhajan?.recordings[selectedRecordingIdx] || activeBhajan?.recordings[0];

  const activeAudioUrl = activeRecording
    ? activeRecording.localPath
      ? `/api/local-audio?id=${encodeURIComponent(activeRecording.id)}&bhajanId=${encodeURIComponent(activeBhajan?.id || '')}`
      : activeRecording.externalUrl || ''
    : '';

  const activeLyricsSet =
    activeBhajan?.lyricsSets[activeScriptIdx] || activeBhajan?.lyricsSets[0];

  const formatPitchText = (pancham: string, western: string) => {
    if (pitchFormat === 'pancham') return pancham;
    if (pitchFormat === 'western') return western;
    return `${pancham} / ${western}`;
  };

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'focusGroup')) {
      return;
    }
    const order: StudioTabId[] = ['lyrics', 'notation', 'glossary', 'meaning'];
    const idx = order.indexOf(activeTab);
    if (e.key === 'ArrowRight') {
      const next = order[(idx + 1) % order.length];
      setActiveTab(next);
      document.getElementById(`studio-tab-${next}`)?.focus();
    } else if (e.key === 'ArrowLeft') {
      const prev = order[(idx - 1 + order.length) % order.length];
      setActiveTab(prev);
      document.getElementById(`studio-tab-${prev}`)?.focus();
    }
  };

  const openContributionModal = (nextMode: SubmissionType) => {
    if (cloudMode && (!user || user.provider === 'guest')) {
      setAuthOpen(true);
      return;
    }
    setRespondToCorrection(null);
    setCorrectionMode(nextMode);
    setCorrectionOpen(true);
  };

  return (
    <>
      <header className="top-header">
        <div className="top-header-inner">
          <Link href="/" className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              भ
            </span>
            <span>
              <span className="brand-title">bhaJami</span>
              <span className="brand-sub">Sathya Sai Bhajan Jam Studio · Option 3 Vault</span>
            </span>
          </Link>

          <div className="header-actions">
            <Link href="/admin/corrections" className="btn">
              Admin Queue
              {pendingCount > 0 ? (
                <span className="badge badge-pending">{pendingCount} waiting</span>
              ) : null}
            </Link>
            <ThemeToggle />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setAuthOpen(true)}
            >
              {user ? user.name : 'Sign In / Join'}
            </button>
          </div>
        </div>
      </header>

      <main className="portal-shell">
        <div className="stats-strip">
          <span className="badge">Total Bhajans: {catalogIndex.stats.totalBhajans}</span>
          <span className="badge badge-verified">
            Sai Rhythms Enriched: {catalogIndex.stats.verifiedSaiRhythmsCount}
          </span>
          <span className="badge">
            BhajanDownloader (SSS Media): {catalogIndex.stats.bhajanDownloaderCount} MP3s
          </span>
          <span className="badge">RaviMp3 Archive: {catalogIndex.stats.raviMp3Count} MP3s</span>
        </div>

        <div className="portal-grid">
          {/* Left: Discovery Sidebar */}
          <aside className="card catalog-sidebar" aria-label="Bhajan Catalog Search">
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label htmlFor="catalog-search">Find a Bhajan, Raga, or Lyric Line</label>
              <input
                id="catalog-search"
                type="search"
                className="input-control"
                placeholder="e.g. Sundara, Nandalala, Bowli, Ganesha..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="chip-row" role="group" aria-label="Filter by Deity">
              {DEITY_FILTERS.map((deity) => (
                <button
                  key={deity}
                  type="button"
                  className="chip"
                  aria-pressed={deityFilter === deity}
                  onClick={() => setDeityFilter(deity)}
                >
                  {deity}
                </button>
              ))}
            </div>

            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.45rem',
                fontSize: '0.84rem',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={onlyVerified}
                onChange={(e) => setOnlyVerified(e.target.checked)}
              />
              <span>Show only Sai Rhythms full notation entries first</span>
            </label>

            <div className="song-list" role="list" aria-label="Filtered Bhajans">
              {filteredEntries.slice(0, 120).map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="song-item"
                  aria-current={b.id === activeEntry?.id ? 'true' : undefined}
                  onClick={() => setSelectedId(b.id)}
                >
                  <span className="song-item-title">{b.title}</span>
                  <span className="song-item-meta">
                    {b.deity ? <span>{b.deity}</span> : null}
                    {b.ragaName ? <span>· {b.ragaName}</span> : null}
                    <span>· {b.recordingCount} audio</span>
                    {b.metadataSource === 'sairhythms_verified' ? (
                      <span style={{ color: 'var(--success)', fontWeight: 700 }}>· Verified</span>
                    ) : null}
                  </span>
                </button>
              ))}
              {filteredEntries.length > 120 && (
                <p style={{ fontSize: '0.8rem', color: 'var(--muted)', textAlign: 'center' }}>
                  Showing top 120 of {filteredEntries.length} matches — narrow search above.
                </p>
              )}
              {filteredEntries.length === 0 && (
                <p style={{ fontSize: '0.88rem', color: 'var(--muted)' }}>
                  No bhajans match "{query}". Clear filters to see all {catalogIndex.stats.totalBhajans}.
                </p>
              )}
            </div>
          </aside>

          {/* Right: Active Jam Studio */}
          {activeBhajan ? (
            <section className="studio-stack" aria-label="Active Bhajan Jam Studio">
              <div className="card">
                <div className="studio-hero">
                  <div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                      {activeBhajan.deity && (
                        <span className="badge">{activeBhajan.deity}</span>
                      )}
                      {activeBhajan.raga?.name && (
                        <span className="badge">Raga: {activeBhajan.raga.name}</span>
                      )}
                      {activeBhajan.beat && (
                        <span className="badge">Beat: {activeBhajan.beat}</span>
                      )}
                      {activeBhajan.tempo && (
                        <span className="badge">Tempo: {activeBhajan.tempo}</span>
                      )}
                      {activeBhajan.updatedAt && (
                        <span className="badge badge-verified">Community Approved Update</span>
                      )}
                    </div>
                    <h1>{activeBhajan.title}</h1>
                    <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--muted)' }}>
                      Gents Ref:{' '}
                      <strong>
                        {activeBhajan.gentsPitch
                          ? formatPitchText(
                              activeBhajan.gentsPitch.pancham,
                              activeBhajan.gentsPitch.western,
                            )
                          : 'Not yet set'}
                      </strong>{' '}
                      · Ladies Ref:{' '}
                      <strong>
                        {activeBhajan.ladiesPitch
                          ? formatPitchText(
                              activeBhajan.ladiesPitch.pancham,
                              activeBhajan.ladiesPitch.western,
                            )
                          : 'Not yet set'}
                      </strong>
                      {activeBhajan.sourceUrl ? (
                        <>
                          {' '}
                          ·{' '}
                          <a
                            href={activeBhajan.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--accent)', fontWeight: 600 }}
                          >
                            Sai Rhythms Source
                          </a>
                        </>
                      ) : null}
                    </p>
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => openContributionModal('lyric_correction')}
                    >
                      Contribute / Suggest
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => openContributionModal('new_bhajan')}
                    >
                      + New Bhajan
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setProjectorOpen(true)}
                    >
                      Samithi Projector View
                    </button>
                  </div>
                </div>

                {/* Pitch / Shruti / Recording Console */}
                <div className="pitch-grid" style={{ marginTop: '1rem' }}>
                  <div className="control-box">
                    <div className="control-label">Lead Pitch & Semitone Transpose</div>
                    <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.55rem' }}>
                      <button
                        type="button"
                        className={`btn btn-sm ${voiceProfile === 'gents' ? 'btn-primary' : ''}`}
                        onClick={() => setVoiceProfile('gents')}
                      >
                        Gents Ref
                      </button>
                      <button
                        type="button"
                        className={`btn btn-sm ${voiceProfile === 'ladies' ? 'btn-primary' : ''}`}
                        onClick={() => setVoiceProfile('ladies')}
                      >
                        Ladies Ref
                      </button>
                      <select
                        aria-label="Pitch display format"
                        className="select-control"
                        style={{ padding: '0.25rem 0.45rem', fontSize: '0.78rem' }}
                        value={pitchFormat}
                        onChange={(e) =>
                          setPitchFormat(e.target.value as 'both' | 'pancham' | 'western')
                        }
                      >
                        <option value="both">Pancham + Western</option>
                        <option value="pancham">Pancham (1–7)</option>
                        <option value="western">Western (C–B)</option>
                      </select>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.5rem',
                      }}
                    >
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setSemitoneShift((s) => Math.max(-6, s - 1))}
                      >
                        −1 st
                      </button>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontWeight: 800, fontSize: '1.05rem', color: 'var(--accent)' }}>
                          {formatPitchText(targetPitch.pancham, targetPitch.western)}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                          {targetPitch.deltaLabel} · {targetPitch.freqHz} Hz
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setSemitoneShift((s) => Math.min(6, s + 1))}
                      >
                        +1 st
                      </button>
                    </div>
                  </div>

                  <div className="control-box">
                    <div className="control-label">Sa–Pa–Sa Tanpura Shruti Drone & Speed</div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.6rem',
                        marginBottom: '0.6rem',
                      }}
                    >
                      <button
                        type="button"
                        className={`btn btn-sm ${shrutiOn ? 'btn-success' : 'btn-primary'}`}
                        onClick={() => setShrutiOn((v) => !v)}
                      >
                        {shrutiOn ? 'Shruti Drone: ON' : 'Start Shruti Drone'}
                      </button>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                        Speed: {playbackRate.toFixed(2)}x
                      </span>
                    </div>
                    <label htmlFor="speed-slider" className="field-hint">
                      Practice Tempo ({Math.round(playbackRate * 100)}%)
                    </label>
                    <input
                      id="speed-slider"
                      type="range"
                      min={0.75}
                      max={1.25}
                      step={0.05}
                      value={playbackRate}
                      onChange={(e) => setPlaybackRate(Number(e.target.value))}
                      style={{ width: '100%' }}
                    />
                  </div>

                  <div className="control-box">
                    <div className="control-label">
                      Recording Vault ({activeBhajan.recordings.length} source
                      {activeBhajan.recordings.length === 1 ? '' : 's'})
                    </div>
                    {activeBhajan.recordings.length > 0 ? (
                      <>
                        <select
                          aria-label="Choose audio recording source"
                          className="select-control"
                          style={{ marginBottom: '0.55rem', fontSize: '0.82rem' }}
                          value={selectedRecordingIdx}
                          onChange={(e) => setSelectedRecordingIdx(Number(e.target.value))}
                        >
                          {activeBhajan.recordings.map((rec, idx) => (
                            <option key={rec.id} value={idx}>
                              {rec.label}
                            </option>
                          ))}
                        </select>
                        <audio
                          ref={mediaAudioRef}
                          key={activeAudioUrl}
                          controls
                          preload="metadata"
                          src={activeAudioUrl}
                          style={{ width: '100%', height: '38px' }}
                        />
                      </>
                    ) : (
                      <p style={{ fontSize: '0.84rem', color: 'var(--muted)', margin: 0 }}>
                        Use the built-in Tanpura Shruti drone above or suggest an audio link.
                      </p>
                    )}
                  </div>
                </div>

                {/* 4-Stem Jam Mixer */}
                <div className="control-box" style={{ marginTop: '0.85rem' }}>
                  <div className="control-label">
                    4-Stem Practice Mixer (Live Tanpura Gain + Option 3 Stem Targets)
                  </div>
                  <div className="pitch-grid">
                    {(
                      [
                        ['vocals', 'Lead & Chorus Vocals'],
                        ['harmonium', 'Harmonium'],
                        ['tabla', 'Tabla / Dholak'],
                        ['tanpura', 'Tanpura Shruti Drone'],
                      ] as const
                    ).map(([key, label]) => (
                      <div key={key}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: '0.82rem',
                            fontWeight: 600,
                          }}
                        >
                          <label htmlFor={`stem-${key}`}>{label}</label>
                          <span>{stems[key]}%</span>
                        </div>
                        <input
                          id={`stem-${key}`}
                          type="range"
                          min={0}
                          max={100}
                          value={stems[key]}
                          onChange={(e) =>
                            setStems((prev) => ({
                              ...prev,
                              [key]: Number(e.target.value),
                            }))
                          }
                          style={{ width: '100%' }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Lyrics, Notation, Glossary, Meaning Tabs (`tabs` guide) */}
              <div className="card tabs-wrapper">
                <div
                  className="tablist-scroller"
                  {...({ focusgroup: 'tablist nomemory' } as Record<string, string>)}
                  role="tablist"
                  aria-label="Bhajan Studio Panels"
                  onKeyDown={handleTabKeyDown}
                >
                  {(
                    [
                      ['lyrics', 'Synced Lyrics'],
                      ['notation', 'Raga & Sargam Notes'],
                      ['glossary', `Glossary (${activeBhajan.glossary.length})`],
                      ['meaning', 'Meaning & Attribution'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      id={`studio-tab-${id}`}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === id}
                      {...({ focusgroupstart: activeTab === id ? '' : undefined } as Record<
                        string,
                        string | undefined
                      >)}
                      onClick={() => setActiveTab(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div
                  role="tabpanel"
                  aria-labelledby="studio-tab-lyrics"
                  hidden={activeTab !== 'lyrics' ? ('until-found' as unknown as boolean) : false}
                  tabIndex={activeTab === 'lyrics' ? 0 : undefined}
                >
                  <div className="tabpanel-inner">
                    {activeBhajan.lyricsSets.length > 1 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.75rem' }}>
                        {activeBhajan.lyricsSets.map((ls, idx) => (
                          <button
                            key={ls.language}
                            type="button"
                            className={`btn btn-sm ${activeScriptIdx === idx ? 'btn-primary' : ''}`}
                            onClick={() => setActiveScriptIdx(idx)}
                          >
                            {ls.language}
                          </button>
                        ))}
                      </div>
                    )}
                    <div role="list" aria-label="Bhajan Lyrics Lines">
                      {(activeLyricsSet?.lines || []).map((line, i) => (
                        <button
                          key={`${i}-${line}`}
                          type="button"
                          className="lyric-line"
                          aria-current={activeLineIdx === i ? 'true' : undefined}
                          onClick={() => setActiveLineIdx(i)}
                        >
                          {line}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div
                  role="tabpanel"
                  aria-labelledby="studio-tab-notation"
                  hidden={activeTab !== 'notation' ? ('until-found' as unknown as boolean) : false}
                  tabIndex={activeTab === 'notation' ? 0 : undefined}
                >
                  <div className="tabpanel-inner">
                    <div className="pitch-grid">
                      <div className="control-box">
                        <div className="control-label">
                          Raga &amp; Scale ({activeBhajan.raga?.name || 'Unspecified'})
                        </div>
                        <p style={{ margin: '0 0 0.35rem 0' }}>
                          <strong>Arohanam:</strong>{' '}
                          {activeBhajan.raga?.arohanam || 'Pending sync'}
                        </p>
                        <p style={{ margin: '0 0 0.35rem 0' }}>
                          <strong>Avarohanam:</strong>{' '}
                          {activeBhajan.raga?.avarohanam || 'Pending sync'}
                        </p>
                        {activeBhajan.raga?.westernInC && (
                          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.86rem' }}>
                            <strong>In Key of C:</strong> {activeBhajan.raga.westernInC}
                          </p>
                        )}
                      </div>
                      <div className="control-box">
                        <div className="control-label">First Line Music Notes</div>
                        <p style={{ margin: '0 0 0.35rem 0' }}>
                          <strong>Sargam:</strong>{' '}
                          {activeBhajan.firstLineNotes?.sargam || 'Not yet published'}
                        </p>
                        {activeBhajan.firstLineNotes?.westernInC && (
                          <p style={{ margin: '0 0 0.35rem 0' }}>
                            <strong>Western (Key of C):</strong>{' '}
                            {activeBhajan.firstLineNotes.westernInC}
                          </p>
                        )}
                        {activeBhajan.notesRange && (
                          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--muted)' }}>
                            <strong>Range:</strong> {activeBhajan.notesRange}
                          </p>
                        )}
                      </div>
                    </div>
                    {activeBhajan.sheetMusicUrl && (
                      <p style={{ marginTop: '0.8rem' }}>
                        <a
                          href={activeBhajan.sheetMusicUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="btn btn-sm"
                        >
                          Open Sai Rhythms Sheet Music Viewer
                        </a>
                      </p>
                    )}
                  </div>
                </div>

                <div
                  role="tabpanel"
                  aria-labelledby="studio-tab-glossary"
                  hidden={activeTab !== 'glossary' ? ('until-found' as unknown as boolean) : false}
                  tabIndex={activeTab === 'glossary' ? 0 : undefined}
                >
                  <div className="tabpanel-inner">
                    {activeBhajan.glossary.length > 0 ? (
                      <dl style={{ margin: 0, display: 'grid', gap: '0.55rem' }}>
                        {activeBhajan.glossary.map((g) => (
                          <div key={g.term} className="control-box" style={{ padding: '0.65rem 0.85rem' }}>
                            <dt style={{ fontWeight: 700, color: 'var(--accent)' }}>{g.term}</dt>
                            <dd style={{ margin: '0.15rem 0 0 0', fontSize: '0.9rem' }}>
                              {g.description}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p style={{ color: 'var(--muted)' }}>
                        No glossary terms synced for this bhajan yet.
                      </p>
                    )}
                  </div>
                </div>

                <div
                  role="tabpanel"
                  aria-labelledby="studio-tab-meaning"
                  hidden={activeTab !== 'meaning' ? ('until-found' as unknown as boolean) : false}
                  tabIndex={activeTab === 'meaning' ? 0 : undefined}
                >
                  <div className="tabpanel-inner">
                    <p style={{ marginTop: 0 }}>
                      {activeBhajan.meaning ||
                        'English meaning not yet added. You can contribute it via Suggest Lyrics Correction.'}
                    </p>
                    <p style={{ fontSize: '0.84rem', color: 'var(--muted)', marginBottom: 0 }}>
                      <strong>Attribution:</strong>{' '}
                      {activeBhajan.sourceUrl ? (
                        <>
                          Curated metadata sourced respectfully from{' '}
                          <a href={activeBhajan.sourceUrl} target="_blank" rel="noreferrer">
                            SSSIO Sai Rhythms
                          </a>
                          .
                        </>
                      ) : (
                        'Indexed from Sri Sathya Sai Media Centre (A Bhajan A Day) / RaviMp3 local archive.'
                      )}
                    </p>
                  </div>
                </div>
              </div>
            </section>
          ) : loadingDetail ? (
            <section className="card" aria-live="polite" aria-label="Loading Bhajan">
              <p style={{ color: 'var(--muted)', margin: 0 }}>
                Loading bhajan lyrics, notation, and recordings…
              </p>
            </section>
          ) : null}
        </div>
      </main>

      {projectorOpen && activeBhajan ? (
        <div className="projector-overlay" role="dialog" aria-label="Samithi Projector View">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong style={{ color: '#ffb300', fontSize: '1.1rem' }}>
                {activeBhajan.title}
              </strong>{' '}
              <span style={{ opacity: 0.8, fontSize: '0.95rem' }}>
                · Target Pitch: {formatPitchText(targetPitch.pancham, targetPitch.western)} · Raga{' '}
                {activeBhajan.raga?.name || 'Unspecified'}
              </span>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setProjectorOpen(false)}
            >
              Exit Projector (Esc)
            </button>
          </div>
          <div className="projector-lines">
            {(activeLyricsSet?.lines || []).map((line, i) => (
              <div
                key={`${i}-${line}`}
                style={{
                  color: i === activeLineIdx ? '#ffd54f' : '#fff3dc',
                  opacity: i === activeLineIdx ? 1 : 0.72,
                  marginBottom: '0.5rem',
                }}
                onClick={() => setActiveLineIdx(i)}
              >
                {line}
              </div>
            ))}
          </div>
          <div style={{ textAlign: 'center', fontSize: '0.85rem', opacity: 0.7 }}>
            Tap any verse to highlight · {activeBhajan.meaning}
          </div>
        </div>
      ) : null}

      <AuthDialog
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        user={user}
        cloudMode={cloudMode}
        onSignedIn={(signedUser) => setUser(signedUser)}
        onSignOut={() => setUser(null)}
      />

      {activeBhajan && (
        <SuggestCorrectionDialog
          open={correctionOpen}
          onClose={() => {
            setCorrectionOpen(false);
            setRespondToCorrection(null);
          }}
          bhajan={activeBhajan}
          activeScriptIndex={activeScriptIdx}
          initialMode={correctionMode}
          respondToCorrection={respondToCorrection}
          user={user}
          onSubmitted={refreshCatalog}
        />
      )}
    </>
  );
}
