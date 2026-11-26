# bhaJami Pre-Launch Handoff

## Project & Repository
- **Workspace root**: `/Users/chax/.gemini/antigravity/scratch/bhajami`
- **GitHub**: `https://github.com/eezyal/bhajami.git` (branch `main`, latest code commit prior to handoff: `ac50b4d`)
- **Firebase project**: `saibhajanverse` (`.firebaserc`). Local Admin credentials are not stored on disk; Firestore write jobs run in GitHub Actions via `.github/workflows/daily-catalog-sync.yml` using the `FIREBASE_SERVICE_ACCOUNT_JSON` secret. Public Firestore REST (`https://firestore.googleapis.com/v1/projects/saibhajanverse/databases/(default)/documents`) can be queried read-only locally.
- **Prior conversation**: [Previous conversation](conversation://a29845f2-b154-4b13-8d94-6a331f53689e)

## Monorepo Layout
- `apps/web`: Next.js web app (`src/components/JamStudioClient.tsx`, `StreamRadioView.tsx`, `YouTubeSegmentPlayer.tsx`, `AdminModerationClient.tsx`, `SuggestCorrectionDialog.tsx`, `AuthDialog.tsx`, `src/lib/catalog-store.ts`, `curation-store.ts`, `firestore-rest.ts`, `index-cache.ts`, `user-library.ts`)
- `apps/mobile`: Expo SDK 52 React Native app (`App.tsx`, `app.json`, `metro.config.js`, `src/`, `tests/`), cloud two-tier index, phonetic search, 4-tab App Mode, local Wi-Fi LAN dev binding (`0c289a9`)
- `packages/shared`: Core contracts, Module 0 Sanskrit phonetic equivalence engine (`phonetics`), missing-field computation, similar-raga recommendations
- `tools/catalog-pipeline`: Python ingestion & sharded index pipeline (`crawl_sairhythms.py`, `sync_sssmediacentre.py`, `sync_youtube.py`, `normalize_legacy_youtube_docs.py`, `index_builder.py`, `phonetics.py`, `sssmc_bhajan_a_day_urls.txt` with `398` seeded URLs)
- **Firebase config**: `firebase.json`, `firestore.rules`, `firestore.indexes.json`

## Live Cloud Catalog State (`catalogMeta/latest`)
- **Version**: `v9` (updated `2026-11-26T16:45:02Z`)
- **Total bhajans**: `2,073` across 4 shards (`v9_shard_001`..`v9_shard_004`)
- **Verified Sai Rhythms**: `600`
- **YouTube videos**: `1,515`
- **Bhajan Downloader / local recordings**: `438`
- **Needs verification**: `152`
- **Missing lyrics**: `325`

## Established Product Decisions & Preferences
- **Audio priority & strict deduplication (`6cc6cdc`)**: Prefer SSS Media Centre audio over Sai Rhythms on verified duplicates; enforce stringent full-lyrics comparison (not just first-line similarity) to prevent false merges.
- **Admin review routing (`6cc6cdc`)**: Route uncertain or conflicting bhajan/duplicate matches to the Admin Moderation view (`AdminModerationClient.tsx`) rather than silently merging.
- **Audio-first & minimized YouTube playback (`06cee61`, `7f751d1`)**: Unified audio-first playback with an explicit `Show Video` toggle; YouTube links continue playing while browsing other features inside a YouTube-TOS-compliant `200x200` minimized bottom dock with play/pause/next/prev controls.
- **Clean YouTube lyrics extraction (`ac50b4d`)**: `FOOTER_STOP_RE` and `strip_youtube_lyrics_footer` in `tools/catalog-pipeline/sync_youtube.py` strip `"Regular Prasanthi Mandir Schedule (IST)"` and SSS Media Centre channel/feedback footers on future syncs; `tools/catalog-pipeline/normalize_legacy_youtube_docs.py` retroactively cleaned existing Firestore docs (`0` remaining hits verified live on `v9`). Always preserve `bhajamiOverride: true`.
- **Working cadence**: Stepping through remaining bugs, polish, and release readiness items one-by-one before public web, Android, and iOS launch.

## Key Commands & Workflows
- **Tests**:
  - `npm run test:phase1`
  - `npm run test:phase5`
  - `npm run test:phonetics`
  - `npm run test:recommendations`
  - `npm run test:mobile`
  - `python3 -m unittest discover -s tools/catalog-pipeline -p 'test_*.py'`
- **Web build/dev**: `npm run dev`, `npm run build`
- **GitHub Actions manual catalog sync**:
  - `gh workflow run daily-catalog-sync.yml -f skip_sairhythms=true`
  - Add `-f normalize_legacy_youtube=true` when running legacy YouTube document normalization.

## Open / Next Launch Items
- Continue working through the user's pre-public launch checklist one-by-one.
- Verify/expand the SSSMC Bhajan A Day A–Z URL list beyond the `398` seeded URLs if desired, and continue incremental Sai Rhythms sync (`600` verified so far).
- Review the `152` items needing verification and `325` missing-lyrics items in Admin / pipeline.
- Android & iOS production packaging (EAS/native builds, store metadata, real-device YouTube & audio playback testing) and public web deployment.
