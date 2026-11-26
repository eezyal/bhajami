import React, {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { StreamMediaMode } from '@bhajami/shared';
import { buildYouTubeWatchUrl, formatChapterRange } from '../lib/search-and-playback';

export interface MobileYouTubePlayerHandle {
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
}

export interface MobileYouTubePlayerProps {
  videoId: string;
  title: string;
  startSec?: number;
  endSec?: number;
  embeddable?: boolean;
  autoPlay?: boolean;
  minimized?: boolean;
  onMediaModeChange?: (next: StreamMediaMode) => void;
  onEnded?: () => void;
  onPlayStateChange?: (playing: boolean) => void;
  theme: {
    surfaceRaised: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    youtubeBg: string;
    youtubeText: string;
  };
}

interface YTPlayerWebInstance {
  destroy: () => void;
  playVideo?: () => void;
  pauseVideo?: () => void;
  getPlayerState?: () => number;
}

interface YTWebGlobal {
  Player: new (
    el: unknown,
    opts: {
      videoId: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: { target: YTPlayerWebInstance }) => void;
        onStateChange?: (e: { target: YTPlayerWebInstance; data?: number }) => void;
        onError?: (e: { target: YTPlayerWebInstance; data?: number }) => void;
      };
    },
  ) => YTPlayerWebInstance;
}

let webApiPromise: Promise<YTWebGlobal | null> | null = null;

function loadWebYouTubeApi(): Promise<YTWebGlobal | null> {
  const g = globalThis as unknown as {
    document?: {
      createElement: (tag: string) => { src: string; async: boolean; onerror: (() => void) | null };
      querySelector: (sel: string) => unknown;
      head?: { appendChild: (node: unknown) => void };
    };
    YT?: YTWebGlobal;
    onYouTubeIframeAPIReady?: () => void;
  };
  if (!g.document) return Promise.resolve(null);
  if (g.YT?.Player) return Promise.resolve(g.YT);
  if (webApiPromise) return webApiPromise;

  webApiPromise = new Promise<YTWebGlobal | null>((resolve) => {
    const prev = g.onYouTubeIframeAPIReady;
    g.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') prev();
      resolve(g.YT ?? null);
    };
    if (!g.document!.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = g.document!.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => resolve(null);
      g.document!.head?.appendChild(script);
    }
  });
  return webApiPromise;
}

function buildNativeYouTubeHtml(params: {
  videoId: string;
  startSec?: number;
  endSec?: number;
  autoPlay: boolean;
}): string {
  const vars: Record<string, string | number> = {
    rel: 0,
    modestbranding: 1,
    playsinline: 1,
    enablejsapi: 1,
    autoplay: params.autoPlay ? 1 : 0,
  };
  if (typeof params.startSec === 'number' && params.startSec > 0) {
    vars.start = Math.floor(params.startSec);
  }
  if (typeof params.endSec === 'number' && params.endSec > 0) {
    vars.end = Math.floor(params.endSec);
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1" />
<style>
  html,body,#player{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;}
</style>
</head>
<body>
<div id="player"></div>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
  var player = null;
  function post(type, code) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, code: code }));
    }
  }
  function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
      videoId: ${JSON.stringify(params.videoId)},
      width: '100%',
      height: '100%',
      playerVars: ${JSON.stringify(vars)},
      events: {
        onReady: function(ev) {
          try {
            if (${params.autoPlay ? 'true' : 'false'}) {
              ev.target.playVideo();
            }
          } catch (e) {}
        },
        onStateChange: function(ev) {
          if (ev.data === 1) post('playing');
          else if (ev.data === 2) post('paused');
          else if (ev.data === 0) post('ended');
        },
        onError: function(ev) {
          post('error', ev.data);
        }
      }
    });
  }
  window.__bhajamiControl = function(cmd) {
    if (!player) return;
    if (cmd === 'play') player.playVideo();
    else if (cmd === 'pause') player.pauseVideo();
    else if (cmd === 'toggle') {
      var st = player.getPlayerState ? player.getPlayerState() : -1;
      if (st === 1 || st === 3) player.pauseVideo();
      else player.playVideo();
    }
  };
