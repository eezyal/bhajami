---
name: sairhythms-scrubber
description: Scrapes bhajan metadata, multi-script lyrics, dual pitches, raga notes, glossary, and sheet music links from sairhythms.sathyasai.org and merges them with local MP3 archives.
---

# Sai Rhythms Scrubber & Local MP3 Merger

## Confirmed Drupal 7 Selectors (`sairhythms.sathyasai.org/song/<slug>`)
Under `.devotional-song-content` and `.devotional-song-meta-data-grid`:
- `.devotional-song-content .lyrics-set` -> `.song-first-line` + `.song-line` (paired with `.alt-lyrics .alt-lyrics-title`)
- `.devotional-song-meaning` -> English meaning/translation
- `.audio-row source[src]` -> Reference MP3 URL (resolved against `https://sairhythms.sathyasai.org`)
- `.deity-row`, `.language-row`, `.beat-row`, `.level-row`, `.tempo-row`
- `.raga-row` -> `.raga-title` + `.raga-notes-panel` (Sargam + `In the Key of C:`)
- `.pitch-row` -> `Reference Gents Pitch`, `Reference Ladies Pitch`, `Music notes for First Line`, `Notes Range`
- `#sheet-music-viewer[src]` -> Sheet music PDF viewer link
- `.field-name-field-song-glossary .field-item` -> `.devotional-song-glossary-term` + `.devotional-song-glossary-term-description`

## Running the Pipeline
```bash
python3 tools/catalog-pipeline/build_catalog.py
python3 tools/catalog-pipeline/build_catalog.py --slugs "sundara-sundara-vinayaka,manasa-bhajare"
```

## Rules
1. Enforce at least `1.0s` delay between uncached HTTP GETs and cache HTML pages under `tools/catalog-pipeline/.cache/`.
2. Never call `/song/signup/api`; use public `/song/<slug>` HTML pages only.
3. Preserve local MP3 matches across `/Users/chax/Downloads/BhajanDownloader` and `/Users/chax/Downloads/RaviMp3`.
