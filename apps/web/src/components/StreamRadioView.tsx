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
import { YouTubeSegmentPlayer } from './YouTubeSegmentPlayer';

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
  onOpenInStudio: (bhajanId: string) => void;
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
  onOpenInStudio,
  onPlayEntry,
  onRetryDetail,
  onExpand,
  onDismiss,
  similarRecs,
}: StreamRadioViewProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const { recording: activeRec, hasAudioOption, hasVideoOption } = pickStreamRecording(
    currentBhajan,
    mediaMode,
  );
  const isDirectAudio = Boolean(activeRec && !activeRec.youtubeVideoId);
  const audioUrl = isDirectAudio && activeRec
    ? activeRec.localPath
      ? `/api/local-audio?id=${encodeURIComponent(activeRec.id)}&bhajanId=${encodeURIComponent(currentBhajan?.id || '')}`
      : activeRec.externalUrl || ''
    : '';
  const isYouTubeOnly = Boolean(activeRec?.youtubeVideoId && !hasAudioOption);
  const isLiked = currentEntry ? likedSet.has(currentEntry.id) : false;

  useEffect(() => {
    setIsPlaying(Boolean(isDirectAudio && audioUrl && autoPlay));
  }, [activeRec?.id, audioUrl, autoPlay, currentEntry?.id, isDirectAudio]);

  const handleTogglePlayPause = useCallback(() => {
    if (!isDirectAudio || !audioUrl) {
      onExpand?.();
      return;
    }
    const audioEl = audioRef.current;
    if (!audioEl) return;
    if (audioEl.paused) {
      void audioEl.play().catch(() => {});
    } else {
      audioEl.pause();
    }
  }, [audioUrl, isDirectAudio, onExpand]);

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
              onClick={() => onMediaModeChange(mediaMode === 'audio' ? 'video' : 'audio')}
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
          className={minimized ? 'mini-stream-dock' : 'stream-stage-card'}
          role={minimized ? 'region' : undefined}
          aria-label={minimized ? `Minimized Bhajan Player: ${currentEntry.title}` : undefined}
        >
          {minimized ? (
            <div className="mini-stream-bar-row">
              <button
                type="button"
                className="mini-stream-title-btn"
                onClick={onExpand}
                title="Open full Stream player"
              >
                <span className="mini-stream-kicker">
                  {isDirectAudio && audioUrl
                    ? `Playing Audio · ${queueIndex + 1}/${queue.length}`
                    : `Video paused · Tap to resume (${queueIndex + 1}/${queue.length})`}
                </span>
                <span className="mini-stream-title">{currentEntry.title}</span>
              </button>

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
                  aria-label={
                    isDirectAudio && audioUrl
                      ? isPlaying
                        ? 'Pause'
                        : 'Play'
                      : 'Open Stream to resume video'
                  }
                  onClick={handleTogglePlayPause}
                >
                  {isDirectAudio && audioUrl ? (isPlaying ? '⏸' : '▶') : '▶'}
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
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onOpenInStudio(currentEntry.id)}
                >
                  Open in Studio
                </button>
              </div>
            </div>
          )}

          {/* Audio stays mounted across full <-> minimized for zero-interruption MP3 playback; video never renders in Minimized mode */}
          <div className={minimized ? 'mini-stream-audio-slot' : undefined}>
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
                      onClick={() => onMediaModeChange('video')}
                    >
                      Show Video
                    </button>
                  </div>
                )}
              </div>
            ) : minimized ? null : loadingDetail && !currentBhajan ? (
              <p className="field-hint" style={{ margin: 0 }}>
                Loading stream audio and lyrics…
              </p>
            ) : activeRec?.youtubeVideoId ? (
              <YouTubeSegmentPlayer
                videoId={activeRec.youtubeVideoId}
                title={activeRec.label}
                startSec={activeRec.startSec}
                endSec={activeRec.endSec}
                embeddable={activeRec.embeddable}
                autoPlay={autoPlay}
                onMediaModeChange={mediaMode === 'video' ? onMediaModeChange : undefined}
                onEnded={autoPlay ? onNext : undefined}
              />
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
                No playable audio source is linked to this bhajan yet — click Next or Open in Studio.
              </p>
            )}
          </div>

          {!minimized && currentBhajan?.lyricsSets?.[0]?.lines?.length ? (
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
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => onOpenInStudio(rec.entry.id)}
                    >
                      Studio
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