</script>
</body>
</html>`;
}

/**
 * Cross-platform (iOS/Android WebView + Expo Web IFrame API) inline YouTube video player
 * rendered only when Video mode is active and full Stream/Studio view is visible.
 */
export const MobileYouTubePlayer = forwardRef<
  MobileYouTubePlayerHandle,
  MobileYouTubePlayerProps
>(function MobileYouTubePlayer(
  {
    videoId,
    title,
    startSec,
    endSec,
    embeddable = true,
    autoPlay = true,
    minimized = false,
    onMediaModeChange,
    onEnded,
    onPlayStateChange,
    theme,
  },
  ref,
) {
  const reactId = useId();
  const webContainerId = useMemo(
    () => `bhajami-yt-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId],
  );
  const webViewRef = useRef<WebView>(null);
  const webPlayerRef = useRef<YTPlayerWebInstance | null>(null);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const onPlayStateRef = useRef(onPlayStateChange);
  onPlayStateRef.current = onPlayStateChange;
  const autoPlayRef = useRef(autoPlay);
  autoPlayRef.current = autoPlay;

  const [embedBlocked, setEmbedBlocked] = useState(embeddable === false);

  useEffect(() => {
    setEmbedBlocked(embeddable === false);
  }, [embeddable, videoId]);

  const watchUrl = useMemo(
    () => buildYouTubeWatchUrl(videoId, startSec),
    [startSec, videoId],
  );
  const chapterLabel = useMemo(
    () => formatChapterRange(startSec, endSec),
    [endSec, startSec],
  );

  useImperativeHandle(
    ref,
    () => ({
      play: () => {
        if (Platform.OS === 'web') {
          webPlayerRef.current?.playVideo?.();
        } else {
          webViewRef.current?.injectJavaScript(`window.__bhajamiControl && window.__bhajamiControl('play'); true;`);
        }
      },
      pause: () => {
        if (Platform.OS === 'web') {
          webPlayerRef.current?.pauseVideo?.();
        } else {
          webViewRef.current?.injectJavaScript(`window.__bhajamiControl && window.__bhajamiControl('pause'); true;`);
        }
      },
      togglePlay: () => {
        if (Platform.OS === 'web') {
          const st = webPlayerRef.current?.getPlayerState?.();
          if (st === 1 || st === 3) webPlayerRef.current?.pauseVideo?.();
          else webPlayerRef.current?.playVideo?.();
        } else {
          webViewRef.current?.injectJavaScript(`window.__bhajamiControl && window.__bhajamiControl('toggle'); true;`);
        }
      },
    }),
    [],
  );

  useEffect(() => {
    if (Platform.OS !== 'web' || embedBlocked || !videoId) return;
    let cancelled = false;
    let instance: YTPlayerWebInstance | null = null;

    const doc = (
      globalThis as unknown as {
        document?: {
          getElementById: (id: string) => { innerHTML: string; appendChild: (el: unknown) => void } | null;
          createElement: (tag: string) => { id: string; style: { width: string; height: string } };
        };
      }
    ).document;

    void loadWebYouTubeApi().then((YT) => {
      if (cancelled || !YT?.Player || !doc) return;
      const host = doc.getElementById(webContainerId);
      if (!host) return;
      const target = doc.createElement('div');
      target.id = `${webContainerId}-iframe`;
      target.style.width = '100%';
      target.style.height = '100%';
      host.innerHTML = '';
      host.appendChild(target);

      const playerVars: Record<string, string | number> = {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        autoplay: autoPlayRef.current ? 1 : 0,
      };
      if (typeof startSec === 'number' && startSec > 0) {
        playerVars.start = Math.floor(startSec);
      }
      if (typeof endSec === 'number' && endSec > 0) {
        playerVars.end = Math.floor(endSec);
      }

      instance = new YT.Player(target, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars,
        events: {
          onReady: (ev) => {
            if (cancelled) return;
            try {
              if (autoPlayRef.current) {
                ev.target.playVideo?.();
              }
            } catch {
              // ignore
            }
          },
          onStateChange: (ev) => {
            if (cancelled) return;
            if (ev.data === 1) onPlayStateRef.current?.(true);
            else if (ev.data === 2) onPlayStateRef.current?.(false);
            else if (ev.data === 0) {
              onPlayStateRef.current?.(false);
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
      webPlayerRef.current = instance;
    });

    return () => {
      cancelled = true;
      webPlayerRef.current = null;
      if (instance) {
        try {
          instance.destroy();
        } catch {
          // ignore
        }
      }
      const host = doc?.getElementById(webContainerId);
      if (host) host.innerHTML = '';
    };
  }, [embedBlocked, endSec, startSec, videoId, webContainerId]);

  const nativeHtml = useMemo(
    () =>
      Platform.OS === 'web'
        ? ''
        : buildNativeYouTubeHtml({
            videoId,
            startSec,
            endSec,
            autoPlay,
          }),
    [autoPlay, endSec, startSec, videoId],
  );

  function handleNativeMessage(event: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as { type?: string; code?: number };
      if (msg.type === 'playing') onPlayStateRef.current?.(true);
      else if (msg.type === 'paused') onPlayStateRef.current?.(false);
      else if (msg.type === 'ended') {
        onPlayStateRef.current?.(false);
        onEndedRef.current?.();
      } else if (msg.type === 'error' && (msg.code === 101 || msg.code === 150)) {
        setEmbedBlocked(true);
      }
    } catch {
      // ignore non-JSON messages
    }
  }

  if (embedBlocked) {
    return (
      <View
        style={[
          styles.fallbackBox,
          { backgroundColor: theme.surfaceRaised, borderColor: theme.border },
        ]}
      >
        <Text style={[styles.metaText, { color: theme.textMuted }]}>
          Embedding is restricted for {title}.
        </Text>
        <Pressable
          onPress={() => void Linking.openURL(watchUrl)}
          style={[styles.ytLinkBtn, { backgroundColor: theme.youtubeBg }]}
        >
          <Text style={[styles.ytLinkBtnText, { color: theme.youtubeText }]}>
            ▶ Open in YouTube
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.shell, minimized ? styles.shellMini : undefined]}>
      <View
        style={[
          minimized ? styles.frameMini : styles.frameFull,
          { borderColor: theme.border },
        ]}
      >
        {Platform.OS === 'web' ? (
          <View nativeID={webContainerId} style={styles.webHost} />
        ) : (
          <WebView
            ref={webViewRef}
            originWhitelist={['*']}
            source={{ html: nativeHtml, baseUrl: 'https://www.youtube.com' }}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            javaScriptEnabled
            domStorageEnabled
            onMessage={handleNativeMessage}
            style={styles.webHost}
          />
        )}
      </View>

      {!minimized && (
        <View style={styles.metaRow}>
          <Text style={[styles.metaText, { color: theme.textMuted }]}>
            {chapterLabel ? `Segment ${chapterLabel} · ` : ''}Video
          </Text>
          <View style={styles.metaActions}>
            {onMediaModeChange && (
              <Pressable
                onPress={() => onMediaModeChange('audio')}
                style={[
                  styles.toggleBtn,
                  { borderColor: theme.border, backgroundColor: theme.surfaceRaised },
                ]}
              >
                <Text style={[styles.toggleBtnText, { color: theme.text }]}>Switch to Audio</Text>
              </Pressable>
            )}
            <Pressable onPress={() => void Linking.openURL(watchUrl)}>
              <Text style={[styles.watchLink, { color: theme.accent }]}>Watch on YouTube</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  shell: { gap: 8, width: '100%' },
  shellMini: { width: 200, gap: 0 },
  frameFull: {
    width: '100%',
    aspectRatio: 16 / 9,
    minHeight: 195,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    backgroundColor: '#000',
  },
  frameMini: {
    width: 200,
    height: 200,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    backgroundColor: '#000',
  },
  webHost: { flex: 1, width: '100%', height: '100%', backgroundColor: '#000' },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  metaActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  metaText: { fontSize: 12 },
  toggleBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  toggleBtnText: { fontSize: 12, fontWeight: '600' },
  watchLink: { fontSize: 12, fontWeight: '700' },
  fallbackBox: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 8 },
  ytLinkBtn: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    alignSelf: 'flex-start',
  },
  ytLinkBtnText: { fontSize: 13, fontWeight: '700' },
});
