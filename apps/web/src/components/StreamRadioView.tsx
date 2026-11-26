'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  pickStreamRecording,
  type Bhajan,
  type BhajanIndexEntry,
  type BhajanRecommendation,
  type StreamMediaMode,
  type StreamModeKind,
} from '@bhajami/shared';
import { YouTubeSegmentPlayer, type YouTubeSegmentPlayerHandle } from './YouTubeSegmentPlayer';

interface StreamRadioViewProps {
  minimized?: boolean;
  mediaMode: StreamMediaMode;
  onMediaModeChange: (nextMode: StreamMediaMode) => void;
  mode: StreamModeKind;
  onModeChange: (nextMode: StreamModeKind) => void;
  deityFilter: string;
  onDeityFilterChange: (next: string) => void;
  ragaFilter: string;
  onRagaFilterChange: (next: string) => void;
  deityChoices: readonly string[];
  availableRagas: string[];
  currentEntry: BhajanIndexEntry | null;
  currentBhajan: Bhajan | null;
  loadingDetail: boolean;
  queue: BhajanIndexEntry[];
  queueIndex: number;
  likedSet: Set<string>;
  autoPlay: boolean;
  onToggleAutoPlay: () => void;
  onToggleLike: (bhajanId: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onReshuffle: () => void;
  onSelectQueueIndex: (idx: number) => void;
  onPlayEntry: (entry: BhajanIndexEntry) => void;
  onRetryDetail?: () => void;
  onExpand?: () => void;
  onDismiss?: () => void;
  similarRecs: BhajanRecommendation[];
}

export function StreamRadioView({
  minimized = false,
  mediaMode,
  onMediaModeChange,
  mode,
  onModeChange,
  deityFilter,
  onDeityFilterChange,
  ragaFilter,
  onRagaFilterChange,
  deityChoices,
  availableRagas,
  currentEntry,
  currentBhajan,
  loadingDetail,
  queue,
  queueIndex,
  likedSet,
  autoPlay,
  onToggleAutoPlay,
  onToggleLike,
  onPrev,
  onNext,
  onReshuffle,
  onSelectQueueIndex,
  onPlayEntry,
  onRetryDetail,
  onExpand,
  onDismiss,
  similarRecs,
}: StreamRadioViewProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const ytRef = useRef<YouTubeSegmentPlayerHandle>(null);
  const miniLyricsScrollRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [ytPlaying, setYtPlaying] = useState(false);
  const [showMiniLyrics, setShowMiniLyrics] = useState(true);
  const [miniLyricsSetIdx, setMiniLyricsSetIdx] = useState(0);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null);

  const handleSwitchMediaMode = useCallback(
    (nextMode: StreamMediaMode) => {
      setSelectedRecordingId(null);
      onMediaModeChange(nextMode);
    },
    [onMediaModeChange],
  );

  const {
    recording: activeRec,
    hasAudioOption,
    hasVideoOption,
    defaultRecordingId,
  } = pickStreamRecording(currentBhajan, mediaMode, selectedRecordingId);
  const isDirectAudio = Boolean(activeRec && !activeRec.youtubeVideoId);
  const audioUrl = isDirectAudio && activeRec
    ? activeRec.localPath
      ? `/api/local-audio?id=${encodeURIComponent(activeRec.id)}&bhajanId=${encodeURIComponent(currentBhajan?.id || '')}`
      : activeRec.externalUrl || ''
    : '';
  const isYouTubeOnly = Boolean(activeRec?.youtubeVideoId && !hasAudioOption);
  const hasMinimizedYt = Boolean(minimized && !audioUrl && activeRec?.youtubeVideoId);
  const effectivePlaying = isDirectAudio && audioUrl ? isPlaying : ytPlaying;
  const isLiked = currentEntry ? likedSet.has(currentEntry.id) : false;

  const lyricsSets = currentBhajan?.lyricsSets ?? [];
  const safeLyricsSetIdx =
    lyricsSets.length > 0 ? Math.min(miniLyricsSetIdx, lyricsSets.length - 1) : 0;
  const activeLyricsSet = lyricsSets[safeLyricsSetIdx] ?? null;
  const rawLyricLines = activeLyricsSet?.lines ?? [];
  const nonEmptyLineCount = rawLyricLines.filter((line) => line.trim().length > 0).length;
  const hasLyrics = nonEmptyLineCount > 0;
  const useTwoColMiniLyrics = nonEmptyLineCount > 7;
  const canToggleMiniLyrics = hasMinimizedYt || hasLyrics;
  const showMiniLyricsPanel = Boolean(minimized && showMiniLyrics && canToggleMiniLyrics);

