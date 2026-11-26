'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import {
  buildStreamQueue,
  canonicalizePhrase,
  computeSimilarBhajans,
  groupRecommendationsByRaga,
  normalizeRagaKey,
  resolveLikedSet,
  type Bhajan,
  type BhajanIndexEntry,
  type CatalogIndexPayload,
  type CatalogStats,
  type LyricCorrection,
  type StreamMediaMode,
  type StreamModeKind,
} from '@bhajami/shared';
import {
  consumeGoogleRedirectResult,
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
import {
  loadLocalLikedIds,
  saveLocalLikedIds,
  syncLoadUserFavorites,
  syncSaveUserFavorites,
} from '@/lib/user-library';
import { ThemeToggle } from './ThemeToggle';
import {
  AuthDialog,
  isSessionUserAdmin,
  PRIMARY_ADMIN_EMAIL,
  type SessionUser,
} from './AuthDialog';
import { SuggestCorrectionDialog } from './SuggestCorrectionDialog';
import { StreamRadioView } from './StreamRadioView';

type AppViewMode = 'home' | 'stream' | 'liked';

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

  // Modals & User Session
  const [authOpen, setAuthOpen] = useState(false);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [respondToCorrection, setRespondToCorrection] = useState<LyricCorrection | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);

  // All-form-factor App-Mode views, Stream Radio & Login-Synced Liked Playlist
  const [activeView, setActiveView] = useState<AppViewMode>('home');
  const [likedIds, setLikedIds] = useState<string[]>([]);
  const [likedSyncStatus, setLikedSyncStatus] = useState<'device' | 'syncing' | 'synced'>('device');
  const [streamMode, setStreamMode] = useState<StreamModeKind>('discovery');
  const [streamDeity, setStreamDeity] = useState<string>('All');
  const [streamRaga, setStreamRaga] = useState<string>('');
  const [streamSeed, setStreamSeed] = useState<number>(1);
  const [streamQueue, setStreamQueue] = useState<BhajanIndexEntry[]>(() =>
    buildStreamQueue(initialIndex.entries, {
      mode: 'discovery',
      likedIds: [],
      mediaMode: 'audio',
      seed: 1,
    }),
  );
  const [streamIdx, setStreamIdx] = useState(0);
  const [streamAutoPlay, setStreamAutoPlay] = useState(true);
  const [streamSessionActive, setStreamSessionActive] = useState(false);
  const [streamMediaMode, setStreamMediaMode] = useState<StreamMediaMode>('audio');
  const [streamLoadingDetail, setStreamLoadingDetail] = useState(false);
  const [likedRagaFilter, setLikedRagaFilter] = useState<string>('');
  const [homeQuery, setHomeQuery] = useState('');

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('bhajami_stream_media_mode_v1');
      if (saved === 'audio' || saved === 'video') {
        setStreamMediaMode(saved);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    if (activeView === 'stream') {
      setStreamSessionActive(true);
    }
  }, [activeView]);

  const handleStreamMediaModeChange = useCallback((next: StreamMediaMode) => {
    setStreamMediaMode(next);
    try {
      window.localStorage.setItem('bhajami_stream_media_mode_v1', next);
    } catch {
      // ignore
    }
  }, []);

  // Persist Firebase client authentication across reloads & complete Google redirect sign-in
  useEffect(() => {
    const fb = getFirebaseClientAuth();
    if (!fb) return;
    let cancelled = false;
    void consumeGoogleRedirectResult();
    const unsub = onAuthStateChanged(fb.auth, (fbUser) => {
      if (fbUser && !fbUser.isAnonymous) {
        void (async () => {
          const tokenResult = await fbUser.getIdTokenResult().catch(() => null);
          if (cancelled) return;
          const signedEmail = fbUser.email || '';
          const isAdmin = Boolean(
            tokenResult?.claims?.admin === true ||
              (signedEmail.trim().toLowerCase() === PRIMARY_ADMIN_EMAIL && fbUser.emailVerified),
          );
          setUser({
            name: fbUser.displayName || fbUser.email?.split('@')[0] || 'Sai Devotee',
            email: signedEmail,
            uid: fbUser.uid,
            provider: fbUser.providerData.some((p) => p.providerId === 'google.com')
              ? 'google'
              : 'email',
            emailVerified: fbUser.emailVerified,
            isAdmin,
          });
        })();
      } else if (fbUser === null && cloudMode) {
        setUser(null);
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [cloudMode]);

  // Hydrate liked playlist from localStorage and sync with Firestore `users/{uid}` when signed in
  useEffect(() => {
    let cancelled = false;
    const isSignedInAccount = Boolean(user?.uid && user.provider !== 'guest');
    if (!isSignedInAccount || !user?.uid) {
      setLikedIds(loadLocalLikedIds(null));
      setLikedSyncStatus('device');
      return;
    }

    const signedUid = user.uid;
    const signedEmail = user.email;
    const signedName = user.name;
    setLikedSyncStatus('syncing');
    void syncLoadUserFavorites(signedUid).then(async (merged) => {
      if (cancelled) return;
      setLikedIds(merged);
      const guestIds = loadLocalLikedIds(null);
      if (guestIds.length > 0) {
        await syncSaveUserFavorites({
          uid: signedUid,
          favorites: merged,
          email: signedEmail,
          displayName: signedName,
        });
        saveLocalLikedIds([], null);
      }
      if (!cancelled) {
        setLikedSyncStatus('synced');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [user?.email, user?.name, user?.provider, user?.uid]);

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
      if (respondToCorrection?.bhajanId) {
        void fetchAndCacheBhajanDetail(respondToCorrection.bhajanId);
      }
    } catch {
      // Keep current catalog snapshot on offline/network errors
    }
  }, [fetchAndCacheBhajanDetail, respondToCorrection?.bhajanId]);

  // Boot & check IndexedDB `bhajami_cache_v1` against Firestore `catalogMeta/latest`
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (initialBhajan) {
        void setCachedBhajan(initialBhajan);
      }
      const cached = await getCachedCatalogIndex();
      let currentVersion = initialIndex.version;
      let currentEntriesCount = initialIndex.entries.length;
      if (!cancelled && cached && cached.version > initialIndex.version) {
        setCatalogIndex(cached);
        currentVersion = cached.version;
        currentEntriesCount = cached.entries.length;
      } else {
        void setCachedCatalogIndex(initialIndex);
      }

      const db = getFirebaseClientFirestore();
      if (!db) return;
      try {
        const snap = await getDoc(doc(db, 'catalogMeta', 'latest'));
        if (!cancelled && snap.exists()) {
          const data = snap.data();
          const remoteVersion = Number(data?.version ?? 0);
          const remoteTotal = Number(data?.stats?.totalBhajans ?? 0);
          if (
            remoteVersion > currentVersion ||
            (remoteTotal > 0 && remoteTotal !== currentEntriesCount)
          ) {
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

  const likedSet = useMemo(
    () => resolveLikedSet(likedIds, catalogIndex.entries),
    [catalogIndex.entries, likedIds],
  );

  const likedEntries = useMemo(
    () => catalogIndex.entries.filter((entry) => likedSet.has(entry.id)),
    [catalogIndex.entries, likedSet],
  );

  const MIN_LIKES_FOR_YOU = 3;
  const canShowForYou = likedEntries.length >= MIN_LIKES_FOR_YOU;

  useEffect(() => {
    if (streamMode === 'for_you' && !canShowForYou) {
      setStreamMode('discovery');
    }
  }, [canShowForYou, streamMode]);

  const similarRecs = useMemo(
    () => computeSimilarBhajans(likedIds, catalogIndex.entries, { limit: 18 }),
    [catalogIndex.entries, likedIds],
  );

  const ragaShelves = useMemo(
    () => groupRecommendationsByRaga(similarRecs, 4),
    [similarRecs],
  );

  const availableRagas = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const entry of catalogIndex.entries) {
      const key = normalizeRagaKey(entry.ragaName);
      if (key && !byKey.has(key) && entry.ragaName) {
        byKey.set(key, entry.ragaName);
      }
    }
    return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
  }, [catalogIndex.entries]);

  const likedRagaChips = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const entry of likedEntries) {
      const key = normalizeRagaKey(entry.ragaName);
      if (key && !byKey.has(key) && entry.ragaName) {
        byKey.set(key, entry.ragaName);
      }
    }
    return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
  }, [likedEntries]);

  const filteredLikedEntries = useMemo(() => {
    if (!likedRagaFilter) return likedEntries;
    const wanted = normalizeRagaKey(likedRagaFilter);
    return likedEntries.filter((entry) => normalizeRagaKey(entry.ragaName) === wanted);
  }, [likedEntries, likedRagaFilter]);

  const likedIdsRef = useRef(likedIds);
  likedIdsRef.current = likedIds;

  // Rebuild stream queue cleanly on mode/filter/reshuffle without disrupting current song on like or Audio/Video toggle
  useEffect(() => {
    const nextQueue = buildStreamQueue(catalogIndex.entries, {
      mode: streamMode,
      likedIds: likedIdsRef.current,
      deityFilter: streamDeity,
      ragaFilter: streamRaga,
      seed: streamSeed,
    });
    setStreamQueue(nextQueue);
    setStreamIdx(0);
  }, [catalogIndex.entries, streamDeity, streamMode, streamRaga, streamSeed]);

  const activeStreamEntry = streamQueue[streamIdx] || streamQueue[0] || null;
  const activeStreamBhajan = activeStreamEntry ? bhajanCache[activeStreamEntry.id] || null : null;

  useEffect(() => {
    if (
      (activeView !== 'stream' && !streamSessionActive) ||
      !activeStreamEntry?.id ||
      bhajanCache[activeStreamEntry.id]
    ) {
      setStreamLoadingDetail(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setStreamLoadingDetail(true);
    void (async () => {
      try {
        const cached = await getCachedBhajan(activeStreamEntry.id);
        if (!cancelled && cached) {
          setBhajanCache((prev) => ({ ...prev, [activeStreamEntry.id]: cached }));
          return;
        }
        await fetchAndCacheBhajanDetail(activeStreamEntry.id, controller.signal);
      } finally {
        if (!cancelled) {
          setStreamLoadingDetail(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeStreamEntry?.id, activeView, bhajanCache, fetchAndCacheBhajanDetail, streamSessionActive]);

  const handleRetryStreamDetail = useCallback(() => {
    const id = activeStreamEntry?.id;
    if (!id) return;
    setStreamLoadingDetail(true);
    void fetchAndCacheBhajanDetail(id).finally(() => {
      setStreamLoadingDetail(false);
    });
  }, [activeStreamEntry?.id, fetchAndCacheBhajanDetail]);

  const handleToggleLike = useCallback(
    (bhajanId: string) => {
      setLikedIds((prev) => {
        const exists = prev.includes(bhajanId);
        const next = exists ? prev.filter((id) => id !== bhajanId) : [bhajanId, ...prev];
        const isSignedInAccount = Boolean(user?.uid && user.provider !== 'guest');
        saveLocalLikedIds(next, isSignedInAccount ? user?.uid : null);
        if (isSignedInAccount && user?.uid) {
          setLikedSyncStatus('syncing');
          void syncSaveUserFavorites({
            uid: user.uid,
            favorites: next,
            email: user.email,
            displayName: user.name,
          }).then((ok) => {
            setLikedSyncStatus(ok ? 'synced' : 'device');
          });
        }
        return next;
      });
    },
    [user?.email, user?.name, user?.provider, user?.uid],
  );

  const playEntryInStream = useCallback(
    (entry: BhajanIndexEntry) => {
      setStreamQueue((prev) => {
        const existingIdx = prev.findIndex((item) => item.id === entry.id);
        if (existingIdx >= 0) {
          setStreamIdx(existingIdx);
          return prev;
        }
        setStreamIdx(0);
        return [entry, ...prev];
      });
      setActiveView('stream');
    },
    [],
  );

  const homeSearchResults = useMemo(() => {
    const q = homeQuery.trim().toLowerCase();
    if (!q) return [];
    const canonTokens = canonicalizePhrase(q).split(' ').filter(Boolean);
    return catalogIndex.entries
      .filter((b) => {
        if (
          b.title.toLowerCase().includes(q) ||
          (b.ragaName || '').toLowerCase().includes(q) ||
          (b.deity || '').toLowerCase().includes(q) ||
          b.searchText.toLowerCase().includes(q)
        ) {
          return true;
        }
        return (
          canonTokens.length > 0 &&
          canonTokens.every((ct) => b.phoneticTokens.some((pt) => pt.includes(ct)))
        );
      })
      .slice(0, 9);
  }, [catalogIndex.entries, homeQuery]);

  const targetId =
    respondToCorrection?.bhajanId ||
    initialBhajan?.id ||
    initialIndex.entries[0]?.id ||
    '';
  const activeBhajan: Bhajan | undefined = targetId ? bhajanCache[targetId] : undefined;

  useEffect(() => {
    if (!respondToCorrection?.bhajanId || bhajanCache[respondToCorrection.bhajanId]) return;
    const controller = new AbortController();
    void fetchAndCacheBhajanDetail(respondToCorrection.bhajanId, controller.signal);
    return () => controller.abort();
  }, [bhajanCache, fetchAndCacheBhajanDetail, respondToCorrection?.bhajanId]);

  const isAdminUser = isSessionUserAdmin(user, cloudMode);

  return (
    <>
      <header className="top-header">
        <div className="top-header-inner">
          <Link
            href="/"
            className="brand-lockup"
            onClick={() => setActiveView('home')}
          >
            <span className="brand-mark" aria-hidden="true">
              भ
            </span>
            <span>
              <span className="brand-title">bhaJami</span>
            </span>
          </Link>

          <nav className="app-nav-desktop" aria-label="Primary App Views">
            <button
              type="button"
              className="app-nav-tab"
              aria-current={activeView === 'home' ? 'page' : undefined}
              onClick={() => setActiveView('home')}
            >
              Home
            </button>
            <button
              type="button"
              className="app-nav-tab"
              aria-current={activeView === 'stream' ? 'page' : undefined}
              onClick={() => setActiveView('stream')}
            >
              Stream Radio
            </button>
            <button
              type="button"
              className="app-nav-tab"
              aria-current={activeView === 'liked' ? 'page' : undefined}
              onClick={() => setActiveView('liked')}
            >
              ♥ Liked ({likedEntries.length})
            </button>
          </nav>

          <div className="header-actions">
            {isAdminUser && (
              <Link href="/admin/corrections" className="btn">
                Admin Queue
                {pendingCount > 0 ? (
                  <span className="badge badge-pending">{pendingCount} waiting</span>
                ) : null}
              </Link>
            )}
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

      <main
        className={`portal-shell app-stage${
          streamSessionActive && activeView !== 'stream' && activeStreamEntry
            ? ' has-mini-stream'
            : ''
        }`}
      >
        {activeView === 'home' && (
          <div>
            <section className="home-hero-card" aria-label="bhaJami Home">
              <div>
                <h1 style={{ margin: '0 0 0.35rem', fontSize: 'clamp(1.45rem, 3vw, 2rem)' }}>
                  Your Sathya Sai Bhajans Companion
                </h1>
                <p style={{ margin: 0, color: 'var(--muted)', maxWidth: '62ch' }}>
                  Listen continuously with Random Bhajan Stream, tap ♥ to curate your{' '}
                  {user && user.provider !== 'guest' ? 'cloud-synced' : 'personal'} Liked playlist,
                  or explore bhajans sharing the same Raga.
                </p>
              </div>
              <div className="home-hero-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setStreamMode('discovery');
                    setStreamSeed((s) => s + 1);
                    setActiveView('stream');
                  }}
                >
                  ▶ Start Random Stream
                </button>
                {canShowForYou && (
                  <button
                    type="button"
                    className="btn btn-success"
                    onClick={() => {
                      setStreamMode('for_you');
                      setStreamSeed((s) => s + 1);
                      setActiveView('stream');
                    }}
                  >
                    ✨ For You
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  onClick={() => setActiveView('liked')}
                >
                  ♥ Liked Playlist ({likedEntries.length})
                </button>
              </div>

              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="home-quick-search">Quick Search Across All Scripts &amp; Ragas</label>
                <input
                  id="home-quick-search"
                  type="search"
                  className="input-control"
                  placeholder="Try Vittala, Narayana, Bowli, Ganesha, Sai..."
                  value={homeQuery}
                  onChange={(e) => setHomeQuery(e.target.value)}
                />
              </div>

              {homeSearchResults.length > 0 && (
                <div className="rec-shelf-grid">
                  {homeSearchResults.map((entry) => {
                    const liked = likedSet.has(entry.id);
                    return (
                      <article key={entry.id} className="rec-card">
                        <div>
                          <h3 className="rec-card-title">{entry.title}</h3>
                          <p className="field-hint" style={{ margin: '0.2rem 0 0' }}>
                            {[entry.deity, entry.ragaName, `${entry.recordingCount} audio`]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        </div>
                        <div className="rec-card-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => playEntryInStream(entry)}
                          >
                            Stream
                          </button>
                          <button
                            type="button"
                            className="like-btn"
                            aria-pressed={liked}
                            aria-label={liked ? `Unlike ${entry.title}` : `Like ${entry.title}`}
                            onClick={() => handleToggleLike(entry.id)}
                          >
                            {liked ? '♥' : '♡'}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            {ragaShelves.map((shelf) => (
              <section
                key={shelf.ragaName}
                className="rec-shelf-section"
                aria-label={`Because You Liked Raga ${shelf.ragaName}`}
              >
                <div className="rec-shelf-header">
                  <h2>Because You Liked Raga {shelf.ragaName}</h2>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setStreamRaga(shelf.ragaName);
                      setStreamDeity('All');
                      setStreamMode('discovery');
                      setStreamSeed((s) => s + 1);
                      setActiveView('stream');
                    }}
                  >
                    Stream Raga {shelf.ragaName}
                  </button>
                </div>
                <div className="rec-shelf-grid">
                  {shelf.items.slice(0, 6).map((rec) => {
                    const liked = likedSet.has(rec.entry.id);
                    return (
                      <article key={rec.entry.id} className="rec-card">
                        <div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.3rem' }}>
                            {rec.reasons.slice(0, 2).map((reason) => (
                              <span key={reason} className="badge badge-verified">
                                {reason}
                              </span>
                            ))}
                          </div>
                          <h3 className="rec-card-title">{rec.entry.title}</h3>
                          <p className="field-hint" style={{ margin: '0.2rem 0 0' }}>
                            {[rec.entry.deity, rec.entry.beat].filter(Boolean).join(' · ')}
                          </p>
                        </div>
                        <div className="rec-card-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => playEntryInStream(rec.entry)}
                          >
                            Stream
                          </button>
                          <button
                            type="button"
                            className="like-btn"
                            aria-pressed={liked}
                            aria-label={liked ? `Unlike ${rec.entry.title}` : `Like ${rec.entry.title}`}
                            onClick={() => handleToggleLike(rec.entry.id)}
                          >
                            {liked ? '♥ Liked' : '♡ Like'}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}

            <section className="rec-shelf-section" aria-label="Recommended For You">
              <div className="rec-shelf-header">
                <h2>
                  {likedEntries.length > 0
                    ? 'Recommended Based on Your Likes'
                    : 'Featured Verified Bhajans to Explore'}
                </h2>
                <span className="field-hint">
                  {likedEntries.length > 0
                    ? 'Ranked by Raga, Deity, and Beat similarity'
                    : 'Tap ♡ Like on any bhajan to personalize recommendations'}
                </span>
              </div>
              <div className="rec-shelf-grid">
                {similarRecs.slice(0, 9).map((rec) => {
                  const liked = likedSet.has(rec.entry.id);
                  return (
                    <article key={rec.entry.id} className="rec-card">
                      <div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.3rem' }}>
                          {rec.reasons.slice(0, 2).map((reason) => (
                            <span key={reason} className="badge badge-verified">
                              {reason}
                            </span>
                          ))}
                        </div>
                        <h3 className="rec-card-title">{rec.entry.title}</h3>
                        <p className="field-hint" style={{ margin: '0.2rem 0 0' }}>
                          {[rec.entry.ragaName, rec.entry.beat, `${rec.entry.recordingCount} audio`]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </div>
                      <div className="rec-card-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => playEntryInStream(rec.entry)}
                        >
                          Stream
                        </button>
                        <button
                          type="button"
                          className="like-btn"
                          aria-pressed={liked}
                          aria-label={liked ? `Unlike ${rec.entry.title}` : `Like ${rec.entry.title}`}
                          onClick={() => handleToggleLike(rec.entry.id)}
                        >
                          {liked ? '♥ Liked' : '♡ Like'}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="rec-shelf-section" aria-label="Quick Deity Stream Shortcuts">
              <div className="rec-shelf-header">
                <h2>Deity Radio Channels</h2>
              </div>
              <div className="chip-row">
                {DEITY_FILTERS.filter((d) => d !== 'All').map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setStreamDeity(d);
                      setStreamRaga('');
                      setStreamMode('discovery');
                      setStreamSeed((s) => s + 1);
                      setActiveView('stream');
                    }}
                  >
                    ▶ {d} Radio
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}

        {(activeView === 'stream' || (streamSessionActive && Boolean(activeStreamEntry))) && (
          <StreamRadioView
            minimized={activeView !== 'stream'}
            mediaMode={streamMediaMode}
            onMediaModeChange={handleStreamMediaModeChange}
            mode={streamMode}
            onModeChange={(next) => setStreamMode(next)}
            deityFilter={streamDeity}
            onDeityFilterChange={(next) => setStreamDeity(next)}
            ragaFilter={streamRaga}
            onRagaFilterChange={(next) => setStreamRaga(next)}
            deityChoices={DEITY_FILTERS}
            availableRagas={availableRagas}
            currentEntry={activeStreamEntry}
            currentBhajan={activeStreamBhajan}
            loadingDetail={streamLoadingDetail}
            queue={streamQueue}
            queueIndex={streamIdx}
            likedSet={likedSet}
            autoPlay={streamAutoPlay}
            onToggleAutoPlay={() => setStreamAutoPlay((v) => !v)}
            onToggleLike={handleToggleLike}
            onPrev={() =>
              setStreamIdx((idx) => (streamQueue.length > 0 ? (idx - 1 + streamQueue.length) % streamQueue.length : 0))
            }
            onNext={() =>
              setStreamIdx((idx) => (streamQueue.length > 0 ? (idx + 1) % streamQueue.length : 0))
            }
            onReshuffle={() => setStreamSeed((s) => s + 1)}
            onSelectQueueIndex={(idx) => setStreamIdx(idx)}
            onPlayEntry={playEntryInStream}
            onRetryDetail={handleRetryStreamDetail}
            onExpand={() => setActiveView('stream')}
            onDismiss={() => setStreamSessionActive(false)}
            similarRecs={similarRecs}
          />
        )}

        {activeView === 'liked' && (
          <div>
            <section className="home-hero-card" aria-label="Liked Bhajans Playlist">
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.75rem',
                }}
              >
                <div>
                  <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.45rem' }}>
                    Your Liked Bhajans Playlist ({likedEntries.length})
                  </h1>
                  <p className="field-hint" style={{ margin: 0 }}>
                    {user && user.provider !== 'guest'
                      ? likedSyncStatus === 'synced'
                        ? `Synced to your account (${user.email || user.name})`
                        : likedSyncStatus === 'syncing'
                          ? 'Syncing favorites with your account…'
                          : 'Saved locally on this device'
                      : 'Saved on this device — Sign In with Google or Email to sync across devices.'}
                  </p>
                </div>
                <div className="home-hero-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={likedEntries.length === 0}
                    onClick={() => {
                      setStreamMode('liked_only');
                      setStreamDeity('All');
                      setStreamRaga(likedRagaFilter);
                      setStreamSeed((s) => s + 1);
                      setActiveView('stream');
                    }}
                  >
                    ▶ Play Liked Radio
                  </button>
                  {(!user || user.provider === 'guest') && (
                    <button type="button" className="btn" onClick={() => setAuthOpen(true)}>
                      Sign In to Sync
                    </button>
                  )}
                </div>
              </div>

              {likedRagaChips.length > 0 && (
                <div className="chip-row" role="group" aria-label="Filter Liked by Raga">
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={likedRagaFilter === ''}
                    onClick={() => setLikedRagaFilter('')}
                  >
                    All Ragas
                  </button>
                  {likedRagaChips.map((ragaName) => (
                    <button
                      key={ragaName}
                      type="button"
                      className="chip"
                      aria-pressed={likedRagaFilter === ragaName}
                      onClick={() => setLikedRagaFilter(ragaName)}
                    >
                      Raga {ragaName}
                    </button>
                  ))}
                </div>
              )}

              {filteredLikedEntries.length === 0 ? (
                <p style={{ margin: 0, color: 'var(--muted)' }}>
                  No liked bhajans yet. Start Random Stream or browse Home and tap ♡ Like to add favorites!
                </p>
              ) : (
                <div className="rec-shelf-grid">
                  {filteredLikedEntries.map((entry) => (
                    <article key={entry.id} className="rec-card">
                      <div>
                        <h3 className="rec-card-title">{entry.title}</h3>
                        <p className="field-hint" style={{ margin: '0.2rem 0 0' }}>
                          {[entry.deity, entry.ragaName, entry.beat].filter(Boolean).join(' · ') ||
                            'Bhajan'}
                        </p>
                      </div>
                      <div className="rec-card-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => playEntryInStream(entry)}
                        >
                          Stream
                        </button>
                        <button
                          type="button"
                          className="like-btn"
                          aria-pressed={true}
                          aria-label={`Remove ${entry.title} from Liked Playlist`}
                          onClick={() => handleToggleLike(entry.id)}
                        >
                          ♥ Remove
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            {similarRecs.length > 0 && (
              <section className="rec-shelf-section" aria-label="Similar Raga Suggestions">
                <div className="rec-shelf-header">
                  <h2>More Bhajans in Your Liked Ragas</h2>
                  <span className="field-hint">Recommended automatically from your favorites</span>
                </div>
                <div className="rec-shelf-grid">
                  {similarRecs.slice(0, 9).map((rec) => {
                    const liked = likedSet.has(rec.entry.id);
                    return (
                      <article key={rec.entry.id} className="rec-card">
                        <div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.3rem' }}>
                            {rec.reasons.slice(0, 2).map((reason) => (
                              <span key={reason} className="badge badge-verified">
                                {reason}
                              </span>
                            ))}
                          </div>
                          <h3 className="rec-card-title">{rec.entry.title}</h3>
                        </div>
                        <div className="rec-card-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => playEntryInStream(rec.entry)}
                          >
                            Stream
                          </button>
                          <button
                            type="button"
                            className="like-btn"
                            aria-pressed={liked}
                            aria-label={liked ? `Unlike ${rec.entry.title}` : `Like ${rec.entry.title}`}
                            onClick={() => handleToggleLike(rec.entry.id)}
                          >
                            {liked ? '♥ Like' : '♡ Like'}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}

      </main>

      <nav className="app-bottom-nav" aria-label="Mobile App Views">
        <button
          type="button"
          className="app-bottom-nav-btn"
          aria-current={activeView === 'home' ? 'page' : undefined}
          onClick={() => setActiveView('home')}
        >
          <span aria-hidden="true">🏠</span>
          <span>Home</span>
        </button>
        <button
          type="button"
          className="app-bottom-nav-btn"
          aria-current={activeView === 'stream' ? 'page' : undefined}
          onClick={() => setActiveView('stream')}
        >
          <span aria-hidden="true">▶</span>
          <span>Stream</span>
        </button>
        <button
          type="button"
          className="app-bottom-nav-btn"
          aria-current={activeView === 'liked' ? 'page' : undefined}
          onClick={() => setActiveView('liked')}
        >
          <span aria-hidden="true">♥</span>
          <span>Liked ({likedEntries.length})</span>
        </button>
      </nav>

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
          activeScriptIndex={0}
          initialMode="lyric_correction"
          focusFields={[]}
          respondToCorrection={respondToCorrection}
          user={user}
          onSubmitted={refreshCatalog}
        />
      )}
    </>
  );
}
