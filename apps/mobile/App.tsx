import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { Audio } from 'expo-av';
import { StatusBar } from 'expo-status-bar';
import catalogJson from '../../packages/shared/data/catalog.json';
import { transposePitch } from '../../packages/shared/src/pitch';
import type { Bhajan, CatalogPayload, RecordingSource } from '../../packages/shared/src/types';

const CATALOG = catalogJson as unknown as CatalogPayload;

const DEFAULT_API_BASE =
  Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000';

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
};

export default function App() {
  const systemScheme = useColorScheme();
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>(
    systemScheme === 'dark' ? 'dark' : 'light',
  );
  const theme = themeMode === 'dark' ? DARK_THEME : LIGHT_THEME;

  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDeity, setSelectedDeity] = useState<string>('All');
  const [selectedBhajan, setSelectedBhajan] = useState<Bhajan>(CATALOG.bhajans[0]);

  const [pitchReference, setPitchReference] = useState<'gents' | 'ladies'>('gents');
  const [semitoneDelta, setSemitoneDelta] = useState(0);
  const [activeRecIndex, setActiveRecIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [audioMessage, setAudioMessage] = useState<string | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  // Correction modal state
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [proposedLyricsText, setProposedLyricsText] = useState('');
  const [reasonOrSource, setReasonOrSource] = useState('');
  const [submitterName, setSubmitterName] = useState('');
  const [submitterEmail, setSubmitterEmail] = useState('');
  const [submittingCorrection, setSubmittingCorrection] = useState(false);
  const [correctionFeedback, setCorrectionFeedback] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {});
      }
    };
  }, []);

  const deities = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of CATALOG.bhajans) {
      counts.set(item.deity, (counts.get(item.deity) ?? 0) + 1);
    }
    return [
      'All',
      ...Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name]) => name),
    ];
  }, []);

  const filteredBhajans = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return CATALOG.bhajans.filter((b) => {
      if (selectedDeity !== 'All' && b.deity !== selectedDeity) {
        return false;
      }
      if (!q) return true;
      return (
        b.title.toLowerCase().includes(q) ||
        b.deity.toLowerCase().includes(q) ||
        b.raga.name.toLowerCase().includes(q)
      );
    });
  }, [searchQuery, selectedDeity]);

  const basePitch =
    pitchReference === 'gents' ? selectedBhajan.gentsPitch : selectedBhajan.ladiesPitch;
  const transposed = useMemo(
    () => transposePitch(basePitch.semitoneFromC, semitoneDelta),
    [basePitch.semitoneFromC, semitoneDelta],
  );

  const primaryLyrics = selectedBhajan.lyricsSets[0]?.lines ?? [];
  const activeRecording: RecordingSource | undefined =
    selectedBhajan.recordings[activeRecIndex] ?? selectedBhajan.recordings[0];

  async function selectBhajan(item: Bhajan) {
    setSelectedBhajan(item);
    setActiveRecIndex(0);
    setSemitoneDelta(0);
    setAudioMessage(null);
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
      setIsPlaying(false);
    }
  }

  function resolveRecordingUri(rec: RecordingSource): string | null {
    if (rec.externalUrl) return rec.externalUrl;
    if (rec.localPath) {
      const cleanBase = apiBaseUrl.replace(/\/+$/, '');
      return `${cleanBase}/api/local-audio?id=${encodeURIComponent(rec.id)}`;
    }
    return null;
  }

  async function togglePlayback() {
    if (!activeRecording) {
      setAudioMessage('No recording linked for this bhajan yet.');
      return;
    }

    if (soundRef.current && isPlaying) {
      await soundRef.current.pauseAsync();
      setIsPlaying(false);
      return;
    }

    if (soundRef.current && !isPlaying) {
      await soundRef.current.playAsync();
      setIsPlaying(true);
      return;
    }

    const uri = resolveRecordingUri(activeRecording);
    if (!uri) {
      setAudioMessage('No streamable URI found for this recording.');
      return;
    }

    try {
      setIsLoadingAudio(true);
      setAudioMessage(null);
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true },
        (status) => {
          if (status.isLoaded && status.didJustFinish) {
            setIsPlaying(false);
          }
        },
      );
      soundRef.current = sound;
      setIsPlaying(true);
    } catch (err) {
      setAudioMessage(
        err instanceof Error
          ? `Audio error (check Web Portal URL ${apiBaseUrl}): ${err.message}`
          : 'Unable to play recording.',
      );
      setIsPlaying(false);
    } finally {
      setIsLoadingAudio(false);
    }
  }

  function openCorrectionModal() {
    setProposedLyricsText(primaryLyrics.join('\n'));
    setReasonOrSource('');
    setCorrectionFeedback(null);
    setCorrectionOpen(true);
  }

  async function submitCorrection() {
    const lines = proposedLyricsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0 || !reasonOrSource.trim() || !submitterName.trim() || !submitterEmail.trim()) {
      setCorrectionFeedback('Please complete lyrics, source/reason, your name, and email.');
      return;
    }

    try {
      setSubmittingCorrection(true);
      setCorrectionFeedback(null);
      const cleanBase = apiBaseUrl.replace(/\/+$/, '');
      const res = await fetch(`${cleanBase}/api/corrections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bhajanId: selectedBhajan.id,
          bhajanTitle: selectedBhajan.title,
          script: selectedBhajan.lyricsSets[0]?.script ?? 'roman',
          originalLyrics: primaryLyrics,
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
      setCorrectionFeedback('Submitted! Waiting for admin approval and email sent to pschax@gmail.com.');
      setTimeout(() => {
        setCorrectionOpen(false);
      }, 1200);
    } catch (err) {
      setCorrectionFeedback(
        err instanceof Error ? `Submit failed: ${err.message}` : 'Unable to submit correction.',
      );
    } finally {
      setSubmittingCorrection(false);
    }
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
      <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />
      <ScrollView contentContainerStyle={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={[styles.brandTitle, { color: theme.text }]}>bhaJami · भजामि</Text>
            <Text style={[styles.brandSubtitle, { color: theme.textMuted }]}>
              {CATALOG.stats.totalBhajans} Bhajans · {CATALOG.stats.totalLocalRecordings} Local MP3s
            </Text>
          </View>
          <Pressable
            onPress={() => setThemeMode((prev) => (prev === 'light' ? 'dark' : 'light'))}
            style={[styles.modeButton, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }]}
          >
            <Text style={[styles.modeButtonText, { color: theme.text }]}>
              {theme.mode === 'light' ? 'Mandir Sandhya' : 'Prasanthi Dawn'}
            </Text>
          </Pressable>
        </View>

        {/* Active Jam Card */}
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.cardTopRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.bhajanTitle, { color: theme.text }]}>{selectedBhajan.title}</Text>
              <Text style={[styles.metaLine, { color: theme.textMuted }]}>
                {selectedBhajan.deity} · {selectedBhajan.raga.name} · {selectedBhajan.beat}
              </Text>
            </View>
            <View style={[styles.badge, { backgroundColor: theme.badgeSuccessBg }]}>
              <Text style={[styles.badgeText, { color: theme.badgeSuccessText }]}>
                {selectedBhajan.metadataSource === 'sairhythms_verified' ? 'Sai Rhythms' : 'Local MP3'}
              </Text>
            </View>
          </View>

          {/* Pitch Transposer */}
          <View style={[styles.pitchBox, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }]}>
            <View style={styles.pitchHeaderRow}>
              <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>KEY & SHRUTI TRANSPOSER</Text>
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
                        {refKey === 'gents' ? 'Gents Ref' : 'Ladies Ref'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.transposeControls}>
              <Pressable
                onPress={() => setSemitoneDelta((d) => Math.max(-6, d - 1))}
                style={[styles.stepBtn, { borderColor: theme.border, backgroundColor: theme.surface }]}
              >
                <Text style={[styles.stepBtnText, { color: theme.text }]}>-1 st</Text>
              </Pressable>
              <View style={styles.pitchReadout}>
                <Text style={[styles.pitchValue, { color: theme.text }]}>
                  {transposed.pancham} ({transposed.western})
                </Text>
                <Text style={[styles.pitchSub, { color: theme.textMuted }]}>
                  {transposed.freqHz.toFixed(1)} Hz · {transposed.deltaLabel}
                </Text>
              </View>
              <Pressable
                onPress={() => setSemitoneDelta((d) => Math.min(6, d + 1))}
                style={[styles.stepBtn, { borderColor: theme.border, backgroundColor: theme.surface }]}
              >
                <Text style={[styles.stepBtnText, { color: theme.text }]}>+1 st</Text>
              </Pressable>
            </View>
          </View>

          {/* Audio Player */}
          <View style={styles.playerRow}>
            <Pressable
              onPress={togglePlayback}
              style={[styles.playBtn, { backgroundColor: theme.accent }]}
            >
              {isLoadingAudio ? (
                <ActivityIndicator color={theme.accentText} />
              ) : (
                <Text style={[styles.playBtnText, { color: theme.accentText }]}>
                  {isPlaying ? 'Pause Jam Track' : 'Play Jam Track'}
                </Text>
              )}
            </Pressable>
            <Pressable
              onPress={openCorrectionModal}
              style={[styles.secondaryBtn, { borderColor: theme.border, backgroundColor: theme.surfaceRaised }]}
            >
              <Text style={[styles.secondaryBtnText, { color: theme.text }]}>Suggest Correction</Text>
            </Pressable>
          </View>
          {audioMessage ? (
            <Text style={[styles.statusText, { color: theme.textMuted }]}>{audioMessage}</Text>
          ) : null}

          {/* Recordings Selector */}
          {selectedBhajan.recordings.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsRow}>
              {selectedBhajan.recordings.map((rec, idx) => (
                <Pressable
                  key={rec.id}
                  onPress={async () => {
                    setActiveRecIndex(idx);
                    if (soundRef.current) {
                      await soundRef.current.unloadAsync().catch(() => {});
                      soundRef.current = null;
                      setIsPlaying(false);
                    }
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

          {/* Lyrics */}
          <View style={styles.lyricsBox}>
            <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>LYRICS</Text>
            {primaryLyrics.length > 0 ? (
              primaryLyrics.map((line, i) => (
                <Text key={`${selectedBhajan.id}-line-${i}`} style={[styles.lyricLine, { color: theme.text }]}>
                  {line}
                </Text>
              ))
            ) : (
              <Text style={[styles.metaLine, { color: theme.textMuted }]}>
                Lyrics not yet synced from Sai Rhythms for this local recording. Tap “Suggest Correction” to contribute them.
              </Text>
            )}
          </View>
        </View>

        {/* Catalog Search */}
        <View style={styles.catalogSection}>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search bhajans, raga, deity..."
            placeholderTextColor={theme.textMuted}
            style={[
              styles.searchInput,
              { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text },
            ]}
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsRow}>
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
            data={filteredBhajans.slice(0, 40)}
            keyExtractor={(item) => item.id}
            scrollEnabled={false}
            renderItem={({ item }) => {
              const active = item.id === selectedBhajan.id;
              return (
                <Pressable
                  onPress={() => selectBhajan(item)}
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
                    {item.deity} · {item.recordings.length} track(s) · {item.gentsPitch.pancham}
                  </Text>
                </Pressable>
              );
            }}
          />
        </View>
      </ScrollView>

      {/* Suggest Correction Modal */}
      <Modal visible={correctionOpen} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.bhajanTitle, { color: theme.text }]}>Suggest Lyric Correction</Text>
            <Text style={[styles.metaLine, { color: theme.textMuted, marginBottom: 12 }]}>
              Sends directly to Admin Queue (/admin/corrections) and pschax@gmail.com
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
              placeholder="bhaJami Portal URL"
              placeholderTextColor={theme.textMuted}
              style={[
                styles.modalInput,
                { borderColor: theme.border, color: theme.text, backgroundColor: theme.bg },
              ]}
            />

            {correctionFeedback ? (
              <Text style={[styles.statusText, { color: theme.accent }]}>{correctionFeedback}</Text>
            ) : null}

            <View style={styles.playerRow}>
              <Pressable
                onPress={() => setCorrectionOpen(false)}
                style={[styles.secondaryBtn, { borderColor: theme.border, backgroundColor: theme.surfaceRaised }]}
              >
                <Text style={[styles.secondaryBtnText, { color: theme.text }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={submitCorrection}
                disabled={submittingCorrection}
                style={[styles.playBtn, { backgroundColor: theme.accent }]}
              >
                <Text style={[styles.playBtnText, { color: theme.accentText }]}>
                  {submittingCorrection ? 'Sending...' : 'Submit for Approval'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 16, gap: 16 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  brandTitle: { fontSize: 22, fontWeight: '700' },
  brandSubtitle: { fontSize: 13, marginTop: 2 },
  modeButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  modeButtonText: { fontSize: 12, fontWeight: '600' },
  card: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    gap: 14,
  },
  cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  bhajanTitle: { fontSize: 19, fontWeight: '700' },
  metaLine: { fontSize: 13, marginTop: 4 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  pitchBox: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 10 },
  pitchHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.7 },
  refSwitch: { flexDirection: 'row', gap: 6 },
  refPill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  refPillText: { fontSize: 11, fontWeight: '600' },
  transposeControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  stepBtn: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  stepBtnText: { fontWeight: '700', fontSize: 13 },
  pitchReadout: { alignItems: 'center', flex: 1 },
  pitchValue: { fontSize: 16, fontWeight: '700' },
  pitchSub: { fontSize: 12, marginTop: 2 },
  playerRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  playBtn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  playBtnText: { fontWeight: '700', fontSize: 14 },
  secondaryBtn: { borderWidth: 1, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 },
  secondaryBtnText: { fontWeight: '600', fontSize: 13 },
  statusText: { fontSize: 12 },
  chipsRow: { flexDirection: 'row', marginVertical: 4 },
  chip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8 },
  lyricsBox: { gap: 4 },
  lyricLine: { fontSize: 15, lineHeight: 22 },
  catalogSection: { gap: 10 },
  searchInput: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 },
  listRow: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 },
  listTitle: { fontSize: 15, fontWeight: '600' },
  listMeta: { fontSize: 12, marginTop: 2 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
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