  const miniRaga = currentEntry?.ragaName || currentBhajan?.raga?.name || '';
  const miniBeat = currentEntry?.beat || currentBhajan?.beat || currentBhajan?.tala || '';
  const miniMetaItems: Array<{ label: string; accent?: boolean }> = [];
  if (currentEntry?.deity) miniMetaItems.push({ label: currentEntry.deity });
  if (miniRaga) miniMetaItems.push({ label: `Raga: ${miniRaga}`, accent: true });
  if (miniBeat) miniMetaItems.push({ label: `Beat: ${miniBeat}` });
  if (currentBhajan?.tempo) miniMetaItems.push({ label: currentBhajan.tempo });
  if (currentBhajan?.gentsPitch?.raw) miniMetaItems.push({ label: `Gents: ${currentBhajan.gentsPitch.raw}` });
  if (currentBhajan?.ladiesPitch?.raw) miniMetaItems.push({ label: `Ladies: ${currentBhajan.ladiesPitch.raw}` });
  if (currentBhajan?.language) miniMetaItems.push({ label: currentBhajan.language });
  if ((currentBhajan?.recordings?.length ?? 0) > 1) {
    miniMetaItems.push({ label: `${currentBhajan!.recordings.length} versions` });
  }

  useEffect(() => {
    setMiniLyricsSetIdx(0);
    setSelectedRecordingId(null);
  }, [currentEntry?.id]);

  useEffect(() => {
    if (miniLyricsScrollRef.current) {
      miniLyricsScrollRef.current.scrollTop = 0;
    }
  }, [currentEntry?.id, safeLyricsSetIdx]);

  useEffect(() => {
    setIsPlaying(Boolean(isDirectAudio && audioUrl && autoPlay));
  }, [activeRec?.id, audioUrl, autoPlay, currentEntry?.id, isDirectAudio]);

  useEffect(() => {
    setYtPlaying(Boolean(!audioUrl && activeRec?.youtubeVideoId && autoPlay));
  }, [activeRec?.youtubeVideoId, audioUrl, autoPlay, currentEntry?.id]);

  const handleTogglePlayPause = useCallback(() => {
    if (isDirectAudio && audioUrl) {
      const audioEl = audioRef.current;
      if (!audioEl) return;
      if (audioEl.paused) {
        void audioEl.play().catch(() => {});
      } else {
        audioEl.pause();
      }
      return;
    }
    if (activeRec?.youtubeVideoId) {
      ytRef.current?.togglePlay();
      return;
    }
    onExpand?.();
  }, [activeRec?.youtubeVideoId, audioUrl, isDirectAudio, onExpand]);

