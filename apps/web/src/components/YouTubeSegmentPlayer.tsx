'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface YouTubeSegmentPlayerProps {
  videoId: string;
  title: string;
  startSec?: number;
  endSec?: number;
  embeddable?: boolean;
  playbackRate?: number;
}

interface YTPlayerInstance {
  destroy: () => void;
  setPlaybackRate: (suggestedRate: number) => void;
  getAvailablePlaybackRates: () => number[];
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
 * bounds, playback rate snapping, and an external fallback link when embedding is disabled.
 */
export function YouTubeSegmentPlayer({
  videoId,
  title,
  startSec,
  endSec,
  embeddable = true,
  playbackRate = 1.0,
}: YouTubeSegmentPlayerProps) {
  const hostId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;

  const [embedBlocked, setEmbedBlocked] = useState(embeddable === false);
  const [appliedRate, setAppliedRate] = useState(1.0);

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
      };
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
            } catch {
              // ignore unsupported rate error on live streams
            }
            setAppliedRate(snapped);
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
    <div className="yt-player-shell">
      <div
        ref={hostRef}
        className="yt-player-frame"
        aria-label={`YouTube player for ${title}`}
      />
      <div className="yt-player-meta">
        <span>
          {chapterSpan ? `${chapterSpan} · ` : ''}YouTube Speed: {appliedRate.toFixed(2)}x
        </span>
        <a href={watchUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 600 }}>
          Watch on YouTube
        </a>
      </div>
    </div>
  );
}
