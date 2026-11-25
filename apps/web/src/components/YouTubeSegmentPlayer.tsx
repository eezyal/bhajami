'use client';

import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { StreamMediaMode } from '@bhajami/shared';

export interface YouTubeSegmentPlayerHandle {
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
}

export interface YouTubeSegmentPlayerProps {
  videoId: string;
  title: string;
  startSec?: number;
  endSec?: number;
  embeddable?: boolean;
  playbackRate?: number;
  autoPlay?: boolean;
  mediaMode?: StreamMediaMode;
  onMediaModeChange?: (next: StreamMediaMode) => void;
  minimized?: boolean;
  onEnded?: () => void;
  onPlayStateChange?: (playing: boolean) => void;
}

interface YTPlayerInstance {
  destroy: () => void;
  playVideo?: () => void;
  pauseVideo?: () => void;
  getPlayerState?: () => number;
  setPlaybackRate: (suggestedRate: number) => void;
  getAvailablePlaybackRates: () => number[];
  setPlaybackQuality?: (suggestedQuality: string) => void;
}

interface YTPlayerEvent {
  target: YTPlayerInstance;
  data?: number;
}

interface YTNamespace {
  Player: new (
    element: HTMLElement | string,
    options: {
      videoId: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: YTPlayerEvent) => void;
        onStateChange?: (event: YTPlayerEvent) => void;
        onError?: (event: YTPlayerEvent) => void;
      };
    },
  ) => YTPlayerInstance;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const DEFAULT_YT_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

let youtubeApiPromise: Promise<YTNamespace | null> | null = null;

function loadYouTubeIframeApi(): Promise<YTNamespace | null> {
  if (typeof window === 'undefined') {
    return Promise.resolve(null);
  }
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }
  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }

  youtubeApiPromise = new Promise<YTNamespace | null>((resolve) => {
    const existingReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof existingReady === 'function') {
        existingReady();
      }
      resolve(window.YT ?? null);
    };

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.youtube.com/iframe_api"]',
    );
    if (!existingScript) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => resolve(null);
      document.head.appendChild(tag);
    }
  });

  return youtubeApiPromise;
}

