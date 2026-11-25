import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { Audio, type AVPlaybackStatus } from 'expo-av';
import { StatusBar } from 'expo-status-bar';
import {
  buildStreamQueue,
  computeSimilarBhajans,
  groupRecommendationsByRaga,
  normalizeRagaKey,
  pickStreamRecording,
  resolveLikedSet,
  transposePitch,
  type Bhajan,
  type BhajanIndexEntry,
  type BhajanRecommendation,
  type CatalogIndexPayload,
  type StreamMediaMode,
  type StreamModeKind,
} from '@bhajami/shared';
import {
  MobileYouTubePlayer,
  type MobileYouTubePlayerHandle,
} from './src/components/MobileYouTubePlayer';
import {
  DEFAULT_FIREBASE_PROJECT_ID,
  fetchCloudBhajanDetail,
  fetchCloudCatalogIndex,
  getBundledCatalogIndex,
} from './src/lib/cloud-catalog';
import {
  loadCachedCatalogIndex,
  loadStoredLikedIds,
  loadStoredMediaMode,
  loadStoredThemeMode,
  saveCachedCatalogIndex,
  saveStoredLikedIds,
  saveStoredMediaMode,
  saveStoredThemeMode,
} from './src/lib/mobile-storage';
import {
  filterBhajanIndexEntries,
  formatMetadataSourceBadge,
  resolvePlaybackAction,
} from './src/lib/search-and-playback';

type AppTab = 'home' | 'stream' | 'studio' | 'liked';

const DEFAULT_API_BASE =
  Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000';
const MIN_LIKES_FOR_YOU = 3;

interface ThemePalette {
  mode: 'light' | 'dark';
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  chipBg: string;
  badgeSuccessBg: string;
  badgeSuccessText: string;
  youtubeBg: string;
  youtubeText: string;
}

const LIGHT_THEME: ThemePalette = {
  mode: 'light',
  bg: '#FCF8F2',
  surface: '#FFFDF9',
  surfaceRaised: '#F6EDE0',
  border: '#E5D3BC',
  text: '#231710',
  textMuted: '#6A5344',
  accent: '#C45A1A',
  accentText: '#FFFBF7',
  chipBg: '#F1E2CE',
  badgeSuccessBg: '#E4F3EA',
  badgeSuccessText: '#1C5B38',
  youtubeBg: '#B91C1C',
  youtubeText: '#FFFFFF',
};

const DARK_THEME: ThemePalette = {
  mode: 'dark',
  bg: '#131019',
  surface: '#1C1725',
  surfaceRaised: '#261F33',
  border: '#3A2F4D',
  text: '#F7EFE6',
  textMuted: '#B9A99B',
  accent: '#F09B4B',
  accentText: '#1A1109',
  chipBg: '#2F2640',
  badgeSuccessBg: '#193528',
  badgeSuccessText: '#8CE0AE',
  youtubeBg: '#DC2626',
  youtubeText: '#FFFFFF',
};

