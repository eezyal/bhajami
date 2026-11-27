import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Path,
  Stop,
  LinearGradient as SvgLinearGradient,
} from 'react-native-svg';
import {
  SPLASH_STATUS_STEPS,
  SPLASH_WORDMARK_SEQUENCE,
  type SplashWordmarkEntry,
} from '../lib/splash-sequence';

export { SPLASH_WORDMARK_SEQUENCE };

interface BhajamiSplashOverlayProps {
  visible: boolean;
  ready: boolean;
  progress: number;
  onFinish: () => void;
}

const LOTUS_ANGLES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] as const;
const SERIF_FONT = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  default: 'Georgia',
});

export function BhajamiSplashOverlay({
  visible,
  ready,
  progress,
  onFinish,
}: BhajamiSplashOverlayProps) {
  const [seqIndex, setSeqIndex] = useState(0);
  const [minElapsed, setMinElapsed] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  const overlayOpacity = useRef(new Animated.Value(1)).current;
  const wordOpacity = useRef(new Animated.Value(1)).current;
  const wordScale = useRef(new Animated.Value(1)).current;
  const lotusSpin = useRef(new Animated.Value(0)).current;
  const flamePulse = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(Math.max(0.12, progress))).current;
  const finishingRef = useRef(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active) setReduceMotion(Boolean(enabled));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setMinElapsed(true), 2100);
    return () => clearTimeout(timer);
  }, [visible]);

  useEffect(() => {
    const clamped = Math.max(0.08, Math.min(1, progress));
    Animated.timing(progressAnim, {
      toValue: clamped,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [progress, progressAnim]);

  useEffect(() => {
    if (!visible || reduceMotion) return;

    const lotusAnim = Animated.loop(
      Animated.timing(lotusSpin, {
        toValue: 1,
        duration: 60000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    const diyaAnim = Animated.loop(
      Animated.sequence([
        Animated.timing(flamePulse, {
          toValue: 1,
          duration: 1100,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(flamePulse, {
          toValue: 0,
          duration: 1100,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    lotusAnim.start();
    diyaAnim.start();
    return () => {
      lotusAnim.stop();
      diyaAnim.stop();
    };
  }, [flamePulse, lotusSpin, reduceMotion, visible]);

  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => {
      if (reduceMotion) {
        setSeqIndex((prev) => (prev + 1) % SPLASH_WORDMARK_SEQUENCE.length);
        return;
      }

      Animated.parallel([
        Animated.timing(wordOpacity, {
          toValue: 0,
          duration: 260,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(wordScale, {
          toValue: 1.03,
          duration: 260,
          useNativeDriver: true,
        }),
      ]).start(() => {
        setSeqIndex((prev) => (prev + 1) % SPLASH_WORDMARK_SEQUENCE.length);
        wordScale.setValue(0.94);
        Animated.parallel([
          Animated.timing(wordOpacity, {
            toValue: 1,
            duration: 320,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(wordScale, {
            toValue: 1,
            duration: 320,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]).start();
      });
    }, 1150);

    return () => clearInterval(interval);
  }, [reduceMotion, visible, wordOpacity, wordScale]);

  const dismissOverlay = useCallback(() => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    Animated.timing(overlayOpacity, {
      toValue: 0,
      duration: 340,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(() => {
      onFinish();
    });
  }, [onFinish, overlayOpacity]);

  useEffect(() => {
    if (visible && ready && minElapsed) {
      dismissOverlay();
    }
  }, [dismissOverlay, minElapsed, ready, visible]);

  if (!visible) return null;

  const entry: SplashWordmarkEntry =
    SPLASH_WORDMARK_SEQUENCE[seqIndex % SPLASH_WORDMARK_SEQUENCE.length];
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  const statusIdx = Math.min(
    SPLASH_STATUS_STEPS.length - 1,
    Math.floor(Math.max(0, Math.min(0.99, progress)) * SPLASH_STATUS_STEPS.length),
  );
  const statusText = ready ? SPLASH_STATUS_STEPS[3] : SPLASH_STATUS_STEPS[statusIdx];

  const lotusRotate = lotusSpin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
  const flameScale = flamePulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.96, 1.07],
  });
  const flameOpacity = flamePulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.88, 1],
  });
  const fillWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <Animated.View style={[styles.backdrop, { opacity: overlayOpacity }]}>
      <LinearGradient
        colors={['#171324', '#12101a', '#0a090f']}
        locations={[0, 0.52, 1]}
        style={StyleSheet.absoluteFill}
      />

      <LinearGradient
        colors={['rgba(242, 140, 56, 0.16)', 'rgba(246, 198, 103, 0.05)', 'rgba(18, 16, 26, 0)']}
        style={styles.auraGlow}
      />

      <Animated.View
        pointerEvents="none"
        style={[
          styles.lotusLayer,
          !reduceMotion ? { transform: [{ rotate: lotusRotate }] } : undefined,
        ]}
      >
        <Svg width={310} height={310} viewBox="0 0 240 240" fill="none">
          <G stroke="#f6c667" strokeWidth={0.95}>
            <Circle cx={120} cy={120} r={108} strokeDasharray="3 5" strokeOpacity={0.85} />
            <Circle cx={120} cy={120} r={88} strokeOpacity={0.6} />
            <Circle cx={120} cy={120} r={46} strokeDasharray="1.5 4" strokeOpacity={0.7} />
            {LOTUS_ANGLES.map((angle) => (
              <Path
                key={angle}
                d="M120 14 C135 46, 135 72, 120 92 C105 72, 105 46, 120 14 Z"
                transform={`rotate(${angle} 120 120)`}
              />
            ))}
          </G>
        </Svg>
      </Animated.View>

      <Pressable
        style={styles.foreground}
        onPress={ready ? dismissOverlay : undefined}
        accessibilityRole="button"
        accessibilityLabel="bhaJami splash screen"
      >
        <Text style={styles.greetingTop}>— SAI RAM —</Text>

        <View style={styles.centerStage}>
          <Animated.View
            style={[
              styles.wordSlot,
              {
                opacity: wordOpacity,
                transform: [{ scale: wordScale }],
              },
            ]}
          >
            {entry.kind === 'english' ? (
              <Text style={[styles.wordText, { fontFamily: SERIF_FONT, fontSize: 52 }]}>
                <Text style={styles.wordCream}>Bha</Text>
                <Text style={styles.wordGoldItalic}>Jam</Text>
                <Text style={styles.wordCream}>I</Text>
              </Text>
            ) : (
              <Text
                style={[
                  styles.wordText,
                  styles.wordCream,
                  {
                    fontSize: entry.fontSize ?? 42,
                    letterSpacing: entry.letterSpacing ?? 0.5,
                  },
                ]}
              >
                {entry.text}
              </Text>
            )}
          </Animated.View>

          <Text style={styles.tagline}>SRI SATHYA SAI BHAJANS COMPANION</Text>
          <LinearGradient
            colors={['#e86f2c', '#f6c667']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.saffronDivider}
          />
        </View>

        <View style={styles.bottomLoader}>
          <Animated.View
            style={[
              styles.diyaWrap,
              !reduceMotion
                ? { transform: [{ scale: flameScale }], opacity: flameOpacity }
                : undefined,
            ]}
          >
            <Svg width={38} height={38} viewBox="0 0 40 40" fill="none">
              <Defs>
                <SvgLinearGradient id="flameGrad" x1="20" y1="5" x2="20" y2="20">
                  <Stop offset="0%" stopColor="#fff4cc" />
                  <Stop offset="55%" stopColor="#f6c667" />
                  <Stop offset="100%" stopColor="#e86f2c" />
                </SvgLinearGradient>
                <SvgLinearGradient id="bowlGrad" x1="9" y1="22" x2="31" y2="32">
                  <Stop offset="0%" stopColor="#f6c667" />
                  <Stop offset="50%" stopColor="#d8822a" />
                  <Stop offset="100%" stopColor="#a8501c" />
                </SvgLinearGradient>
              </Defs>
              <Path
                d="M20 5 C23.5 11, 25 14.5, 23 18.5 C21.8 20.5, 18.2 20.5, 17 18.5 C15 14.5, 16.5 11, 20 5 Z"
                fill="url(#flameGrad)"
              />
              <Path
                d="M20 10 C21.6 13.2, 22.1 15.2, 21.2 17.2 C20.6 18.2, 19.4 18.2, 18.8 17.2 C17.9 15.2, 18.4 13.2, 20 10 Z"
                fill="#fff9eb"
              />
              <Path
                d="M9 22 C10 29, 14.5 32, 20 32 C25.5 32, 30 29, 31 22 C27 24, 13 24, 9 22 Z"
                fill="url(#bowlGrad)"
              />
              <Ellipse cx={20} cy={33.5} rx={6} ry={1.6} fill="#c47a2c" opacity={0.7} />
            </Svg>
          </Animated.View>

          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFillWrap, { width: fillWidth }]}>
              <LinearGradient
                colors={['#e86f2c', '#f6c667']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
          </View>

          <View style={styles.progressMeta}>
            <Text style={styles.statusMessage}>{statusText}</Text>
            <Text style={styles.progressPercent}>{pct}%</Text>
          </View>

          {ready ? <Text style={styles.skipHint}>Tap anywhere to enter</Text> : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    backgroundColor: '#12101a',
  },
  auraGlow: {
    position: 'absolute',
    top: '16%',
    left: '8%',
    right: '8%',
    height: '58%',
    borderRadius: 280,
  },
  lotusLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.24,
  },
  foreground: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 56,
    paddingBottom: 42,
    paddingHorizontal: 28,
  },
  greetingTop: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 4,
    color: '#e6be6c',
    opacity: 0.92,
  },
  centerStage: {
    width: '100%',
    alignItems: 'center',
  },
  wordSlot: {
    minHeight: 86,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  wordText: {
    fontWeight: '700',
    textAlign: 'center',
    textShadowColor: 'rgba(246, 198, 103, 0.35)',
    textShadowOffset: { width: 0, height: 3 },
    textShadowRadius: 18,
  },
  wordCream: {
    color: '#fff9eb',
  },
  wordGoldItalic: {
    color: '#f6c667',
    fontStyle: 'italic',
  },
  tagline: {
    marginTop: 12,
    fontSize: 11.5,
    fontWeight: '600',
    letterSpacing: 2.5,
    color: '#e6be6c',
    textAlign: 'center',
    lineHeight: 19,
    maxWidth: 270,
  },
  saffronDivider: {
    marginTop: 18,
    width: 36,
    height: 3.5,
    borderRadius: 999,
  },
  bottomLoader: {
    width: '100%',
    maxWidth: 280,
    alignItems: 'center',
    gap: 12,
  },
  diyaWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressTrack: {
    width: '100%',
    height: 3.5,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    overflow: 'hidden',
  },
  progressFillWrap: {
    height: '100%',
    borderRadius: 999,
    overflow: 'hidden',
  },
  progressMeta: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusMessage: {
    fontSize: 11,
    color: 'rgba(255, 249, 235, 0.72)',
  },
  progressPercent: {
    fontSize: 11,
    fontWeight: '600',
    color: '#e6be6c',
    fontVariant: ['tabular-nums'],
  },
  skipHint: {
    fontSize: 10.5,
    letterSpacing: 0.8,
    color: 'rgba(230, 190, 108, 0.78)',
    marginTop: 2,
  },
});
