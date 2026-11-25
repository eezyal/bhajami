---
name: sairhythms-scrubber
description: Scrapes Sai Rhythms (28 languages) and YouTube channels (`Prasanthi Mandir Live` & `Sri Sathya Sai Bhajans`), compiles bounded Firestore search shards, and enforces Module 0 Sanskrit phonetic parity.
---

# bhaJami Sai Rhythms & YouTube Ingestion Pipeline

## Core Scripts (`tools/catalog-pipeline/`)
- **Sai Rhythms 28-Language Crawler**: `tools/catalog-pipeline/crawl_sairhythms.py`
  - Uses `BeautifulSoup` (`lxml` with `html.parser` fallback) and gzipped disk caching in `.cache/`.
  - Persists resume/diff checkpoints in SQLite (`crawl_state.sqlite3`) and append-only audit events (`crawl_audit.jsonl`).
  - Preserves human-curated `bhajamiOverride: True` fields when merging into Firestore `bhajans/{id}`.
  - Extracts conservative `(var)` glossary spelling variants (`normalized_word_sim >= 0.78`, rejecting `(f)`/`(m)` gender shifts & `doNotMergePairs`) into `packages/shared/data/glossary-variant-seeds.json`.
- **YouTube Data API v3 Two-Pass Sync**: `tools/catalog-pipeline/sync_youtube.py`
  - Uses stdlib `urllib.request` across Prasanthi Mandir Live (`PLC4MvBXcP7HJS5hkJufdFZzQsfJBzQMBc`) and Sri Sathya Sai Bhajans (`UCWW5Z9BGsa14XLFXdRf01TA`).
  - Pass 1 handles singles and unchaptered `> 390s` (`ambiguous_long` -> `needs_verification`).
  - Pass 2 slices embeddable multi-song volumes into deterministic chapter recordings (`yt_<videoId>_t<startSec>`).
- **Slim Sharded Index Compiler**: `tools/catalog-pipeline/index_builder.py`
  - Projects `Bhajan` documents into `BhajanIndexEntry` records, packs `< 350 KB` shards (`MAX_SHARD_BYTES = 345_000`) into `catalogIndexShards/{shardId}`, and updates `catalogMeta/latest`.
- **Module 0 Equivalence**: `packages/shared/data/indic-phonetics.json` shared identically by `packages/shared/src/phonetics.ts` and `tools/catalog-pipeline/phonetics.py`.

## Automated Daily Sync
- `.github/workflows/daily-catalog-sync.yml` runs daily at `$0` Spark cost (`npm run test:phonetics` gate -> Sai Rhythms delta slice `--max-songs-per-run 60` -> incremental YouTube sync -> shard index rebuild).

## Rules
1. Always enforce `>= 10.2s` delay between uncached `sairhythms.sathyasai.org` requests (`robots.txt` `Crawl-delay: 10`).
2. Never exceed `--max-firestore-writes 4000` per batch run on Spark tier.
3. Keep personal `/Users/chax/Downloads/...` MP3 scans strictly gated behind `LOCAL_ARCHIVE_ENABLED=true` or `--include-local-archives`.
4. Always run `npm run test:phonetics` before publishing catalog updates.
