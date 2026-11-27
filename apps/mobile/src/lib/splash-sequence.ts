export interface SplashWordmarkEntry {
  kind: 'english' | 'script';
  text: string;
  scriptLabel: string;
  fontSize?: number;
  letterSpacing?: number;
  isRtl?: boolean;
}

export const SPLASH_STATUS_STEPS = [
  'Tuning into devotion...',
  'Gathering sacred lyrics...',
  'Harmonizing scales...',
  'Ready for bhajans...',
] as const;

const SANSKRIT_ENTRY: SplashWordmarkEntry = {
  kind: 'script',
  text: 'भजामि',
  scriptLabel: 'Sanskrit',
  fontSize: 44,
};

const ENGLISH_ENTRY: SplashWordmarkEntry = {
  kind: 'english',
  text: 'BhaJamI',
  scriptLabel: 'English',
  fontSize: 48,
};

export const TOP_15_INDIAN_WORDMARKS: readonly SplashWordmarkEntry[] = [
  { kind: 'script', text: 'भजामि', scriptLabel: 'Hindi', fontSize: 44 },
  { kind: 'script', text: 'ভজামি', scriptLabel: 'Bengali', fontSize: 44 },
  { kind: 'script', text: 'भजामि', scriptLabel: 'Marathi', fontSize: 44 },
  { kind: 'script', text: 'భజామి', scriptLabel: 'Telugu', fontSize: 42 },
  { kind: 'script', text: 'பஜாமி', scriptLabel: 'Tamil', fontSize: 38 },
  { kind: 'script', text: 'ભજામિ', scriptLabel: 'Gujarati', fontSize: 42 },
  { kind: 'script', text: 'بھجامی', scriptLabel: 'Urdu', fontSize: 42, isRtl: true },
  { kind: 'script', text: 'ಭಜಾಮಿ', scriptLabel: 'Kannada', fontSize: 40 },
  { kind: 'script', text: 'ଭଜାମି', scriptLabel: 'Odia', fontSize: 42 },
  { kind: 'script', text: 'ഭജാമി', scriptLabel: 'Malayalam', fontSize: 36 },
  { kind: 'script', text: 'ਭਜਾਮਿ', scriptLabel: 'Punjabi', fontSize: 42 },
  { kind: 'script', text: 'ভজামি', scriptLabel: 'Assamese', fontSize: 44 },
  { kind: 'script', text: 'भजामि', scriptLabel: 'Maithili', fontSize: 44 },
  { kind: 'script', text: 'ᱵᱷᱟᱡᱟᱢᱤ', scriptLabel: 'Santali', fontSize: 34 },
  { kind: 'script', text: 'بھجامی', scriptLabel: 'Kashmiri', fontSize: 42, isRtl: true },
];

export const TOP_15_WORLD_WORDMARKS: readonly SplashWordmarkEntry[] = [
  { kind: 'script', text: '巴贾米', scriptLabel: 'Chinese', fontSize: 42, letterSpacing: 4 },
  { kind: 'script', text: 'Adoro', scriptLabel: 'Spanish', fontSize: 42 },
  { kind: 'script', text: 'J’adore', scriptLabel: 'French', fontSize: 42 },
  { kind: 'script', text: 'بهاجامي', scriptLabel: 'Arabic', fontSize: 42, isRtl: true },
  { kind: 'script', text: 'Eu adoro', scriptLabel: 'Portuguese', fontSize: 40 },
  { kind: 'script', text: 'Бхаджами', scriptLabel: 'Russian', fontSize: 38 },
  { kind: 'script', text: 'バジャミ', scriptLabel: 'Japanese', fontSize: 38, letterSpacing: 3 },
  { kind: 'script', text: 'Ich verehre', scriptLabel: 'German', fontSize: 38 },
  { kind: 'script', text: 'Ku memuja', scriptLabel: 'Indonesian', fontSize: 38 },
  { kind: 'script', text: '바자미', scriptLabel: 'Korean', fontSize: 42, letterSpacing: 3 },
  { kind: 'script', text: 'Taparım', scriptLabel: 'Turkish', fontSize: 40 },
  { kind: 'script', text: 'Tôi tôn thờ', scriptLabel: 'Vietnamese', fontSize: 38 },
  { kind: 'script', text: 'Io adoro', scriptLabel: 'Italian', fontSize: 40 },
  { kind: 'script', text: 'بجامی', scriptLabel: 'Persian', fontSize: 42, isRtl: true },
  { kind: 'script', text: 'Ninaabudu', scriptLabel: 'Swahili', fontSize: 38 },
];

/**
 * Alternates Sanskrit भजामि -> English BhaJamI -> Indian[i] -> Sanskrit भजामि -> BhaJamI -> World[i].
 */
export const SPLASH_WORDMARK_SEQUENCE: readonly SplashWordmarkEntry[] = (() => {
  const out: SplashWordmarkEntry[] = [];
  for (let i = 0; i < TOP_15_INDIAN_WORDMARKS.length; i += 1) {
    out.push(SANSKRIT_ENTRY, ENGLISH_ENTRY, TOP_15_INDIAN_WORDMARKS[i]);
    if (i < TOP_15_WORLD_WORDMARKS.length) {
      out.push(SANSKRIT_ENTRY, ENGLISH_ENTRY, TOP_15_WORLD_WORDMARKS[i]);
    }
  }
  return out;
})();
