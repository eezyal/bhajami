import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  NativeModules,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  useWindowDimensions,
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
  resolveDefaultApiBase,
  resolvePlaybackAction,
} from './src/lib/search-and-playback';

type AppTab = 'home' | 'stream' | 'liked';

const DEFAULT_API_BASE = resolveDefaultApiBase({
  envBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
  webHostname:
    typeof globalThis !== 'undefined' && 'location' in globalThis
      ? (globalThis as { location?: { hostname?: string } }).location?.hostname
      : undefined,
  bundleScriptUrl:
    typeof NativeModules?.SourceCode?.scriptURL === 'string'
      ? NativeModules.SourceCode.scriptURL
      : undefined,
  platformOs: Platform.OS,
});
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
  const { width: windowWidth } = useWindowDimensions();
  const isTabletDock = windowWidth >= 680;
  const systemScheme = useColorScheme();
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>(
    systemScheme === 'dark' ? 'dark' : 'light',
  );
  const theme = themeMode === 'dark' ? DARK_THEME : LIGHT_THEME;

  const [activeTab, setActiveTab] = useState<AppTab>('home');
  const apiBaseUrl = DEFAULT_API_BASE;

  // Two-tier cloud index + lazy detail cache
  const [catalogIndex, setCatalogIndex] = useState<CatalogIndexPayload>(() =>
    getBundledCatalogIndex(),
  );
  const [syncingIndex, setSyncingIndex] = useState(false);
  const [bhajanCache, setBhajanCache] = useState<Record<string, Bhajan>>({});

  // Home state
  const [homeQuery, setHomeQuery] = useState('');

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
  const [showMiniLyrics, setShowMiniLyrics] = useState(false);
  const [miniLyricsSetIdx, setMiniLyricsSetIdx] = useState(0);
  const miniLyricsScrollRef = useRef<ScrollView>(null);
  const [streamYtPlaying, setStreamYtPlaying] = useState(false);
  const ytStreamRef = useRef<MobileYouTubePlayerHandle>(null);

  // Direct MP3 playback via expo-av (shared cleanly with track URI tracking)
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const loadedAudioUriRef = useRef<string | null>(null);

  const unloadAudio = useCallback(async () => {
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    loadedAudioUriRef.current = null;
    setIsAudioPlaying(false);
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

  useEffect(() => {
    setStreamIdx(0);
  }, [streamDeity, streamMode, streamRaga, streamSeed]);

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
      } catch {
        setIsAudioPlaying(false);
      } finally {
        setIsLoadingAudio(false);
      }
    },
    [isAudioPlaying],
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

  const streamIsMinimized = activeTab !== 'stream';

  const handleToggleStreamPlayPause = useCallback(() => {
    if (streamPlayback.kind === 'audio') {
      void playAudioUri(streamPlayback.uri);
    } else if (streamPlayback.kind === 'youtube') {
      ytStreamRef.current?.togglePlay();
    } else if (streamIsMinimized) {
      setActiveTab('stream');
    }
  }, [playAudioUri, streamIsMinimized, streamPlayback]);

  const handleDismissStream = useCallback(() => {
    setStreamSessionActive(false);
    setStreamYtPlaying(false);
    setShowMiniLyrics(false);
    void unloadAudio();
  }, [unloadAudio]);

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
        </View>
      </View>
    );
  }

  const showPersistentStream = streamSessionActive && Boolean(activeStreamEntry);
  const hasMinimizedStreamYt = Boolean(
    streamIsMinimized && streamPlayback.kind === 'youtube',
  );
  const effectiveStreamPlaying =
    streamPlayback.kind === 'youtube' ? streamYtPlaying : isAudioPlaying;
  const activeStreamLiked = activeStreamEntry ? likedSet.has(activeStreamEntry.id) : false;
  const streamLyricsSets = activeStreamBhajan?.lyricsSets ?? [];
  const safeStreamLyricsIdx =
    streamLyricsSets.length > 0 ? Math.min(miniLyricsSetIdx, streamLyricsSets.length - 1) : 0;
  const activeStreamLyricsSet = streamLyricsSets[safeStreamLyricsIdx] ?? null;
  const streamLyricsLines = activeStreamLyricsSet?.lines ?? [];
  const hasStreamLyrics = streamLyricsLines.some((line) => line.trim().length > 0);
  const miniStreamMetaLine = [
    activeStreamEntry?.deity,
    activeStreamEntry?.ragaName || activeStreamBhajan?.raga?.name,
    activeStreamEntry?.beat || activeStreamBhajan?.beat || activeStreamBhajan?.tala,
    activeStreamBhajan?.gentsPitch?.raw ? `G: ${activeStreamBhajan.gentsPitch.raw}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  useEffect(() => {
    setMiniLyricsSetIdx(0);
    miniLyricsScrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [activeStreamEntry?.id]);

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
                  Stream bhajans audio-first (MP3 when available, inline YouTube otherwise), curate
                  favorites with ♥, and discover similar Ragas.
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
                      Mode: {streamMediaMode === 'audio' ? 'Audio' : 'Video'}
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
                    No liked bhajans yet. Start Random Stream or search Home and tap ♡ Like!
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
              streamIsMinimized
                ? hasMinimizedStreamYt
                  ? showMiniLyrics
                    ? isTabletDock
                      ? styles.miniDockCardWithVideo
                      : styles.miniDockCardWithVideoLyrics
                    : styles.miniDockCardWithVideo
                  : styles.miniDockCard
                : styles.streamStageCard,
              { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
          >
            {streamIsMinimized ? (
              showMiniLyrics ? (
                <View
                  style={[
                    styles.miniLyricsPanel,
                    hasMinimizedStreamYt && isTabletDock ? { flex: 1, minWidth: 0 } : undefined,
                    { backgroundColor: theme.surfaceRaised, borderColor: theme.border },
                  ]}
                >
                  <View
                    style={[
                      styles.miniLyricsHeader,
                      { backgroundColor: theme.surface, borderBottomColor: theme.border },
                    ]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={[styles.miniKicker, { color: theme.accent }]}>
                        {activeStreamLyricsSet?.language
                          ? `Lyrics · ${activeStreamLyricsSet.language}`
                          : 'Lyrics'}
                      </Text>
                      <Text numberOfLines={1} style={[styles.miniLyricsTitle, { color: theme.text }]}>
                        {activeStreamEntry.title}
                      </Text>
                    </View>
                    {streamLyricsSets.length > 1 && (
                      <Pressable
                        onPress={() =>
                          setMiniLyricsSetIdx((idx) => (idx + 1) % streamLyricsSets.length)
                        }
                        style={[
                          styles.miniLyricsActionBtn,
                          { borderColor: theme.border, backgroundColor: theme.surfaceRaised },
                        ]}
                        accessibilityLabel="Switch lyrics script"
                      >
                        <Text style={[styles.miniLyricsActionText, { color: theme.text }]}>
                          {safeStreamLyricsIdx + 1}/{streamLyricsSets.length}
                        </Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={() => setShowMiniLyrics(false)}
                      style={[
                        styles.miniLyricsActionBtn,
                        { borderColor: theme.accent, backgroundColor: theme.surface },
                      ]}
                      accessibilityLabel="Hide lyrics"
                    >
                      <Text style={[styles.miniLyricsActionText, { color: theme.accent }]}>
                        Hide Lyrics
                      </Text>
                    </Pressable>
                  </View>
                  <ScrollView
                    ref={miniLyricsScrollRef}
                    nestedScrollEnabled
                    style={
                      hasMinimizedStreamYt
                        ? isTabletDock
                          ? styles.miniLyricsScrollTabletVideo
                          : styles.miniLyricsScrollWithVideo
                        : styles.miniLyricsScrollAudio
                    }
                    contentContainerStyle={styles.miniLyricsScrollContent}
                  >
                    {hasStreamLyrics ? (
                      streamLyricsLines.map((line, i) =>
                        line.trim().length === 0 ? (
                          <View key={`gap-${i}`} style={{ height: 6 }} />
                        ) : (
                          <Text key={`${i}-${line}`} style={[styles.miniLyricsLine, { color: theme.text }]}>
                            {line}
                          </Text>
                        ),
                      )
                    ) : streamLoadingDetail && !activeStreamBhajan ? (
                      <Text style={[styles.statusText, { color: theme.textMuted }]}>
                        Loading lyrics…
                      </Text>
                    ) : (
                      <Text style={[styles.statusText, { color: theme.textMuted }]}>
                        Lyrics are not yet available for this bhajan.
                      </Text>
                    )}
                  </ScrollView>
                </View>
              ) : (
                <View style={hasMinimizedStreamYt ? styles.miniDockVideoCol : styles.miniDockAudioCol}>
                  <View style={styles.miniDockTopRow}>
                    <Pressable onPress={() => setActiveTab('stream')} style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.miniKicker, { color: theme.accent }]}>
                        {`${effectiveStreamPlaying ? 'Playing' : 'Paused'} ${streamPlayback.kind === 'audio' ? 'Audio' : 'Video'} · ${safeStreamIdx + 1}/${streamQueue.length}`}
                      </Text>
                      <Text
                        numberOfLines={hasMinimizedStreamYt ? 2 : 1}
                        style={[styles.listTitle, { color: theme.text }]}
                      >
                        {activeStreamEntry.title}
                      </Text>
                      {miniStreamMetaLine ? (
                        <Text numberOfLines={1} style={[styles.miniMetaLine, { color: theme.textMuted }]}>
                          {miniStreamMetaLine}
                        </Text>
                      ) : null}
                    </Pressable>
                    {!hasMinimizedStreamYt && (
                      <Pressable
                        onPress={() => setShowMiniLyrics(true)}
                        style={[
                          styles.miniShowLyricsBtn,
                          { borderColor: theme.border, backgroundColor: theme.surfaceRaised },
                        ]}
                        accessibilityLabel="Show lyrics"
                      >
                        <Text style={[styles.miniLyricsActionText, { color: theme.accent }]}>
                          Show Lyrics
                        </Text>
                      </Pressable>
                    )}
                  </View>

                  <View style={[styles.miniControlsRow, hasMinimizedStreamYt ? styles.miniControlsWrap : undefined]}>
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

                  {hasMinimizedStreamYt && (
                    <Pressable
                      onPress={() => setShowMiniLyrics(true)}
                      style={[
                        styles.miniShowLyricsBtn,
                        { borderColor: theme.border, backgroundColor: theme.surfaceRaised, alignSelf: 'flex-start' },
                      ]}
                      accessibilityLabel="Show lyrics"
                    >
                      <Text style={[styles.miniLyricsActionText, { color: theme.accent }]}>
                        Show Lyrics
                      </Text>
                    </Pressable>
                  )}
                </View>
              )
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
                  {!streamHasAudioOption && streamHasVideoOption && streamMediaMode === 'audio' && (
                    <View style={[styles.badge, { backgroundColor: theme.chipBg }]}>
                      <Text style={[styles.badgeText, { color: theme.textMuted }]}>
                        YouTube-only (no MP3 yet)
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
                </View>
              </View>
            )}

            {/* Direct MP3 uses zero-video bar; YouTube stays mounted at >= 200x200px TOS floor inside minimized dock */}
            {streamPlayback.kind === 'youtube' ? (
              <MobileYouTubePlayer
                ref={ytStreamRef}
                videoId={streamPlayback.videoId}
                title={streamPreferredRec?.label || activeStreamEntry.title}
                startSec={streamPreferredRec?.startSec}
                endSec={streamPreferredRec?.endSec}
                embeddable={streamPlayback.embeddable}
                autoPlay={streamAutoPlay}
                minimized={streamIsMinimized}
                onMediaModeChange={
                  !streamIsMinimized && streamMediaMode === 'video'
                    ? handleMediaModeChange
                    : undefined
                }
                onPlayStateChange={setStreamYtPlaying}
                onEnded={() => {
                  if (streamAutoPlay) advanceStream(1);
                }}
                theme={theme}
              />
            ) : streamIsMinimized ? null : streamLoadingDetail && !activeStreamBhajan ? (
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
            ) : streamPlayback.kind === 'audio' ? (
              <View style={styles.sectionStack}>
                <Pressable
                  onPress={() => void playAudioUri(streamPlayback.uri)}
                  style={[styles.playBtn, { backgroundColor: theme.accent }]}
                >
                  {isLoadingAudio ? (
                    <ActivityIndicator color={theme.accentText} />
                  ) : (
                    <Text style={[styles.playBtnText, { color: theme.accentText }]}>
                      {isAudioPlaying ? 'Pause Audio' : '▶ Play Audio'}
                    </Text>
                  )}
                </Pressable>
                {streamHasVideoOption && streamMediaMode === 'audio' && (
                  <View style={styles.inlineRow}>
                    <Text style={[styles.statusText, { color: theme.textMuted, flex: 1 }]}>
                      Direct MP3 audio · Video available
                    </Text>
                    <Pressable
                      onPress={() => handleMediaModeChange('video')}
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
                        Show Video
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ) : (
              <Text style={[styles.statusText, { color: theme.textMuted }]}>
                {streamPlayback.kind === 'none'
                  ? streamPlayback.reason
                  : 'No playable audio source is linked to this bhajan yet.'}
              </Text>
            )}
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
  miniDockCardWithVideo: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    borderTopWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 10,
  },
  miniDockCardWithVideoLyrics: {
    flexDirection: 'column',
    alignItems: 'center',
    borderTopWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  miniDockAudioCol: {
    gap: 8,
  },
  miniDockTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  miniDockVideoCol: {
    flex: 1,
    minWidth: 0,
    gap: 8,
  },
  miniShowLyricsBtn: {
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniLyricsPanel: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  miniLyricsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderBottomWidth: 1,
  },
  miniLyricsTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  miniLyricsActionBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
    minHeight: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniLyricsActionText: {
    fontSize: 11,
    fontWeight: '700',
  },
  miniLyricsScrollAudio: {
    height: 220,
  },
  miniLyricsScrollWithVideo: {
    height: 168,
  },
  miniLyricsScrollTabletVideo: {
    height: 158,
  },
  miniLyricsScrollContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 3,
  },
  miniLyricsLine: {
    fontSize: 13.5,
    lineHeight: 20,
  },
  miniMetaLine: {
    fontSize: 11,
    marginTop: 1,
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
  miniControlsWrap: {
    flexWrap: 'wrap',
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