export default function App() {
  const systemScheme = useColorScheme();
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>(
    systemScheme === 'dark' ? 'dark' : 'light',
  );
  const theme = themeMode === 'dark' ? DARK_THEME : LIGHT_THEME;

  const [activeTab, setActiveTab] = useState<AppTab>('home');
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE);

  // Two-tier cloud index + lazy detail cache
  const [catalogIndex, setCatalogIndex] = useState<CatalogIndexPayload>(() =>
    getBundledCatalogIndex(),
  );
  const [catalogSource, setCatalogSource] = useState<'cloud' | 'bundled'>('bundled');
  const [syncingIndex, setSyncingIndex] = useState(false);
  const [bhajanCache, setBhajanCache] = useState<Record<string, Bhajan>>({});

  // Home + Studio state
  const [homeQuery, setHomeQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDeity, setSelectedDeity] = useState<string>('All');
  const [onlyVerified, setOnlyVerified] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(
    () => getBundledCatalogIndex().entries[0]?.id ?? '',
  );
  const [studioLoadingDetail, setStudioLoadingDetail] = useState(false);
  const [studioDetailFailed, setStudioDetailFailed] = useState(false);
  const [activeScriptIdx, setActiveScriptIdx] = useState(0);
  const [pitchReference, setPitchReference] = useState<'gents' | 'ladies'>('gents');
  const [semitoneDelta, setSemitoneDelta] = useState(0);
  const [activeRecIndex, setActiveRecIndex] = useState(0);

  // Stream, Favorites, & Sticky Audio/Video state
  const [likedIds, setLikedIds] = useState<string[]>([]);
  const [likedRagaFilter, setLikedRagaFilter] = useState('');
  const [streamSessionActive, setStreamSessionActive] = useState(false);
  const [streamMediaMode, setStreamMediaMode] = useState<StreamMediaMode>('audio');
  const [streamAutoPlay, setStreamAutoPlay] = useState(true);
  const [streamMode, setStreamMode] = useState<StreamModeKind>('discovery');
  const [streamDeity, setStreamDeity] = useState<string>('All');
  const [streamRaga, setStreamRaga] = useState<string>('');
  const [streamSeed, setStreamSeed] = useState(1);
  const [streamIdx, setStreamIdx] = useState(0);
  const [streamLoadingDetail, setStreamLoadingDetail] = useState(false);
  const [streamDetailFailed, setStreamDetailFailed] = useState(false);
  const [showStreamLyrics, setShowStreamLyrics] = useState(false);
  const [streamYtPlaying, setStreamYtPlaying] = useState(false);
  const ytStreamRef = useRef<MobileYouTubePlayerHandle>(null);

  // Direct MP3 playback via expo-av (shared cleanly with track URI tracking)
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [audioMessage, setAudioMessage] = useState<string | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const loadedAudioUriRef = useRef<string | null>(null);

  // Correction modal state
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [proposedLyricsText, setProposedLyricsText] = useState('');
  const [reasonOrSource, setReasonOrSource] = useState('');
  const [submitterName, setSubmitterName] = useState('');
  const [submitterEmail, setSubmitterEmail] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [submittingCorrection, setSubmittingCorrection] = useState(false);
  const [correctionFeedback, setCorrectionFeedback] = useState<string | null>(null);

  const unloadAudio = useCallback(async () => {
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    loadedAudioUriRef.current = null;
    setIsAudioPlaying(false);
    setAudioMessage(null);
  }, []);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (activeTab === 'stream') {
      setStreamSessionActive(true);
    }
  }, [activeTab]);

  const refreshCloudCatalog = useCallback(async () => {
    setSyncingIndex(true);
    try {
      const result = await fetchCloudCatalogIndex({ projectId: DEFAULT_FIREBASE_PROJECT_ID });
      if (result.source === 'cloud' && result.payload.entries.length > 0) {
        setCatalogIndex(result.payload);
        setCatalogSource('cloud');
        setBhajanCache({});
        await saveCachedCatalogIndex(result.payload);
      }
    } finally {
      setSyncingIndex(false);
    }
  }, []);

  // Boot AsyncStorage preferences + cloud catalog index
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [storedLikes, storedTheme, storedMediaMode, cachedIndex] = await Promise.all([
        loadStoredLikedIds(),
        loadStoredThemeMode(),
        loadStoredMediaMode(),
        loadCachedCatalogIndex(),
      ]);
      if (cancelled) return;
      if (storedLikes.length > 0) setLikedIds(storedLikes);
      if (storedTheme) setThemeMode(storedTheme);
      if (storedMediaMode) setStreamMediaMode(storedMediaMode);
      if (cachedIndex && cachedIndex.version > 0 && cachedIndex.entries.length > 0) {
        setCatalogIndex(cachedIndex);
        setCatalogSource('cloud');
      }
      await refreshCloudCatalog();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshCloudCatalog]);

  const likedSet = useMemo(
    () => resolveLikedSet(likedIds, catalogIndex.entries),
    [catalogIndex.entries, likedIds],
  );

  const likedEntries = useMemo(
    () => catalogIndex.entries.filter((entry) => likedSet.has(entry.id)),
    [catalogIndex.entries, likedSet],
  );

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

  const deities = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of catalogIndex.entries) {
      const deity = item.deity?.trim();
      if (deity) counts.set(deity, (counts.get(deity) ?? 0) + 1);
    }
    return [
      'All',
      ...Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name]) => name),
    ];
  }, [catalogIndex.entries]);

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

  const homeSearchResults = useMemo(() => {
    if (!homeQuery.trim()) return [];
    return filterBhajanIndexEntries(catalogIndex.entries, { query: homeQuery }).slice(0, 8);
  }, [catalogIndex.entries, homeQuery]);

  const filteredStudioEntries = useMemo(
    () =>
      filterBhajanIndexEntries(catalogIndex.entries, {
        query: searchQuery,
        deity: selectedDeity,
        onlyVerified,
      }),
    [catalogIndex.entries, onlyVerified, searchQuery, selectedDeity],
  );

  const activeStudioEntry = useMemo(
    () =>
      catalogIndex.entries.find((e) => e.id === selectedId) ??
      filteredStudioEntries[0] ??
      catalogIndex.entries[0] ??
      null,
    [catalogIndex.entries, filteredStudioEntries, selectedId],
  );
  const activeStudioBhajan: Bhajan | null = activeStudioEntry
    ? bhajanCache[activeStudioEntry.id] ?? null
    : null;

  const likedIdsRef = useRef(likedIds);
  likedIdsRef.current = likedIds;

  const streamQueue = useMemo(
    () =>
      buildStreamQueue(catalogIndex.entries, {
        mode: streamMode,
        likedIds: likedIdsRef.current,
        deityFilter: streamDeity,
        ragaFilter: streamRaga,
        seed: streamSeed,
      }),
    [catalogIndex.entries, streamDeity, streamMode, streamRaga, streamSeed],
  );

  const safeStreamIdx =
    streamQueue.length > 0 ? Math.min(streamIdx, streamQueue.length - 1) : 0;
  const activeStreamEntry: BhajanIndexEntry | null = streamQueue[safeStreamIdx] ?? null;
  const activeStreamBhajan: Bhajan | null = activeStreamEntry
    ? bhajanCache[activeStreamEntry.id] ?? null
    : null;

  const loadDetailForId = useCallback(
    async (
      id: string,
      setLoading: (v: boolean) => void,
      setFailed: (v: boolean) => void,
    ) => {
      if (!id) return;
      setLoading(true);
      setFailed(false);
      try {
        const doc = await fetchCloudBhajanDetail(id, { projectId: DEFAULT_FIREBASE_PROJECT_ID });
        if (doc) {
          setBhajanCache((prev) => ({ ...prev, [id]: doc, [doc.id]: doc }));
        } else {
          setFailed(true);
        }
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Lazy-fetch Studio detail
  useEffect(() => {
    const id = activeStudioEntry?.id;
    if (!id || bhajanCache[id]) {
      setStudioLoadingDetail(false);
      setStudioDetailFailed(false);
      return;
    }
    void loadDetailForId(id, setStudioLoadingDetail, setStudioDetailFailed);
  }, [activeStudioEntry?.id, bhajanCache, loadDetailForId]);

  // Lazy-fetch Stream detail whenever Stream is open OR minimized dock is active
  useEffect(() => {
    const id = activeStreamEntry?.id;
    if ((activeTab !== 'stream' && !streamSessionActive) || !id || bhajanCache[id]) {
      setStreamLoadingDetail(false);
      setStreamDetailFailed(false);
      return;
    }
    void loadDetailForId(id, setStreamLoadingDetail, setStreamDetailFailed);
  }, [activeStreamEntry?.id, activeTab, bhajanCache, loadDetailForId, streamSessionActive]);

  useEffect(() => {
    setActiveRecIndex(0);
    setSemitoneDelta(0);
    setActiveScriptIdx(0);
  }, [activeStudioEntry?.id]);

  useEffect(() => {
    setShowStreamLyrics(false);
    setStreamYtPlaying(false);
  }, [activeStreamEntry?.id]);

  const handleToggleLike = useCallback((bhajanId: string) => {
    setLikedIds((prev) => {
      const next = prev.includes(bhajanId)
        ? prev.filter((id) => id !== bhajanId)
        : [bhajanId, ...prev];
      void saveStoredLikedIds(next);
      return next;
    });
  }, []);

  const handleToggleTheme = useCallback(() => {
    setThemeMode((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      void saveStoredThemeMode(next);
      return next;
    });
  }, []);

  const handleMediaModeChange = useCallback((next: StreamMediaMode) => {
    setStreamMediaMode(next);
    void saveStoredMediaMode(next);
  }, []);

  const openEntryInStudio = useCallback((bhajanId: string) => {
    setSelectedId(bhajanId);
    setActiveTab('studio');
  }, []);

  const playEntryInStream = useCallback(
    (entry: BhajanIndexEntry) => {
      const existingIdx = streamQueue.findIndex((item) => item.id === entry.id);
      if (existingIdx >= 0) {
        setStreamIdx(existingIdx);
      } else {
        setStreamMode('discovery');
        setStreamDeity('All');
        setStreamRaga('');
        setStreamSeed((s) => s + 1);
      }
      setStreamSessionActive(true);
      setActiveTab('stream');
    },
    [streamQueue],
  );

  const playAudioUri = useCallback(
    async (
      uri: string,
      options: { forceNew?: boolean; onFinish?: () => void } = {},
    ) => {
      if (!options.forceNew && loadedAudioUriRef.current === uri && soundRef.current) {
        if (isAudioPlaying) {
          await soundRef.current.pauseAsync();
          setIsAudioPlaying(false);
        } else {
          await soundRef.current.playAsync();
          setIsAudioPlaying(true);
        }
        return;
      }

      if (soundRef.current) {
        await soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
      loadedAudioUriRef.current = uri;

      try {
        setIsLoadingAudio(true);
        setAudioMessage(null);
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const { sound } = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: true },
          (status: AVPlaybackStatus) => {
            if (status.isLoaded && status.didJustFinish) {
              setIsAudioPlaying(false);
              options.onFinish?.();
            }
          },
        );
        soundRef.current = sound;
        setIsAudioPlaying(true);
      } catch (err) {
        setAudioMessage(
          err instanceof Error
            ? `Audio error (${apiBaseUrl}): ${err.message}`
            : 'Unable to play recording.',
        );
        setIsAudioPlaying(false);
      } finally {
        setIsLoadingAudio(false);
      }
    },
    [apiBaseUrl, isAudioPlaying],
  );

  const studioBasePitch =
    pitchReference === 'gents' ? activeStudioBhajan?.gentsPitch : activeStudioBhajan?.ladiesPitch;
  const studioTransposed = useMemo(
    () => transposePitch(studioBasePitch?.semitoneFromC ?? 2, semitoneDelta),
    [semitoneDelta, studioBasePitch?.semitoneFromC],
  );

  const studioLyricsSet =
    activeStudioBhajan?.lyricsSets[activeScriptIdx] ?? activeStudioBhajan?.lyricsSets[0];
  const studioActiveRecording =
    activeStudioBhajan?.recordings[activeRecIndex] ?? activeStudioBhajan?.recordings[0] ?? null;
  const studioPlayback = useMemo(
    () => resolvePlaybackAction(studioActiveRecording, apiBaseUrl),
    [apiBaseUrl, studioActiveRecording],
  );

  const {
    recording: streamPreferredRec,
    hasAudioOption: streamHasAudioOption,
    hasVideoOption: streamHasVideoOption,
  } = useMemo(
    () => pickStreamRecording(activeStreamBhajan, streamMediaMode),
    [activeStreamBhajan, streamMediaMode],
  );
  const streamPlayback = useMemo(
    () => resolvePlaybackAction(streamPreferredRec, apiBaseUrl),
    [apiBaseUrl, streamPreferredRec],
  );

  const advanceStream = useCallback(
    (delta: number) => {
      setStreamIdx((idx) =>
        streamQueue.length > 0 ? (idx + delta + streamQueue.length) % streamQueue.length : 0,
      );
    },
    [streamQueue.length],
  );

  // Auto-play direct audio streams (`expo-av`) when active in Stream / minimized bar
  const advanceRef = useRef(advanceStream);
  advanceRef.current = advanceStream;
  useEffect(() => {
    if (!streamSessionActive || !activeStreamEntry) {
      return;
    }
    if (streamPlayback.kind === 'audio') {
      if (loadedAudioUriRef.current !== streamPlayback.uri && streamAutoPlay) {
        void playAudioUri(streamPlayback.uri, {
          forceNew: true,
          onFinish: () => {
            if (streamAutoPlay) advanceRef.current(1);
          },
        });
      }
    } else if (loadedAudioUriRef.current) {
      // Track switched from MP3 to YouTube -> unload old expo-av audio cleanly
      void unloadAudio();
    }
  }, [
    activeStreamEntry,
    playAudioUri,
    streamAutoPlay,
    streamPlayback,
    streamSessionActive,
    unloadAudio,
  ]);

  const handleToggleStreamPlayPause = useCallback(() => {
    if (streamPlayback.kind === 'youtube') {
      ytStreamRef.current?.togglePlay();
    } else if (streamPlayback.kind === 'audio') {
      void playAudioUri(streamPlayback.uri);
    }
  }, [playAudioUri, streamPlayback]);

  const handleDismissStream = useCallback(() => {
    setStreamSessionActive(false);
    setStreamYtPlaying(false);
    void unloadAudio();
  }, [unloadAudio]);

  function openCorrectionModal() {
    setProposedLyricsText((studioLyricsSet?.lines ?? []).join('\n'));
    setReasonOrSource('');
    setCorrectionFeedback(null);
    setCorrectionOpen(true);
  }

  async function submitCorrection() {
    if (!activeStudioEntry) return;
    const lines = proposedLyricsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (
      (lines.length === 0 && !activeStudioBhajan?.lyricsMissing) ||
      !reasonOrSource.trim() ||
      !submitterName.trim() ||
      !submitterEmail.trim()
    ) {
      setCorrectionFeedback('Please complete source/reason, your name, and email.');
      return;
    }

    try {
      setSubmittingCorrection(true);
      setCorrectionFeedback(null);
      const cleanBase = apiBaseUrl.replace(/\/+$/, '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken.trim()) {
        headers.Authorization = `Bearer ${authToken.trim()}`;
      }
      const res = await fetch(`${cleanBase}/api/corrections`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          bhajanId: activeStudioEntry.id,
          bhajanTitle: activeStudioEntry.title,
          script: studioLyricsSet?.language ?? 'Roman',
          originalLyrics: studioLyricsSet?.lines ?? [],
          proposedLyrics: lines,
          reasonOrSource: reasonOrSource.trim(),
          submitterName: submitterName.trim(),
          submitterEmail: submitterEmail.trim(),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      setCorrectionFeedback('Submitted! Queued for moderator review.');
      setTimeout(() => setCorrectionOpen(false), 1200);
    } catch (err) {
      setCorrectionFeedback(
        err instanceof Error ? `Submit failed: ${err.message}` : 'Unable to submit correction.',
      );
    } finally {
      setSubmittingCorrection(false);
    }
  }

  function renderRecommendationCard(rec: BhajanRecommendation) {
    const liked = likedSet.has(rec.entry.id);
    return (
      <View
        key={rec.entry.id}
        style={[styles.recCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
      >
        <View style={styles.chipWrap}>
          {rec.reasons.slice(0, 2).map((reason) => (
            <View
              key={reason}
              style={[styles.badge, { backgroundColor: theme.badgeSuccessBg }]}
            >
              <Text style={[styles.badgeText, { color: theme.badgeSuccessText }]}>{reason}</Text>
            </View>
          ))}
        </View>
        <Text style={[styles.listTitle, { color: theme.text }]}>{rec.entry.title}</Text>
        <Text style={[styles.listMeta, { color: theme.textMuted }]}>
          {[rec.entry.deity, rec.entry.ragaName, rec.entry.beat, `${rec.entry.recordingCount} audio`]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        <View style={styles.recActionsRow}>
          <Pressable
            onPress={() => playEntryInStream(rec.entry)}
            style={[styles.smallBtn, { backgroundColor: theme.accent }]}
          >
            <Text style={[styles.smallBtnText, { color: theme.accentText }]}>Stream</Text>
          </Pressable>
          <Pressable
            onPress={() => handleToggleLike(rec.entry.id)}
            style={[
              styles.smallBtn,
              {
                borderWidth: 1,
                borderColor: liked ? theme.accent : theme.border,
                backgroundColor: theme.surfaceRaised,
              },
            ]}
          >
            <Text style={[styles.smallBtnText, { color: liked ? theme.accent : theme.text }]}>
              {liked ? '♥ Liked' : '♡ Like'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => openEntryInStudio(rec.entry.id)}
            style={[
              styles.smallBtn,
              {
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surfaceRaised,
              },
            ]}
          >
            <Text style={[styles.smallBtnText, { color: theme.text }]}>Studio</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const streamIsMinimized = activeTab !== 'stream';
  const showPersistentStream = streamSessionActive && Boolean(activeStreamEntry);
  const effectiveStreamPlaying =
    streamPlayback.kind === 'youtube' ? streamYtPlaying : isAudioPlaying;
  const activeStreamLiked = activeStreamEntry ? likedSet.has(activeStreamEntry.id) : false;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
      <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />

      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: theme.surface, borderBottomColor: theme.border },
        ]}
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.brandTitle, { color: theme.text }]}>bhaJami · भजामि</Text>
          <Text style={[styles.brandSubtitle, { color: theme.textMuted }]}>
            {catalogSource === 'cloud' ? `Cloud v${catalogIndex.version}` : 'Offline Cache'} ·{' '}
            {catalogIndex.stats.totalBhajans} Bhajans ·{' '}
            {catalogIndex.stats.verifiedSaiRhythmsCount} Sai Rhythms
          </Text>
        </View>
        <Pressable
          onPress={() => void refreshCloudCatalog()}
          disabled={syncingIndex}
          style={[
            styles.modeButton,
            { backgroundColor: theme.surfaceRaised, borderColor: theme.border },
          ]}
        >
          <Text style={[styles.modeButtonText, { color: theme.text }]}>
            {syncingIndex ? 'Syncing...' : 'Sync'}
          </Text>
        </Pressable>
        <Pressable
          onPress={handleToggleTheme}
          style={[
            styles.modeButton,
            { backgroundColor: theme.surfaceRaised, borderColor: theme.border },
          ]}
        >
          <Text style={[styles.modeButtonText, { color: theme.text }]}>
            {theme.mode === 'light' ? 'Dark' : 'Light'}
          </Text>
        </Pressable>
      </View>

      {/* Main Content + Single Persistent Stream Player Slot (reordered visually on Stream tab without unmounting!) */}
      <View
        style={{
          flex: 1,
          flexDirection: activeTab === 'stream' ? 'column-reverse' : 'column',
        }}
      >
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.container}>
          {/* HOME TAB */}
          {activeTab === 'home' && (
            <View style={styles.sectionStack}>
              <View
                style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                <Text style={[styles.heroTitle, { color: theme.text }]}>
                  Your Sathya Sai Bhajans Companion
                </Text>
                <Text style={[styles.metaLine, { color: theme.textMuted }]}>
                  Listen continuously in Data Saver Audio or Video mode, curate favorites with ♥, and
                  explore multi-script Studio sheets.
                </Text>

                <View style={styles.heroActions}>
                  <Pressable
                    onPress={() => {
                      setStreamMode('discovery');
                      setStreamSeed((s) => s + 1);
                      setStreamSessionActive(true);
                      setActiveTab('stream');
                    }}
                    style={[styles.playBtn, { backgroundColor: theme.accent }]}
                  >
                    <Text style={[styles.playBtnText, { color: theme.accentText }]}>
                      ▶ Start Random Stream
                    </Text>
                  </Pressable>

                  {canShowForYou && (
                    <Pressable
                      onPress={() => {
                        setStreamMode('for_you');
                        setStreamSeed((s) => s + 1);
                        setStreamSessionActive(true);
                        setActiveTab('stream');
                      }}
                      style={[styles.playBtn, { backgroundColor: theme.badgeSuccessText }]}
                    >
                      <Text style={[styles.playBtnText, { color: '#FFFFFF' }]}>✨ For You</Text>
                    </Pressable>
                  )}

                  <Pressable
                    onPress={() => setActiveTab('studio')}
                    style={[
                      styles.secondaryBtn,
                      { borderColor: theme.border, backgroundColor: theme.surfaceRaised },
                    ]}
                  >
                    <Text style={[styles.secondaryBtnText, { color: theme.text }]}>
                      Open Studio
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setActiveTab('liked')}
                    style={[
                      styles.secondaryBtn,
                      { borderColor: theme.border, backgroundColor: theme.surfaceRaised },
                    ]}
                  >
                    <Text style={[styles.secondaryBtnText, { color: theme.text }]}>
                      ♥ Liked ({likedEntries.length})
                    </Text>
                  </Pressable>
                </View>

                <TextInput
                  value={homeQuery}
                  onChangeText={setHomeQuery}
                  placeholder="Phonetic quick search: Vittala, Narayana, Bowli..."
                  placeholderTextColor={theme.textMuted}
                  style={[
                    styles.searchInput,
                    { backgroundColor: theme.bg, borderColor: theme.border, color: theme.text },
                  ]}
                />

                {homeSearchResults.length > 0 && (
                  <View style={styles.sectionStack}>
                    {homeSearchResults.map((entry) => {
                      const liked = likedSet.has(entry.id);
                      return (
                        <View
                          key={entry.id}
                          style={[
                            styles.recCard,
                            { backgroundColor: theme.bg, borderColor: theme.border },
                          ]}
                        >
                          <Text style={[styles.listTitle, { color: theme.text }]}>{entry.title}</Text>
                          <Text style={[styles.listMeta, { color: theme.textMuted }]}>
                            {[entry.deity, entry.ragaName, `${entry.recordingCount} audio`]
                              .filter(Boolean)
                              .join(' · ')}
                          </Text>
                          <View style={styles.recActionsRow}>
                            <Pressable
                              onPress={() => playEntryInStream(entry)}
                              style={[styles.smallBtn, { backgroundColor: theme.accent }]}
                            >
                              <Text style={[styles.smallBtnText, { color: theme.accentText }]}>
                                Stream
                              </Text>
                            </Pressable>
                            <Pressable
                              onPress={() => handleToggleLike(entry.id)}
                              style={[
                                styles.smallBtn,
                                {
                                  borderWidth: 1,
                                  borderColor: theme.border,
                                  backgroundColor: theme.surfaceRaised,
                                },
                              ]}
                            >
                              <Text style={[styles.smallBtnText, { color: theme.text }]}>
                                {liked ? '♥ Liked' : '♡ Like'}
                              </Text>
                            </Pressable>
                            <Pressable
                              onPress={() => openEntryInStudio(entry.id)}
                              style={[
                                styles.smallBtn,
                                {
                                  borderWidth: 1,
                                  borderColor: theme.border,
                                  backgroundColor: theme.surfaceRaised,
                                },
                              ]}
                            >
                              <Text style={[styles.smallBtnText, { color: theme.text }]}>
                                Studio
                              </Text>
                            </Pressable>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>

              {ragaShelves.map((shelf) => (
                <View key={shelf.ragaName} style={styles.sectionStack}>
                  <View style={styles.sectionHeaderRow}>
                    <Text style={[styles.sectionHeading, { color: theme.text }]}>
                      Because You Liked Raga {shelf.ragaName}
                    </Text>
                    <Pressable
                      onPress={() => {
                        setStreamRaga(shelf.ragaName);
                        setStreamDeity('All');
                        setStreamMode('discovery');
                        setStreamSeed((s) => s + 1);
                        setStreamSessionActive(true);
                        setActiveTab('stream');
                      }}
                      style={[
                        styles.smallBtn,
                        {
                          borderWidth: 1,
                          borderColor: theme.border,
                          backgroundColor: theme.surface,
                        },
                      ]}
                    >
                      <Text style={[styles.smallBtnText, { color: theme.text }]}>Stream Raga</Text>
                    </Pressable>
                  </View>
                  {shelf.items.slice(0, 4).map(renderRecommendationCard)}
                </View>
              ))}

              <View style={styles.sectionStack}>
                <Text style={[styles.sectionHeading, { color: theme.text }]}>
                  {likedEntries.length > 0
                    ? 'Recommended Based on Your Likes'
                    : 'Featured Verified Bhajans'}
                </Text>
                {similarRecs.slice(0, 6).map(renderRecommendationCard)}
              </View>
            </View>
          )}

          {/* STREAM CONTROLS + LYRICS + UP NEXT (scrolled below the persistent active Stream Player) */}
          {activeTab === 'stream' && (
            <View style={styles.sectionStack}>
              <View
                style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                <View style={styles.heroActions}>
                  <Pressable
                    onPress={() => setStreamMode('discovery')}
                    style={[
                      styles.smallBtn,
                      {
                        backgroundColor:
                          streamMode === 'discovery' ? theme.accent : theme.surfaceRaised,
                        borderWidth: 1,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.smallBtnText,
                        { color: streamMode === 'discovery' ? theme.accentText : theme.text },
                      ]}
                    >
                      Random Stream
                    </Text>
                  </Pressable>
                  {canShowForYou && (
                    <Pressable
                      onPress={() => setStreamMode('for_you')}
                      style={[
                        styles.smallBtn,
                        {
                          backgroundColor:
                            streamMode === 'for_you' ? theme.accent : theme.surfaceRaised,
                          borderWidth: 1,
                          borderColor: theme.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.smallBtnText,
                          { color: streamMode === 'for_you' ? theme.accentText : theme.text },
                        ]}
                      >
                        For You
                      </Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => setStreamMode('liked_only')}
                    style={[
                      styles.smallBtn,
                      {
                        backgroundColor:
                          streamMode === 'liked_only' ? theme.accent : theme.surfaceRaised,
                        borderWidth: 1,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.smallBtnText,
                        { color: streamMode === 'liked_only' ? theme.accentText : theme.text },
                      ]}
                    >
                      Liked Radio ({likedSet.size})
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() =>
                      handleMediaModeChange(streamMediaMode === 'audio' ? 'video' : 'audio')
                    }
                    style={[
                      styles.smallBtn,
                      {
                        backgroundColor:
                          streamMediaMode === 'audio'
                            ? theme.badgeSuccessBg
                            : theme.surfaceRaised,
                        borderWidth: 1,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.smallBtnText,
                        {
                          color:
                            streamMediaMode === 'audio' ? theme.badgeSuccessText : theme.text,
                        },
                      ]}
                    >
                      Mode: {streamMediaMode === 'audio' ? 'Audio Saver' : 'Video'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setStreamAutoPlay((v) => !v)}
                    style={[
                      styles.smallBtn,
                      {
                        backgroundColor: streamAutoPlay ? theme.accent : theme.surfaceRaised,
                        borderWidth: 1,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.smallBtnText,
                        { color: streamAutoPlay ? theme.accentText : theme.text },
                      ]}
                    >
                      {streamAutoPlay ? 'Auto: ON' : 'Auto: OFF'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setStreamSeed((s) => s + 1)}
                    style={[
                      styles.smallBtn,
                      { borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bg },
                    ]}
                  >
                    <Text style={[styles.smallBtnText, { color: theme.text }]}>Reshuffle</Text>
                  </Pressable>
                </View>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.chipsRow}
                >
                  {deities.map((deity) => (
                    <Pressable
                      key={deity}
                      onPress={() => setStreamDeity(deity)}
                      style={[
                        styles.chip,
                        { backgroundColor: streamDeity === deity ? theme.accent : theme.chipBg },
                      ]}
                    >
                      <Text
                        style={{
                          color: streamDeity === deity ? theme.accentText : theme.text,
                          fontSize: 12,
                          fontWeight: '600',
                        }}
                      >
                        {deity}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>

                {availableRagas.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.chipsRow}
                  >
                    <Pressable
                      onPress={() => setStreamRaga('')}
                      style={[
                        styles.chip,
                        { backgroundColor: streamRaga === '' ? theme.accent : theme.chipBg },
                      ]}
                    >
                      <Text
                        style={{
                          color: streamRaga === '' ? theme.accentText : theme.text,
                          fontSize: 12,
                          fontWeight: '600',
                        }}
                      >
                        All Ragas
                      </Text>
                    </Pressable>
                    {availableRagas.slice(0, 15).map((raga) => (
                      <Pressable
                        key={raga}
                        onPress={() => setStreamRaga(raga)}
                        style={[
                          styles.chip,
                          { backgroundColor: streamRaga === raga ? theme.accent : theme.chipBg },
                        ]}
                      >
                        <Text
                          style={{
                            color: streamRaga === raga ? theme.accentText : theme.text,
                            fontSize: 12,
                            fontWeight: '600',
                          }}
                        >
                          {raga}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                )}

                {activeStreamBhajan?.lyricsSets?.[0]?.lines?.length ? (
                  <View>
                    <Pressable onPress={() => setShowStreamLyrics((v) => !v)}>
                      <Text
                        style={[styles.smallBtnText, { color: theme.accent, paddingVertical: 4 }]}
                      >
                        {showStreamLyrics ? '▼ Hide Lyrics' : '▶ Show Lyrics'} (
                        {activeStreamBhajan.lyricsSets[0].language})
                      </Text>
                    </Pressable>
                    {showStreamLyrics && (
                      <View style={styles.lyricsBox}>
                        {activeStreamBhajan.lyricsSets[0].lines.map((line, i) => (
                          <Text
                            key={`${activeStreamBhajan.id}-sl-${i}`}
                            style={[styles.lyricLine, { color: theme.text }]}
                          >
                            {line}
                          </Text>
                        ))}
                      </View>
                    )}
                  </View>
                ) : null}

                {!activeStreamEntry && (
                  <Text style={[styles.metaLine, { color: theme.textMuted }]}>
                    {streamMode === 'liked_only'
                      ? 'Tap ♥ Like on any bhajan first to listen to your Liked Radio.'
                      : 'No playable bhajans match your current Deity/Raga filters.'}
                  </Text>
                )}
              </View>

              {streamQueue.length > 1 && (
                <View style={styles.sectionStack}>
                  <Text style={[styles.sectionHeading, { color: theme.text }]}>
                    Up Next in Stream
                  </Text>
                  {streamQueue
                    .slice(safeStreamIdx + 1, safeStreamIdx + 7)
                    .map((item, offset) => (
                      <Pressable
                        key={`${item.id}-${offset}`}
                        onPress={() => setStreamIdx(safeStreamIdx + 1 + offset)}
                        style={[
                          styles.listRow,
                          { backgroundColor: theme.surface, borderColor: theme.border },
                        ]}
                      >
                        <Text style={[styles.listTitle, { color: theme.text }]}>{item.title}</Text>
                        <Text style={[styles.listMeta, { color: theme.textMuted }]}>
                          {[item.deity, item.ragaName].filter(Boolean).join(' · ') || 'Audio Linked'}
                        </Text>
                      </Pressable>
                    ))}
                </View>
              )}
            </View>
          )}

          {/* STUDIO TAB */}
          {activeTab === 'studio' && (
            <View style={styles.sectionStack}>
              {activeStudioEntry && (
                <View
                  style={[
                    styles.card,
                    { backgroundColor: theme.surface, borderColor: theme.border },
                  ]}
                >
                  <View style={styles.cardTopRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.bhajanTitle, { color: theme.text }]}>
                        {activeStudioBhajan?.title || activeStudioEntry.title}
                      </Text>
                      <Text style={[styles.metaLine, { color: theme.textMuted }]}>
                        {[
                          activeStudioBhajan?.deity ?? activeStudioEntry.deity ?? 'Devotional',
                          activeStudioBhajan?.raga?.name ??
                            activeStudioEntry.ragaName ??
                            'Raga Unspecified',
                          activeStudioBhajan?.beat ?? activeStudioEntry.beat,
                          activeStudioBhajan?.tempo,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => handleToggleLike(activeStudioEntry.id)}
                      style={[
                        styles.smallBtn,
                        {
                          borderWidth: 1,
                          borderColor: likedSet.has(activeStudioEntry.id)
                            ? theme.accent
                            : theme.border,
                          backgroundColor: theme.surfaceRaised,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.smallBtnText,
                          {
                            color: likedSet.has(activeStudioEntry.id) ? theme.accent : theme.text,
                          },
                        ]}
                      >
                        {likedSet.has(activeStudioEntry.id) ? '♥' : '♡'}
                      </Text>
                    </Pressable>
                  </View>

                  <View style={styles.chipWrap}>
                    {(() => {
                      const srcBadge = formatMetadataSourceBadge(
                        activeStudioBhajan?.metadataSource ?? activeStudioEntry.metadataSource,
                      );
                      return (
                        <View
                          style={[
                            styles.badge,
                            {
                              backgroundColor: srcBadge.verified
                                ? theme.badgeSuccessBg
                                : theme.chipBg,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.badgeText,
                              {
                                color: srcBadge.verified ? theme.badgeSuccessText : theme.text,
                              },
                            ]}
                          >
                            {srcBadge.label}
                          </Text>
                        </View>
                      );
                    })()}
                    {activeStudioEntry.missingFields.length > 0 && (
                      <View style={[styles.badge, { backgroundColor: theme.chipBg }]}>
                        <Text style={[styles.badgeText, { color: theme.textMuted }]}>
                          Needs {activeStudioEntry.missingFields.length} fields
                        </Text>
                      </View>
                    )}
                  </View>

                  {studioLoadingDetail && !activeStudioBhajan ? (
                    <View style={styles.inlineRow}>
                      <ActivityIndicator color={theme.accent} />
                      <Text style={[styles.statusText, { color: theme.textMuted }]}>
                        Loading cloud details…
                      </Text>
                    </View>
                  ) : studioDetailFailed && !activeStudioBhajan ? (
                    <View style={styles.inlineRow}>
                      <Text style={[styles.statusText, { color: theme.textMuted }]}>
                        Unable to fetch full detail.
                      </Text>
                      <Pressable
                        onPress={() =>
                          void loadDetailForId(
                            activeStudioEntry.id,
                            setStudioLoadingDetail,
                            setStudioDetailFailed,
                          )
                        }
                        style={[
                          styles.smallBtn,
                          { borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bg },
                        ]}
                      >
                        <Text style={[styles.smallBtnText, { color: theme.text }]}>Retry</Text>
                      </Pressable>
                    </View>
                  ) : null}

                  {/* Nullable-safe Pitch Transposer */}
                  <View
                    style={[
                      styles.pitchBox,
                      { backgroundColor: theme.surfaceRaised, borderColor: theme.border },
                    ]}
                  >
                    <View style={styles.pitchHeaderRow}>
                      <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>
                        KEY &amp; SHRUTI TRANSPOSER
                      </Text>
                      <View style={styles.refSwitch}>
                        {(['gents', 'ladies'] as const).map((refKey) => {
                          const active = pitchReference === refKey;
                          return (
                            <Pressable
                              key={refKey}
                              onPress={() => setPitchReference(refKey)}
                              style={[
                                styles.refPill,
                                { backgroundColor: active ? theme.accent : theme.chipBg },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.refPillText,
                                  { color: active ? theme.accentText : theme.text },
                                ]}
                              >
                                {refKey === 'gents' ? 'Gents' : 'Ladies'}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>

                    <View style={styles.transposeControls}>
                      <Pressable
                        onPress={() => setSemitoneDelta((d) => Math.max(-6, d - 1))}
                        style={[
                          styles.stepBtn,
                          { borderColor: theme.border, backgroundColor: theme.surface },
                        ]}
                      >
                        <Text style={[styles.stepBtnText, { color: theme.text }]}>−1 st</Text>
                      </Pressable>
                      <View style={styles.pitchReadout}>
                        <Text style={[styles.pitchValue, { color: theme.text }]}>
                          {studioTransposed.pancham} ({studioTransposed.western})
                        </Text>
                        <Text style={[styles.pitchSub, { color: theme.textMuted }]}>
                          {studioTransposed.freqHz.toFixed(1)} Hz · {studioTransposed.deltaLabel}
                          {!studioBasePitch ? ' · Default ref (D)' : ''}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => setSemitoneDelta((d) => Math.min(6, d + 1))}
                        style={[
                          styles.stepBtn,
                          { borderColor: theme.border, backgroundColor: theme.surface },
                        ]}
                      >
                        <Text style={[styles.stepBtnText, { color: theme.text }]}>+1 st</Text>
                      </Pressable>
                    </View>
                  </View>

                  {/* Recording Vault */}
                  {activeStudioBhajan?.recordings.length ? (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.chipsRow}
                    >
                      {activeStudioBhajan.recordings.map((rec, idx) => (
                        <Pressable
                          key={rec.id}
                          onPress={() => {
                            setActiveRecIndex(idx);
                            void unloadAudio();
                          }}
                          style={[
                            styles.chip,
                            {
                              backgroundColor: idx === activeRecIndex ? theme.accent : theme.chipBg,
                            },
                          ]}
                        >
                          <Text
                            style={{
                              color: idx === activeRecIndex ? theme.accentText : theme.text,
                              fontSize: 12,
                              fontWeight: '600',
                            }}
                          >
                            {rec.label}
                          </Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                  ) : null}

                  {studioPlayback.kind === 'youtube' ? (
                    <View style={styles.sectionStack}>
                      <MobileYouTubePlayer
                        videoId={studioPlayback.videoId}
                        title={studioActiveRecording?.label || activeStudioEntry.title}
                        startSec={studioActiveRecording?.startSec}
                        endSec={studioActiveRecording?.endSec}
                        embeddable={studioPlayback.embeddable}
                        autoPlay={false}
                        mediaMode={streamMediaMode}
                        onMediaModeChange={handleMediaModeChange}
                        theme={theme}
                      />
                    </View>
                  ) : studioPlayback.kind === 'audio' ? (
                    <View style={styles.playerRow}>
                      <Pressable
                        onPress={() => {
                          if (streamSessionActive) setStreamSessionActive(false);
                          void playAudioUri(studioPlayback.uri);
                        }}
                        style={[styles.playBtn, { backgroundColor: theme.accent }]}
                      >
                        {isLoadingAudio ? (
                          <ActivityIndicator color={theme.accentText} />
                        ) : (
                          <Text style={[styles.playBtnText, { color: theme.accentText }]}>
                            {isAudioPlaying && loadedAudioUriRef.current === studioPlayback.uri
                              ? 'Pause Jam Track'
                              : 'Play Jam Track'}
                          </Text>
                        )}
                      </Pressable>
                    </View>
                  ) : (
                    <Text style={[styles.statusText, { color: theme.textMuted }]}>
                      {studioPlayback.reason}
                    </Text>
                  )}

                  <View style={styles.playerRow}>
                    <Pressable
                      onPress={openCorrectionModal}
                      style={[
                        styles.secondaryBtn,
                        { borderColor: theme.border, backgroundColor: theme.surfaceRaised },
                      ]}
                    >
                      <Text style={[styles.secondaryBtnText, { color: theme.text }]}>
                        {activeStudioBhajan?.lyricsMissing
                          ? 'Add Lyrics / Metadata'
                          : 'Suggest Edit'}
                      </Text>
                    </Pressable>
                  </View>

                  {audioMessage ? (
                    <Text style={[styles.statusText, { color: theme.textMuted }]}>
                      {audioMessage}
                    </Text>
                  ) : null}

                  {/* Multi-Script Lyrics */}
                  <View style={styles.lyricsBox}>
                    <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>LYRICS</Text>
                    {(activeStudioBhajan?.lyricsSets.length ?? 0) > 1 && (
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={styles.chipsRow}
                      >
                        {activeStudioBhajan?.lyricsSets.map((ls, idx) => (
                          <Pressable
                            key={`${ls.language}-${idx}`}
                            onPress={() => setActiveScriptIdx(idx)}
                            style={[
                              styles.chip,
                              {
                                backgroundColor:
                                  idx === activeScriptIdx ? theme.accent : theme.chipBg,
                              },
                            ]}
                          >
                            <Text
                              style={{
                                color: idx === activeScriptIdx ? theme.accentText : theme.text,
                                fontSize: 12,
                                fontWeight: '600',
                              }}
                            >
                              {ls.language}
                            </Text>
                          </Pressable>
                        ))}
                      </ScrollView>
                    )}
                    {studioLyricsSet?.lines?.length ? (
                      studioLyricsSet.lines.map((line, i) => (
                        <Text
                          key={`${activeStudioEntry.id}-line-${i}`}
                          style={[styles.lyricLine, { color: theme.text }]}
                        >
                          {line}
                        </Text>
                      ))
                    ) : (
                      <Text style={[styles.metaLine, { color: theme.textMuted }]}>
                        Lyrics are not yet populated for this bhajan. Tap “Add Lyrics / Metadata” to
                        contribute.
                      </Text>
                    )}
                  </View>

                  {/* Raga, Notation & Meaning */}
                  {(activeStudioBhajan?.raga?.arohanam ||
                    activeStudioBhajan?.firstLineNotes?.sargam ||
                    activeStudioBhajan?.meaning ||
                    (activeStudioBhajan?.glossary.length ?? 0) > 0) && (
                    <View
                      style={[
                        styles.pitchBox,
                        { backgroundColor: theme.surfaceRaised, borderColor: theme.border },
                      ]}
                    >
                      <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>
                        RAGA, NOTATION &amp; MEANING
                      </Text>
                      {activeStudioBhajan?.raga?.arohanam ? (
                        <Text style={[styles.metaLine, { color: theme.text }]}>
                          Arohanam: {activeStudioBhajan.raga.arohanam}
                        </Text>
                      ) : null}
                      {activeStudioBhajan?.raga?.avarohanam ? (
                        <Text style={[styles.metaLine, { color: theme.text }]}>
                          Avarohanam: {activeStudioBhajan.raga.avarohanam}
                        </Text>
                      ) : null}
                      {activeStudioBhajan?.firstLineNotes?.sargam ? (
                        <Text style={[styles.metaLine, { color: theme.text }]}>
                          Sargam: {activeStudioBhajan.firstLineNotes.sargam}
                        </Text>
                      ) : null}
                      {activeStudioBhajan?.firstLineNotes?.westernInC ? (
                        <Text style={[styles.metaLine, { color: theme.text }]}>
                          Western (C): {activeStudioBhajan.firstLineNotes.westernInC}
                        </Text>
                      ) : null}
                      {activeStudioBhajan?.meaning ? (
                        <Text style={[styles.metaLine, { color: theme.text }]}>
                          Meaning: {activeStudioBhajan.meaning}
                        </Text>
                      ) : null}
                      {activeStudioBhajan?.glossary.slice(0, 6).map((g) => (
                        <Text key={g.term} style={[styles.listMeta, { color: theme.textMuted }]}>
                          • {g.term}: {g.description}
                        </Text>
                      ))}
                    </View>
                  )}
                </View>
              )}

              {/* Searchable Catalog Browser */}
              <View style={styles.catalogSection}>
                <Text style={[styles.sectionHeading, { color: theme.text }]}>
                  Browse Catalog ({filteredStudioEntries.length})
                </Text>
                <TextInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Phonetic search: Vittala, Narayana, Bowli, Ganesha..."
                  placeholderTextColor={theme.textMuted}
                  style={[
                    styles.searchInput,
                    { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text },
                  ]}
                />
                <Pressable
                  onPress={() => setOnlyVerified((v) => !v)}
                  style={[
                    styles.smallBtn,
                    {
                      alignSelf: 'flex-start',
                      borderWidth: 1,
                      borderColor: onlyVerified ? theme.accent : theme.border,
                      backgroundColor: onlyVerified ? theme.accent : theme.surface,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.smallBtnText,
                      { color: onlyVerified ? theme.accentText : theme.text },
                    ]}
                  >
                    {onlyVerified ? '✓ Sai Rhythms Only' : 'Filter: Sai Rhythms Only'}
                  </Text>
                </Pressable>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.chipsRow}
                >
                  {deities.map((deity) => (
                    <Pressable
                      key={deity}
                      onPress={() => setSelectedDeity(deity)}
                      style={[
                        styles.chip,
                        { backgroundColor: selectedDeity === deity ? theme.accent : theme.chipBg },
                      ]}
                    >
                      <Text
                        style={{
                          color: selectedDeity === deity ? theme.accentText : theme.text,
                          fontSize: 12,
                          fontWeight: '600',
                        }}
                      >
                        {deity}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>

                <FlatList
                  data={filteredStudioEntries.slice(0, 60)}
                  keyExtractor={(item) => item.id}
                  scrollEnabled={false}
                  renderItem={({ item }) => {
                    const active = item.id === activeStudioEntry?.id;
                    return (
                      <Pressable
                        onPress={() => openEntryInStudio(item.id)}
                        style={[
                          styles.listRow,
                          {
                            backgroundColor: active ? theme.surfaceRaised : theme.surface,
                            borderColor: active ? theme.accent : theme.border,
                          },
                        ]}
                      >
                        <Text style={[styles.listTitle, { color: theme.text }]}>{item.title}</Text>
                        <Text style={[styles.listMeta, { color: theme.textMuted }]}>
                          {[
                            item.deity,
                            item.ragaName,
                            `${item.recordingCount} audio`,
                            item.metadataSource === 'sairhythms_verified' ? 'Verified' : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      </Pressable>
                    );
                  }}
                />
              </View>
            </View>
          )}

          {/* LIKED TAB */}
          {activeTab === 'liked' && (
            <View style={styles.sectionStack}>
              <View
                style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                <Text style={[styles.heroTitle, { color: theme.text }]}>
                  Your Liked Bhajans ({likedEntries.length})
                </Text>
                <Text style={[styles.metaLine, { color: theme.textMuted }]}>
                  Saved automatically on your device across restarts.
                </Text>
                {likedEntries.length > 0 && (
                  <View style={styles.heroActions}>
                    <Pressable
                      onPress={() => {
                        setStreamMode('liked_only');
                        setStreamSeed((s) => s + 1);
                        setStreamSessionActive(true);
                        setActiveTab('stream');
                      }}
                      style={[styles.playBtn, { backgroundColor: theme.accent }]}
                    >
                      <Text style={[styles.playBtnText, { color: theme.accentText }]}>
                        ▶ Stream Liked Radio
                      </Text>
                    </Pressable>
                  </View>
                )}

                {likedRagaChips.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.chipsRow}
                  >
                    <Pressable
                      onPress={() => setLikedRagaFilter('')}
                      style={[
                        styles.chip,
                        { backgroundColor: likedRagaFilter === '' ? theme.accent : theme.chipBg },
                      ]}
                    >
                      <Text
                        style={{
                          color: likedRagaFilter === '' ? theme.accentText : theme.text,
                          fontSize: 12,
                          fontWeight: '600',
                        }}
                      >
                        All Ragas ({likedEntries.length})
                      </Text>
                    </Pressable>
                    {likedRagaChips.map((raga) => (
                      <Pressable
                        key={raga}
                        onPress={() => setLikedRagaFilter(raga)}
                        style={[
                          styles.chip,
                          {
                            backgroundColor: likedRagaFilter === raga ? theme.accent : theme.chipBg,
                          },
                        ]}
                      >
                        <Text
                          style={{
                            color: likedRagaFilter === raga ? theme.accentText : theme.text,
                            fontSize: 12,
                            fontWeight: '600',
                          }}
                        >
                          {raga}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                )}

                {filteredLikedEntries.length > 0 ? (
                  filteredLikedEntries.map((entry) => (
                    <View
                      key={entry.id}
                      style={[
                        styles.recCard,
                        { backgroundColor: theme.bg, borderColor: theme.border },
                      ]}
                    >
                      <Text style={[styles.listTitle, { color: theme.text }]}>{entry.title}</Text>
                      <Text style={[styles.listMeta, { color: theme.textMuted }]}>
                        {[entry.deity, entry.ragaName, `${entry.recordingCount} audio`]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                      <View style={styles.recActionsRow}>
                        <Pressable
                          onPress={() => playEntryInStream(entry)}
                          style={[styles.smallBtn, { backgroundColor: theme.accent }]}
                        >
                          <Text style={[styles.smallBtnText, { color: theme.accentText }]}>
                            Stream
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => openEntryInStudio(entry.id)}
                          style={[
                            styles.smallBtn,
                            {
                              borderWidth: 1,
                              borderColor: theme.border,
                              backgroundColor: theme.surfaceRaised,
                            },
                          ]}
                        >
                          <Text style={[styles.smallBtnText, { color: theme.text }]}>Studio</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => handleToggleLike(entry.id)}
                          style={[
                            styles.smallBtn,
                            {
                              borderWidth: 1,
                              borderColor: theme.accent,
                              backgroundColor: theme.surfaceRaised,
                            },
                          ]}
                        >
                          <Text style={[styles.smallBtnText, { color: theme.accent }]}>
                            ♥ Remove
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  ))
                ) : (
                  <Text style={[styles.metaLine, { color: theme.textMuted }]}>
                    No liked bhajans yet. Start Random Stream or browse Studio and tap ♡ Like!
                  </Text>
                )}
              </View>

              {likedEntries.length > 0 && similarRecs.length > 0 && (
                <View style={styles.sectionStack}>
                  <Text style={[styles.sectionHeading, { color: theme.text }]}>
                    Similar Raga Suggestions
                  </Text>
                  {similarRecs.slice(0, 6).map(renderRecommendationCard)}
                </View>
              )}
            </View>
          )}
        </ScrollView>

        {/* PERSISTENT STREAM PLAYER SLOT — expands at top of Stream tab OR docks as minimized bottom bar on all other tabs WITHOUT unmounting */}
        {showPersistentStream && activeStreamEntry && (
          <View
            style={[
              streamIsMinimized ? styles.miniDockCard : styles.streamStageCard,
              { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
          >
            {streamIsMinimized ? (
              <View style={styles.miniDockRow}>
                <Pressable onPress={() => setActiveTab('stream')} style={{ flex: 1 }}>
                  <Text style={[styles.miniKicker, { color: theme.accent }]}>
                    Playing · {safeStreamIdx + 1}/{streamQueue.length}
                  </Text>
                  <Text numberOfLines={1} style={[styles.listTitle, { color: theme.text }]}>
                    {activeStreamEntry.title}
                  </Text>
                </Pressable>

                <View style={styles.miniControlsRow}>
                  <Pressable
                    onPress={() => advanceStream(-1)}
                    style={[
                      styles.miniIconBtn,
                      { borderColor: theme.border, backgroundColor: theme.surfaceRaised },
                    ]}
                    accessibilityLabel="Previous bhajan"
                  >
                    <Text style={[styles.smallBtnText, { color: theme.text }]}>◀</Text>
                  </Pressable>
                  <Pressable
                    onPress={handleToggleStreamPlayPause}
                    style={[
                      styles.miniIconBtn,
                      { borderColor: theme.accent, backgroundColor: theme.accent },
                    ]}
                    accessibilityLabel={effectiveStreamPlaying ? 'Pause' : 'Play'}
                  >
                    <Text style={[styles.smallBtnText, { color: theme.accentText }]}>
                      {effectiveStreamPlaying ? '⏸' : '▶'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => advanceStream(1)}
                    style={[
                      styles.miniIconBtn,
                      { borderColor: theme.border, backgroundColor: theme.surfaceRaised },
                    ]}
                    accessibilityLabel="Next bhajan"
                  >
                    <Text style={[styles.smallBtnText, { color: theme.text }]}>▶▶</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => handleToggleLike(activeStreamEntry.id)}
                    style={[
                      styles.miniIconBtn,
                      {
                        borderColor: activeStreamLiked ? theme.accent : theme.border,
                        backgroundColor: theme.surfaceRaised,
                      },
                    ]}
                    accessibilityLabel={activeStreamLiked ? 'Unlike bhajan' : 'Like bhajan'}
                  >
                    <Text
                      style={[
                        styles.smallBtnText,
                        { color: activeStreamLiked ? theme.accent : theme.text },
                      ]}
                    >
                      {activeStreamLiked ? '♥' : '♡'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={handleDismissStream}
                    style={[
                      styles.miniIconBtn,
                      { borderColor: theme.border, backgroundColor: theme.bg },
                    ]}
                    accessibilityLabel="Close minimized stream"
                  >
                    <Text style={[styles.smallBtnText, { color: theme.textMuted }]}>✕</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.sectionStack}>
                <View style={styles.chipWrap}>
                  <View style={[styles.badge, { backgroundColor: theme.chipBg }]}>
                    <Text style={[styles.badgeText, { color: theme.text }]}>
                      Track {safeStreamIdx + 1} of {streamQueue.length}
                    </Text>
                  </View>
                  {activeStreamEntry.deity ? (
                    <View style={[styles.badge, { backgroundColor: theme.chipBg }]}>
                      <Text style={[styles.badgeText, { color: theme.text }]}>
                        {activeStreamEntry.deity}
                      </Text>
                    </View>
                  ) : null}
                  {activeStreamEntry.ragaName ? (
                    <View style={[styles.badge, { backgroundColor: theme.chipBg }]}>
                      <Text style={[styles.badgeText, { color: theme.text }]}>
                        Raga: {activeStreamEntry.ragaName}
                      </Text>
                    </View>
                  ) : null}
                  {streamHasAudioOption && !streamHasVideoOption && (
                    <View style={[styles.badge, { backgroundColor: theme.badgeSuccessBg }]}>
                      <Text style={[styles.badgeText, { color: theme.badgeSuccessText }]}>
                        Audio-only
                      </Text>
                    </View>
                  )}
                </View>

                <Text style={[styles.bhajanTitle, { color: theme.text }]}>
                  {activeStreamEntry.title}
                </Text>

                <View style={styles.recActionsRow}>
                  <Pressable
                    onPress={() => advanceStream(-1)}
                    style={[
                      styles.smallBtn,
                      { borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bg },
                    ]}
                  >
                    <Text style={[styles.smallBtnText, { color: theme.text }]}>◀ Prev</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => handleToggleLike(activeStreamEntry.id)}
                    style={[
                      styles.smallBtn,
                      {
                        borderWidth: 1,
                        borderColor: activeStreamLiked ? theme.accent : theme.border,
                        backgroundColor: theme.bg,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.smallBtnText,
                        { color: activeStreamLiked ? theme.accent : theme.text },
                      ]}
                    >
                      {activeStreamLiked ? '♥ Liked' : '♡ Like'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => advanceStream(1)}
                    style={[styles.smallBtn, { backgroundColor: theme.accent }]}
                  >
                    <Text style={[styles.smallBtnText, { color: theme.accentText }]}>Next ▶</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => openEntryInStudio(activeStreamEntry.id)}
                    style={[
                      styles.smallBtn,
                      { borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bg },
                    ]}
                  >
                    <Text style={[styles.smallBtnText, { color: theme.text }]}>Open in Studio</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Embedded Player — stays mounted cleanly across full <-> minimized transitions */}
            {streamLoadingDetail && !activeStreamBhajan ? (
              <View style={styles.inlineRow}>
                <ActivityIndicator color={theme.accent} />
                <Text style={[styles.statusText, { color: theme.textMuted }]}>
                  Loading stream audio and lyrics…
                </Text>
              </View>
            ) : streamDetailFailed && !activeStreamBhajan ? (
              <View style={styles.inlineRow}>
                <Text style={[styles.statusText, { color: theme.textMuted }]}>
                  Could not load details right now.
                </Text>
                <Pressable
                  onPress={() =>
                    void loadDetailForId(
                      activeStreamEntry.id,
                      setStreamLoadingDetail,
                      setStreamDetailFailed,
                    )
                  }
                  style={[
                    styles.smallBtn,
                    { borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bg },
                  ]}
                >
                  <Text style={[styles.smallBtnText, { color: theme.text }]}>Retry</Text>
                </Pressable>
              </View>
            ) : streamPlayback.kind === 'youtube' ? (
              <View style={streamIsMinimized ? styles.miniYtWrap : undefined}>
                <MobileYouTubePlayer
                  ref={ytStreamRef}
                  videoId={streamPlayback.videoId}
                  title={streamPreferredRec?.label || activeStreamEntry.title}
                  startSec={streamPreferredRec?.startSec}
                  endSec={streamPreferredRec?.endSec}
                  embeddable={streamPlayback.embeddable}
                  autoPlay={streamAutoPlay}
                  mediaMode={streamMediaMode}
                  onMediaModeChange={handleMediaModeChange}
                  minimized={streamIsMinimized}
                  onPlayStateChange={setStreamYtPlaying}
                  onEnded={() => {
                    if (streamAutoPlay) advanceStream(1);
                  }}
                  theme={theme}
                />
              </View>
            ) : streamPlayback.kind === 'audio' && !streamIsMinimized ? (
              <Pressable
                onPress={() => void playAudioUri(streamPlayback.uri)}
                style={[styles.playBtn, { backgroundColor: theme.accent }]}
              >
                {isLoadingAudio ? (
                  <ActivityIndicator color={theme.accentText} />
                ) : (
                  <Text style={[styles.playBtnText, { color: theme.accentText }]}>
                    {isAudioPlaying ? 'Pause Stream Audio' : '▶ Play Stream Audio'}
                  </Text>
                )}
              </Pressable>
            ) : streamPlayback.kind === 'none' && !streamIsMinimized ? (
              <Text style={[styles.statusText, { color: theme.textMuted }]}>
                {streamPlayback.reason}
              </Text>
            ) : null}
          </View>
        )}
      </View>

      {/* Bottom Tab Navigation Bar (>= 46pt touch targets) */}
      <View
        style={[
          styles.bottomTabs,
          { backgroundColor: theme.surface, borderTopColor: theme.border },
        ]}
      >
        {(
          [
            ['home', 'Home'],
            ['stream', 'Stream'],
            ['studio', 'Studio'],
            ['liked', `Liked (${likedEntries.length})`],
          ] as const
        ).map(([tabKey, label]) => {
          const active = activeTab === tabKey;
          return (
            <Pressable
              key={tabKey}
              onPress={() => setActiveTab(tabKey)}
              style={[
                styles.bottomTabBtn,
                active ? { backgroundColor: theme.surfaceRaised } : null,
              ]}
            >
              <Text
                style={[
                  styles.bottomTabLabel,
                  { color: active ? theme.accent : theme.textMuted },
                ]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Suggest Correction Modal */}
      <Modal visible={correctionOpen} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <ScrollView contentContainerStyle={styles.modalScroll}>
            <View
              style={[
                styles.modalSheet,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              <Text style={[styles.bhajanTitle, { color: theme.text }]}>
                Suggest Edit or Missing Lyrics
              </Text>
              <Text style={[styles.metaLine, { color: theme.textMuted }]}>
                Submits to the community moderation queue for review.
              </Text>

              <TextInput
                value={proposedLyricsText}
                onChangeText={setProposedLyricsText}
                multiline
                numberOfLines={6}
                placeholder="One lyric line per line"
                placeholderTextColor={theme.textMuted}
                style={[
                  styles.modalTextArea,
                  { borderColor: theme.border, color: theme.text, backgroundColor: theme.bg },
                ]}
              />
              <TextInput
                value={reasonOrSource}
                onChangeText={setReasonOrSource}
                placeholder="Source / reason (e.g. Sai Rhythms book, Prashanthi Mandir)"
                placeholderTextColor={theme.textMuted}
                style={[
                  styles.modalInput,
                  { borderColor: theme.border, color: theme.text, backgroundColor: theme.bg },
                ]}
              />
              <TextInput
                value={submitterName}
                onChangeText={setSubmitterName}
                placeholder="Your name"
                placeholderTextColor={theme.textMuted}
                style={[
                  styles.modalInput,
                  { borderColor: theme.border, color: theme.text, backgroundColor: theme.bg },
                ]}
              />
              <TextInput
                value={submitterEmail}
                onChangeText={setSubmitterEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                placeholder="Your email"
                placeholderTextColor={theme.textMuted}
                style={[
                  styles.modalInput,
                  { borderColor: theme.border, color: theme.text, backgroundColor: theme.bg },
                ]}
              />
              <TextInput
                value={apiBaseUrl}
                onChangeText={setApiBaseUrl}
                autoCapitalize="none"
                placeholder="bhaJami Portal API URL"
                placeholderTextColor={theme.textMuted}
                style={[
                  styles.modalInput,
                  { borderColor: theme.border, color: theme.text, backgroundColor: theme.bg },
                ]}
              />
              <TextInput
                value={authToken}
                onChangeText={setAuthToken}
                autoCapitalize="none"
                placeholder="Optional Firebase ID Bearer Token"
                placeholderTextColor={theme.textMuted}
                style={[
                  styles.modalInput,
                  { borderColor: theme.border, color: theme.text, backgroundColor: theme.bg },
                ]}
              />

              {correctionFeedback ? (
                <Text style={[styles.statusText, { color: theme.accent }]}>
                  {correctionFeedback}
                </Text>
              ) : null}

              <View style={styles.playerRow}>
                <Pressable
                  onPress={() => setCorrectionOpen(false)}
                  style={[
                    styles.secondaryBtn,
                    { borderColor: theme.border, backgroundColor: theme.surfaceRaised },
                  ]}
                >
                  <Text style={[styles.secondaryBtnText, { color: theme.text }]}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => void submitCorrection()}
                  disabled={submittingCorrection}
                  style={[styles.playBtn, { backgroundColor: theme.accent }]}
                >
                  <Text style={[styles.playBtnText, { color: theme.accentText }]}>
                    {submittingCorrection ? 'Sending...' : 'Submit for Review'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  brandTitle: { fontSize: 19, fontWeight: '700' },
  brandSubtitle: { fontSize: 12, marginTop: 2 },
  modeButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
  },
  modeButtonText: { fontSize: 12, fontWeight: '600' },
  container: { padding: 14, gap: 14, paddingBottom: 24 },
  sectionStack: { gap: 10 },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  sectionHeading: { fontSize: 16, fontWeight: '700' },
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 12,
  },
  streamStageCard: {
    borderBottomWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  miniDockCard: {
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  miniDockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  miniKicker: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  miniControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  miniIconBtn: {
    borderWidth: 1,
    borderRadius: 10,
    minWidth: 36,
    minHeight: 36,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniYtWrap: {
    alignSelf: 'flex-start',
  },
  heroTitle: { fontSize: 20, fontWeight: '700' },
  heroActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cardTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
  },
  bhajanTitle: { fontSize: 18, fontWeight: '700' },
  metaLine: { fontSize: 13, lineHeight: 19 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  pitchBox: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 10 },
  pitchHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  refSwitch: { flexDirection: 'row', gap: 6 },
  refPill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  refPillText: { fontSize: 11, fontWeight: '600' },
  transposeControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  stepBtn: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  stepBtnText: { fontWeight: '700', fontSize: 13 },
  pitchReadout: { alignItems: 'center', flex: 1 },
  pitchValue: { fontSize: 15, fontWeight: '700' },
  pitchSub: { fontSize: 12, marginTop: 2 },
  playerRow: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  playBtn: {
    flexGrow: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtnText: { fontWeight: '700', fontSize: 14 },
  secondaryBtn: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
  },
  secondaryBtnText: { fontWeight: '600', fontSize: 13 },
  smallBtn: {
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
  },
  smallBtnText: { fontSize: 12, fontWeight: '700' },
  statusText: { fontSize: 12, lineHeight: 17 },
  chipsRow: { flexDirection: 'row', marginVertical: 2 },
  chip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8 },
  lyricsBox: { gap: 4 },
  lyricLine: { fontSize: 15, lineHeight: 22 },
  catalogSection: { gap: 10 },
  searchInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  recCard: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  recActionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  listRow: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 },
  listTitle: { fontSize: 15, fontWeight: '600' },
  listMeta: { fontSize: 12, marginTop: 2 },
  bottomTabs: {
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
  },
  bottomTabBtn: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  bottomTabLabel: { fontSize: 12, fontWeight: '700' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
  },
  modalScroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 16,
  },
  modalSheet: { borderWidth: 1, borderRadius: 18, padding: 16, gap: 10 },
  modalTextArea: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    minHeight: 110,
    textAlignVertical: 'top',
  },
  modalInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
});