  return (
    <div className={minimized ? 'mini-stream-host' : 'app-stage'}>
      {!minimized && (
        <div className="stream-stage-card" style={{ marginBottom: '0.9rem' }}>
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
              <h1 style={{ margin: 0, fontSize: '1.45rem' }}>Continuous Bhajan Stream</h1>
              <p className="field-hint" style={{ margin: '0.2rem 0 0' }}>
                Plays all bhajans audio-first whenever a direct MP3 exists; YouTube-only tracks play inline and switch cleanly between Audio and Video.
              </p>
            </div>
            <div className="stream-controls-row">
              <button
                type="button"
                className={`btn btn-sm ${mode === 'discovery' ? 'btn-primary' : ''}`}
                aria-pressed={mode === 'discovery'}
                onClick={() => onModeChange('discovery')}
              >
                Random Stream
              </button>
              {likedSet.size >= 3 && (
                <button
                  type="button"
                  className={`btn btn-sm ${mode === 'for_you' ? 'btn-primary' : ''}`}
                  aria-pressed={mode === 'for_you'}
                  onClick={() => onModeChange('for_you')}
                >
                  For You
                </button>
              )}
              <button
                type="button"
                className={`btn btn-sm ${mode === 'liked_only' ? 'btn-primary' : ''}`}
                aria-pressed={mode === 'liked_only'}
                onClick={() => onModeChange('liked_only')}
              >
                Liked Radio ({likedSet.size})
              </button>
            </div>
          </div>

          <div className="stream-controls-row">
            <label htmlFor="stream-deity-filter" className="field-hint" style={{ margin: 0 }}>
              Deity:
            </label>
            <select
              id="stream-deity-filter"
              className="select-control"
              style={{ width: 'auto', maxWidth: '180px' }}
              value={deityFilter}
              onChange={(e) => onDeityFilterChange(e.target.value)}
            >
              {deityChoices.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>

            <label htmlFor="stream-raga-filter" className="field-hint" style={{ margin: 0 }}>
              Raga:
            </label>
            <select
              id="stream-raga-filter"
              className="select-control"
              style={{ width: 'auto', maxWidth: '200px' }}
              value={ragaFilter}
              onChange={(e) => onRagaFilterChange(e.target.value)}
            >
              <option value="">All Ragas</option>
              {availableRagas.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>

            <button
              type="button"
              className={`btn btn-sm ${mediaMode === 'audio' ? 'btn-success' : 'btn-primary'}`}
              aria-pressed={mediaMode === 'audio'}
              onClick={() => handleSwitchMediaMode(mediaMode === 'audio' ? 'video' : 'audio')}
              title="Toggle sticky Audio vs Video mode across all tracks"
            >
              Mode: {mediaMode === 'audio' ? 'Audio' : 'Video'}
            </button>

            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: '0.84rem',
                cursor: 'pointer',
              }}
            >
              <input type="checkbox" checked={autoPlay} onChange={onToggleAutoPlay} />
              <span>Auto-advance</span>
            </label>

            <button type="button" className="btn btn-sm" onClick={onReshuffle}>
              Reshuffle
            </button>
          </div>
        </div>
      )}

      {currentEntry ? (
        <div
          className={
            minimized
              ? [
                  'mini-stream-dock',
                  hasMinimizedYt ? 'mini-stream-dock-with-video' : 'mini-stream-dock-audio',
                  showMiniLyricsPanel ? 'mini-stream-dock-with-lyrics' : '',
                ]
                  .filter(Boolean)
                  .join(' ')
              : 'stream-stage-card'
          }
          role={minimized ? 'region' : undefined}
          aria-label={minimized ? `Minimized Bhajan Player: ${currentEntry.title}` : undefined}
        >
          {minimized ? (
            <div className={hasMinimizedYt || showMiniLyricsPanel ? 'mini-stream-bar-col' : 'mini-stream-bar-row'}>
              <button
                type="button"
                className="mini-stream-title-btn"
                onClick={onExpand}
                title="Open full Stream player"
              >
                <span className="mini-stream-kicker">
                  {isDirectAudio && audioUrl
                    ? `${isPlaying ? 'Playing Audio' : 'Audio Paused'} · ${queueIndex + 1}/${queue.length}`
                    : activeRec?.youtubeVideoId
                      ? `${ytPlaying ? 'Playing Video' : 'Video Paused'} · ${queueIndex + 1}/${queue.length}`
                      : `Stream Ready · ${queueIndex + 1}/${queue.length}`}
                </span>
                <span className="mini-stream-title">{currentEntry.title}</span>
              </button>

              {!showMiniLyricsPanel && miniMetaItems.length > 0 && (
                <div className="mini-stream-meta-chips" aria-label="Bhajan metadata">
                  {miniMetaItems.map((item) => (
                    <span
                      key={item.label}
                      className={item.accent ? 'mini-meta-chip mini-meta-chip-accent' : 'mini-meta-chip'}
                    >
                      {item.label}
                    </span>
                  ))}
                </div>
              )}

              <div className="mini-stream-controls">
                <button
                  type="button"
                  className="btn btn-sm mini-icon-btn"
                  aria-label="Previous bhajan"
                  onClick={onPrev}
                  disabled={queue.length <= 1}
                >
                  ◀
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary mini-icon-btn"
                  aria-label={effectivePlaying ? 'Pause' : 'Play'}
                  onClick={handleTogglePlayPause}
                >
                  {effectivePlaying ? '⏸' : '▶'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm mini-icon-btn"
                  aria-label="Next bhajan"
                  onClick={onNext}
                  disabled={queue.length <= 1}
                >
                  ▶▶
                </button>
                <button
                  type="button"
                  className="like-btn mini-icon-btn"
                  aria-pressed={isLiked}
                  aria-label={isLiked ? `Unlike ${currentEntry.title}` : `Like ${currentEntry.title}`}
                  onClick={() => onToggleLike(currentEntry.id)}
                >
                  {isLiked ? '♥' : '♡'}
                </button>
                {onDismiss && (
                  <button
                    type="button"
                    className="btn btn-sm mini-icon-btn"
                    aria-label="Close minimized player"
                    onClick={onDismiss}
                  >
                    ✕
                  </button>
                )}
                {canToggleMiniLyrics && !showMiniLyrics && (
                  <button
                    type="button"
                    className="btn btn-sm mini-icon-btn mini-lyrics-expand-btn"
                    aria-label="Show lyrics"
                    title="Show lyrics"
                    onClick={() => setShowMiniLyrics(true)}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="4 10 8 6 12 10" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: '0.75rem',
              }}
            >
              <div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.35rem' }}>
                  <span className="badge badge-pending">
                    Track {queueIndex + 1} of {queue.length}
                  </span>
                  {currentEntry.deity && <span className="badge">{currentEntry.deity}</span>}
                  {currentEntry.ragaName && (
                    <span className="badge">Raga: {currentEntry.ragaName}</span>
                  )}
                  {currentEntry.beat && <span className="badge">Beat: {currentEntry.beat}</span>}
                  {hasAudioOption && !hasVideoOption && (
                    <span className="badge badge-verified">Audio-only</span>
                  )}
                  {isYouTubeOnly && mediaMode === 'audio' && (
                    <span className="badge">YouTube-only (no MP3 yet)</span>
                  )}
                </div>
                <h2 style={{ margin: '0 0 0.2rem', fontSize: '1.35rem' }}>{currentEntry.title}</h2>
                {currentBhajan?.gentsPitch?.raw || currentBhajan?.ladiesPitch?.raw ? (
                  <p className="field-hint" style={{ margin: 0 }}>
                    {currentBhajan.gentsPitch?.raw ? `Gents: ${currentBhajan.gentsPitch.raw}` : ''}
                    {currentBhajan.gentsPitch?.raw && currentBhajan.ladiesPitch?.raw ? ' · ' : ''}
                    {currentBhajan.ladiesPitch?.raw ? `Ladies: ${currentBhajan.ladiesPitch.raw}` : ''}
                  </p>
                ) : null}
              </div>

              <div className="stream-controls-row">
                <button type="button" className="btn btn-sm" onClick={onPrev} disabled={queue.length <= 1}>
                  ◀ Prev
                </button>
                <button
                  type="button"
                  className="like-btn"
                  aria-pressed={isLiked}
                  aria-label={isLiked ? `Unlike ${currentEntry.title}` : `Like ${currentEntry.title}`}
                  onClick={() => onToggleLike(currentEntry.id)}
                >
                  {isLiked ? '♥ Liked' : '♡ Like'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={onNext}
                  disabled={queue.length <= 1}
                >
                  Next ▶
                </button>
              </div>
            </div>
          )}

          {/* Both <audio> and <YouTubeSegmentPlayer> stay mounted at child index 2 across full <-> minimized and lyrics toggles for zero-interruption playback (YT dock stays >= 200x200px TOS floor) */}
          <div
            key="stream-media-slot"
            className={
              minimized
                ? hasMinimizedYt
                  ? 'mini-stream-yt-slot'
                  : 'mini-stream-audio-slot'
                : undefined
            }
          >
            {audioUrl ? (
              <div style={{ display: 'grid', gap: '0.5rem' }}>
                <audio
                  ref={audioRef}
                  key={`${currentEntry.id}-${audioUrl}`}
                  controls={!minimized}
                  autoPlay={autoPlay}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => {
                    setIsPlaying(false);
                    if (autoPlay) onNext();
                  }}
                  src={audioUrl}
                  style={minimized ? { display: 'none' } : { width: '100%' }}
                />
                {!minimized && hasVideoOption && mediaMode === 'audio' && (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.5rem',
                    }}
                  >
                    <span className="field-hint" style={{ margin: 0 }}>
                      Direct MP3 audio · Video available
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleSwitchMediaMode('video')}
                    >
                      Show Video
                    </button>
                  </div>
                )}
              </div>
            ) : activeRec?.youtubeVideoId ? (
              <YouTubeSegmentPlayer
                ref={ytRef}
                videoId={activeRec.youtubeVideoId}
                title={activeRec.label}
                startSec={activeRec.startSec}
                endSec={activeRec.endSec}
                embeddable={activeRec.embeddable}
                autoPlay={autoPlay}
                minimized={minimized}
                onPlayStateChange={setYtPlaying}
                onMediaModeChange={!minimized && mediaMode === 'video' ? handleSwitchMediaMode : undefined}
                onEnded={autoPlay ? onNext : undefined}
              />
            ) : minimized ? null : loadingDetail && !currentBhajan ? (
              <p className="field-hint" style={{ margin: 0 }}>
                Loading stream audio and lyrics…
              </p>
            ) : currentBhajan === null && onRetryDetail ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.6rem' }}>
                <p className="field-hint" style={{ margin: 0 }}>
                  Could not load audio and lyrics for this bhajan right now.
                </p>
                <button type="button" className="btn btn-sm" onClick={onRetryDetail}>
                  Retry
                </button>
              </div>
            ) : (
              <p className="field-hint" style={{ margin: 0 }}>
                No playable audio source is linked to this bhajan yet — click Next.
              </p>
            )}
          </div>