function snapPlaybackRate(target: number, supportedRates: number[]): number {
  const pool = supportedRates.length > 0 ? supportedRates : DEFAULT_YT_RATES;
  let best = pool[0];
  let bestDiff = Math.abs(target - best);
  for (const candidate of pool) {
    const diff = Math.abs(target - candidate);
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return best;
}

function formatSecLabel(sec?: number): string {
  if (sec === undefined || Number.isNaN(sec)) return '';
  const total = Math.max(0, Math.floor(sec));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const rem = total % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

/**
 * Visible TOS-compliant YouTube IFrame player supporting chapter `startSec`/`endSec`
 * bounds, playback rate snapping, sticky Audio Saver (`vq=small`) vs Video quality hint,
 * imperative play/pause control, and an external fallback link when embedding is disabled.
 */
export const YouTubeSegmentPlayer = forwardRef<
  YouTubeSegmentPlayerHandle,
  YouTubeSegmentPlayerProps
>(function YouTubeSegmentPlayer(
  {
    videoId,
    title,
    startSec,
    endSec,
    embeddable = true,
    playbackRate = 1.0,
    autoPlay = false,
    mediaMode = 'video',
    onMediaModeChange,
    minimized = false,
    onEnded,
    onPlayStateChange,
  },
  ref,
) {
  const hostId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;
  const mediaModeRef = useRef(mediaMode);
  mediaModeRef.current = mediaMode;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const onPlayStateChangeRef = useRef(onPlayStateChange);
  onPlayStateChangeRef.current = onPlayStateChange;
  const autoPlayRef = useRef(autoPlay);
  autoPlayRef.current = autoPlay;

  const [embedBlocked, setEmbedBlocked] = useState(embeddable === false);
  const [appliedRate, setAppliedRate] = useState(1.0);

  useImperativeHandle(
    ref,
    () => ({
      play: () => {
        try {
          playerRef.current?.playVideo?.();
        } catch {
          // ignore
        }
      },
      pause: () => {
        try {
          playerRef.current?.pauseVideo?.();
        } catch {
          // ignore
        }
      },
      togglePlay: () => {
        try {
          const st = playerRef.current?.getPlayerState?.();
          if (st === 1 || st === 3) {
            playerRef.current?.pauseVideo?.();
          } else {
            playerRef.current?.playVideo?.();
          }
        } catch {
          // ignore
        }
      },
    }),
    [],
  );

  useEffect(() => {
    setEmbedBlocked(embeddable === false);
  }, [embeddable, videoId]);

  const watchUrl = useMemo(() => {
    const startParam =
      typeof startSec === 'number' && startSec > 0 ? `&t=${Math.floor(startSec)}s` : '';
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}${startParam}`;
  }, [videoId, startSec]);

  useEffect(() => {
    if (embedBlocked || !hostRef.current || !videoId) {
      return;
    }

    let cancelled = false;
    let playerInstance: YTPlayerInstance | null = null;
    const containerEl = hostRef.current;

    void loadYouTubeIframeApi().then((YT) => {
      if (cancelled || !YT?.Player || !containerEl) {
        return;
      }

      const mountTarget = document.createElement('div');
      mountTarget.id = `${hostId}-yt`;
      containerEl.innerHTML = '';
      containerEl.appendChild(mountTarget);

      const playerVars: Record<string, string | number> = {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        autoplay: autoPlayRef.current ? 1 : 0,
      };
      if (mediaModeRef.current === 'audio') {
        playerVars.vq = 'small';
      }
      if (typeof startSec === 'number' && startSec > 0) {
        playerVars.start = Math.floor(startSec);
      }
      if (typeof endSec === 'number' && endSec > 0) {
        playerVars.end = Math.floor(endSec);
      }

      playerInstance = new YT.Player(mountTarget, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars,
        events: {
          onReady: (ev) => {
            if (cancelled) return;
            const rates = ev.target.getAvailablePlaybackRates?.() || DEFAULT_YT_RATES;
            const snapped = snapPlaybackRate(playbackRateRef.current, rates);
            try {
              ev.target.setPlaybackRate(snapped);
              if (mediaModeRef.current === 'audio') {
                ev.target.setPlaybackQuality?.('small');
              }
              if (autoPlayRef.current) {
                ev.target.playVideo?.();
              }
            } catch {
              // ignore unsupported controls on live streams
            }
            setAppliedRate(snapped);
          },
          onStateChange: (ev) => {
            if (cancelled) return;
            if (ev.data === 1) {
              onPlayStateChangeRef.current?.(true);
            } else if (ev.data === 2) {
              onPlayStateChangeRef.current?.(false);
            } else if (ev.data === 0) {
              onPlayStateChangeRef.current?.(false);
              onEndedRef.current?.();
            }
          },
          onError: (ev) => {
            if (ev.data === 101 || ev.data === 150) {
              setEmbedBlocked(true);
            }
          },
        },
      });
      playerRef.current = playerInstance;
    });

    return () => {
      cancelled = true;
      playerRef.current = null;
      if (playerInstance) {
        try {
          playerInstance.destroy();
        } catch {
          // ignore teardown errors
        }
      }
      if (containerEl) {
        containerEl.innerHTML = '';
      }
    };
  }, [embedBlocked, endSec, hostId, startSec, videoId]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || embedBlocked) return;
    try {
      player.setPlaybackQuality?.(mediaMode === 'audio' ? 'small' : 'default');
    } catch {
      // ignore
    }
  }, [embedBlocked, mediaMode]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || embedBlocked) return;
    try {
      const rates = player.getAvailablePlaybackRates?.() || DEFAULT_YT_RATES;
      const snapped = snapPlaybackRate(playbackRate, rates);
      player.setPlaybackRate(snapped);
      setAppliedRate(snapped);
    } catch {
      // player not yet ready; appliedRate updates in onReady
    }
  }, [embedBlocked, playbackRate]);

  if (embedBlocked) {
    return (
      <div className="yt-fallback-box">
        <p style={{ margin: '0 0 0.5rem', fontSize: '0.84rem', color: 'var(--muted)' }}>
          Embedding is disabled by the uploader for <strong>{title}</strong>.
        </p>
        <a
          href={watchUrl}
          target="_blank"
          rel="noreferrer"
          className="btn btn-sm btn-primary"
        >
          Watch on YouTube
        </a>
      </div>
    );
  }

  const chapterSpan =
    typeof startSec === 'number' && typeof endSec === 'number' && endSec > startSec
      ? `Segment ${formatSecLabel(startSec)}–${formatSecLabel(endSec)}`
      : null;

  return (
    <div
      className={`yt-player-shell${
        mediaMode === 'audio' && !minimized ? ' yt-player-shell--compact' : ''
      }${minimized ? ' yt-player-shell--minimized' : ''}`}
    >
      <div
        ref={hostRef}
        className="yt-player-frame"
        aria-label={`YouTube player for ${title}`}
      />
      {!minimized && (
        <div className="yt-player-meta">
          <span>
            {chapterSpan ? `${chapterSpan} · ` : ''}
            {mediaMode === 'audio' ? 'Data Saver' : 'Video'} · Speed: {appliedRate.toFixed(2)}x
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            {onMediaModeChange && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onMediaModeChange(mediaMode === 'audio' ? 'video' : 'audio')}
              >
                {mediaMode === 'audio' ? 'Switch to Video' : 'Audio Saver'}
              </button>
            )}
            <a
              href={watchUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent)', fontWeight: 600 }}
            >
              Watch on YouTube
            </a>
          </div>
        </div>
      )}
    </div>
  );
});
