import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getMissingBhajanFields,
  parsePitchString,
  parsePitchStringOptional,
  type Bhajan,
} from '../src';

function makeVerifiedBhajan(): Bhajan {
  return {
    id: 'aao-aao-nandalala',
    slug: 'aao-aao-nandalala',
    title: 'Aao Aao Nandalala',
    deity: 'Krishna',
    language: 'Hindi',
    raga: {
      name: 'Kafi',
      arohanam: 'S R2 G2 M1 P D2 N2 S',
      avarohanam: 'S N2 D2 P M1 G2 R2 S',
    },
    beat: 'Kaharwa (4/4)',
    tempo: 'Medium',
    gentsPitch: parsePitchString('1.5 Pancham / C#'),
    ladiesPitch: parsePitchString('6 Pancham / A'),
    firstLineNotes: {
      sargam: 'S R G M P',
      westernInC: 'C D Eb F G',
    },
    meaning: 'Come, O beloved Nandalala.',
    lyricsSets: [
      {
        language: 'Roman',
        script: 'roman',
        lines: ['Aao Aao Nandalala', 'Vrij Bhushana Nandalala'],
      },
      {
        language: 'Devanagari',
        script: 'devanagari',
        lines: ['आओ आओ नन्दलाला', 'व्रज भूषण नन्दलाला'],
      },
    ],
    glossary: [],
    recordings: [],
    metadataSource: 'sairhythms_verified',
    isEstimated: false,
    lyricsMissing: false,
  };
}

describe('getMissingBhajanFields', () => {
  it('returns empty list for a fully curated multi-script bhajan', () => {
    const bhajan = makeVerifiedBhajan();
    assert.deepEqual(getMissingBhajanFields(bhajan), []);
  });

  it('detects synthetic placeholders and isEstimated stubs accurately', () => {
    const stub: Partial<Bhajan> = {
      id: 'sample-stub',
      title: 'Sample Stub',
      meaning: 'Synced from local BhajanDownloader archive without Sai Rhythms match.',
      raga: { name: 'Pending Sai Rhythms Sync' },
      beat: '8 Beat / Keherwa (Est.)',
      tempo: 'Medium',
      gentsPitch: parsePitchString('2 Pancham / D'),
      ladiesPitch: parsePitchString('5.5 Pancham / G# / Ab'),
      isEstimated: true,
      lyricsSets: [
        {
          language: 'Roman',
          script: 'roman',
          lines: ['Full lyrics awaiting Sai Rhythms sync.'],
        },
      ],
    };

    assert.deepEqual(getMissingBhajanFields(stub), [
      'lyrics',
      'meaning',
      'gentsPitch',
      'ladiesPitch',
      'raga',
      'beat',
      'tempo',
      'notation',
      'alternateScripts',
    ]);
  });

  it('flags lyrics when lyricsMissing is true even if lyricsSets is empty', () => {
    const partial: Partial<Bhajan> = {
      title: 'Missing Lyrics Offering',
      meaning: 'Devotional invocation to Lord Shiva.',
      raga: { name: 'Darbari' },
      beat: '4/4',
      tempo: 'Slow',
      gentsPitch: parsePitchString('1 Pancham / C'),
      ladiesPitch: parsePitchString('5.5 Pancham / G# / Ab'),
      firstLineNotes: { sargam: 'S R G', westernInC: 'C D Eb' },
      lyricsMissing: true,
      lyricsSets: [],
    };
    assert.deepEqual(getMissingBhajanFields(partial), ['lyrics', 'alternateScripts']);
  });

  it('flags notation and alternateScripts when only one script and no notation are present', () => {
    const b = makeVerifiedBhajan();
    b.firstLineNotes = null;
    b.lyricsSets = [b.lyricsSets[0]];
    assert.deepEqual(getMissingBhajanFields(b), ['notation', 'alternateScripts']);
  });
});

describe('chromatic pitch helpers', () => {
  it('maps chromatic steps 8 and 9 accurately and guards null inputs', () => {
    const step8 = parsePitchString('5.5 Pancham / G# / Ab');
    assert.equal(step8.semitoneFromC, 8);
    assert.equal(step8.pancham, '5.5 Pancham');
    assert.equal(step8.western, 'G# / Ab');

    const step9 = parsePitchString('6 Pancham / A');
    assert.equal(step9.semitoneFromC, 9);
    assert.equal(step9.pancham, '6 Pancham');
    assert.equal(step9.western, 'A');

    assert.equal(parsePitchString('1.5 Pancham / C# / Db').semitoneFromC, 1);
    assert.equal(parsePitchString('2.5 Pancham / D# / Eb').semitoneFromC, 3);
    assert.equal(parsePitchString('4.5 Pancham / F# / Gb').semitoneFromC, 6);
    assert.equal(parsePitchString('5 Pancham / G').semitoneFromC, 7);
    assert.equal(parsePitchString('6.5 Pancham / A# / Bb').semitoneFromC, 10);

    assert.equal(parsePitchStringOptional(undefined), undefined);
    assert.equal(parsePitchStringOptional(null), undefined);
    assert.equal(parsePitchStringOptional('   '), undefined);
    assert.equal(parsePitchString(null, 8).semitoneFromC, 8);
  });
});