          {minimized ? (
            showMiniLyricsPanel ? (
              <section
                className="mini-stream-lyrics-panel"
                aria-label={
                  activeLyricsSet?.language
                    ? `Bhajan lyrics (${activeLyricsSet.language})`
                    : 'Bhajan lyrics'
                }
              >
                <div
                  ref={miniLyricsScrollRef}
                  className="mini-stream-lyrics-scroll"
                  tabIndex={0}
                >
                  {hasLyrics ? (
                    <div
                      className={
                        useTwoColMiniLyrics
                          ? 'mini-stream-lyrics-lines mini-stream-lyrics-two-col'
                          : 'mini-stream-lyrics-lines mini-stream-lyrics-single-col'
                      }
                    >
                      {rawLyricLines.map((line, i) =>
                        line.trim().length === 0 ? (
                          <div key={`gap-${i}`} className="mini-stream-lyric-gap" aria-hidden="true" />
                        ) : (
                          <div key={`${i}-${line}`} className="mini-stream-lyric-line">
                            {line}
                          </div>
                        ),
                      )}
                    </div>
                  ) : loadingDetail && !currentBhajan ? (
                    <p className="mini-stream-lyrics-empty">Loading lyrics…</p>
                  ) : (
                    <div>
                      {miniMetaItems.length > 0 && (
                        <div className="mini-stream-meta-chips" aria-label="Bhajan metadata">
                          {miniMetaItems.map((item) => (
                            <span
                              key={item.label}
                              className={item.accent ? 'mini-meta-chip mini-meta-chip-accent' : 'mini-meta-chip'}
                            >
                              {item.label}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="mini-stream-lyrics-empty">
                        <span>Lyrics not added yet.</span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="mini-lyrics-corner-actions">
                  {lyricsSets.length > 1 && (
                    <button
                      type="button"
                      className="mini-lyrics-script-btn"
                      title="Switch lyrics script"
                      onClick={() =>
                        setMiniLyricsSetIdx((idx) => (idx + 1) % lyricsSets.length)
                      }
                    >
                      {safeLyricsSetIdx + 1}/{lyricsSets.length}
                    </button>
                  )}
                  <button
                    type="button"
                    className="mini-lyrics-collapse-btn"
                    aria-label="Hide lyrics"
                    title="Hide lyrics"
                    onClick={() => setShowMiniLyrics(false)}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="4 6 8 10 12 6" />
                    </svg>
                  </button>
                </div>
              </section>
            ) : null
          ) : (
            <>
              {(currentBhajan?.recordings?.length ?? 0) > 1 && (
                <details className="versions-disclosure">
                  <summary className="versions-summary">
                    More Versions ({currentBhajan!.recordings.length}) · Playing:{' '}
                    {activeRec?.label || activeRec?.id || 'Version'}
                  </summary>
                  <ul className="versions-list" aria-label="Available bhajan versions">
                    {currentBhajan!.recordings.map((rec) => {
                      const isActive = rec.id === activeRec?.id;
                      const isDefault = Boolean(rec.isDefault || rec.id === defaultRecordingId);
                      const isYt = Boolean(rec.youtubeVideoId);
                      const dur =
                        typeof rec.durationSec === 'number' && rec.durationSec > 0
                          ? `${Math.floor(rec.durationSec / 60)}:${String(rec.durationSec % 60).padStart(2, '0')}`
                          : null;
                      return (
                        <li key={rec.id}>
                          <button
                            type="button"
                            className="version-option-btn"
                            aria-pressed={isActive}
                            onClick={() => setSelectedRecordingId(rec.id)}
                          >
                            <span>
                              <strong>{rec.label || rec.id}</strong>
                              {dur ? <span className="field-hint"> · {dur}</span> : null}
                            </span>
                            <span className="version-option-badges">
                              <span className="badge">{isYt ? 'Video' : 'Audio'}</span>
                              {isDefault && <span className="badge badge-pending">Default</span>}
                              {isActive && <span className="badge badge-verified">Playing</span>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}
              {currentBhajan?.lyricsSets?.[0]?.lines?.length ? (
                <details>
                  <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.88rem' }}>
                    Show Lyrics ({currentBhajan.lyricsSets[0].language})
                  </summary>
                  <div style={{ marginTop: '0.5rem', display: 'grid', gap: '0.2rem' }}>
                    {currentBhajan.lyricsSets[0].lines.map((line, i) => (
                      <div key={`${i}-${line}`} style={{ fontSize: '0.92rem' }}>
                        {line}
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </>
          )}
        </div>
      ) : !minimized ? (
        <div className="stream-stage-card">
          <div className="control-box">
            <p style={{ margin: 0 }}>
              {mode === 'liked_only'
                ? 'Your Liked Radio playlist is empty — tap ♡ Like on any bhajan while streaming to build your playlist.'
                : 'No bhajans matched the selected Deity/Raga filter.'}
            </p>
          </div>
        </div>
      ) : null}

      {!minimized && queue.length > 0 && (
        <section className="rec-shelf-section" aria-label="Up Next in Stream">
          <div className="rec-shelf-header">
            <h2>Up Next in Stream</h2>
            <span className="field-hint">Tap any item to jump directly</span>
          </div>
          <div className="rec-shelf-grid">
            {queue
              .slice(queueIndex + 1, queueIndex + 7)
              .map((entry, offset) => {
                const liked = likedSet.has(entry.id);
                return (
                  <article key={`${entry.id}-${offset}`} className="rec-card">
                    <div>
                      <h3 className="rec-card-title">{entry.title}</h3>
                      <p className="field-hint" style={{ margin: '0.2rem 0 0' }}>
                        {[entry.deity, entry.ragaName].filter(Boolean).join(' · ') || 'Bhajan'}
                      </p>
                    </div>
                    <div className="rec-card-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => onSelectQueueIndex(queueIndex + 1 + offset)}
                      >
                        Play Now
                      </button>
                      <button
                        type="button"
                        className="like-btn"
                        aria-pressed={liked}
                        aria-label={liked ? `Unlike ${entry.title}` : `Like ${entry.title}`}
                        onClick={() => onToggleLike(entry.id)}
                      >
                        {liked ? '♥' : '♡'}
                      </button>
                    </div>
                  </article>
                );
              })}
          </div>
        </section>
      )}

      {!minimized && likedSet.size > 0 && similarRecs.length > 0 && (
        <section className="rec-shelf-section" aria-label="Similar Raga Recommendations">
          <div className="rec-shelf-header">
            <h2>Recommended From Your Liked Ragas</h2>
            <span className="field-hint">Updates automatically when you tap ♡ Like</span>
          </div>
          <div className="rec-shelf-grid">
            {similarRecs.slice(0, 6).map((rec) => {
              const liked = likedSet.has(rec.entry.id);
              return (
                <article key={rec.entry.id} className="rec-card">
                  <div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.35rem' }}>
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
                      onClick={() => onPlayEntry(rec.entry)}
                    >
                      Stream
                    </button>
                    <button
                      type="button"
                      className="like-btn"
                      aria-pressed={liked}
                      aria-label={liked ? `Unlike ${rec.entry.title}` : `Like ${rec.entry.title}`}
                      onClick={() => onToggleLike(rec.entry.id)}
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
  );
}
