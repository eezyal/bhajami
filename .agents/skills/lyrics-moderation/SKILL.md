---
name: lyrics-moderation
description: Manages community lyric & notation corrections, /admin/corrections Daily Curation Queue, /api/admin/curation transactions, entityAliases, and doNotMergePairs.
---

# bhaJami Community Moderation & Daily Curation Workflow

## Data Collections
- **Firestore**: `bhajans/{id}`, `bhajans/{id}/revisions/{revId}`, `lyricCorrections/{id}`, `entityAliases/{aliasKey}`, `doNotMergePairs/{pairKey}`, `youtubeVideos/{videoId}`, `catalogIndexShards/{shardId}`, `catalogMeta/latest`, `ingestionRuns/{runId}`, `syncState/{source}`, `mail/{mailId}`.
- **Local Fallback Store** (`apps/web/data/` when cloud config is disabled): `corrections-store.json`, `approved-overrides.json`, `approved-new-bhajans.json`, `revisions-store.json`, `email-outbox.json`, `curation-*.json`.

## Contributor Flow (`SuggestCorrectionDialog.tsx` + `JamStudioClient.tsx`)
- Requires non-anonymous Firebase sign-in in cloud mode.
- Surfaces contextual **`Complete Missing Metadata`** CTA computed from `getMissingBhajanFields(bhajan)`.
- Supports all 28 script choices and full notation fields (`arohanam`, `avarohanam`, `firstLineSargam`, `firstLineWestern`, `notesRange`, `sheetMusicUrl`).

## Admin Moderation & Daily Curation (`/admin/corrections`)
- Requires Firebase Admin token (`verifyAdminBearerToken`, defaulting admin email via `NEXT_PUBLIC_ADMIN_EMAIL`).
- **Moderation Tabs** (`PATCH /api/corrections/[id]`): edit lyrics and `editedMetadata` notation before approving; **`Request Further Information`** or **`Reject Submission`** (requires reason + sends proposer follow-up reply link).
- **Daily Curation Workbench** (`/api/admin/curation`):
  - Views: `missing_lyrics`, `needs_verification`, `ambiguous_long`, and `runs` (Pipeline Health).
  - Embeds visible `YouTubeSegmentPlayer` (`>= 320x180px`, `Watch on YouTube` fallback).
  - **`Approve Merge & Save Alias`**: transactionally moves recordings/slugAliases, hides merged stub, and writes `entityAliases`.
  - **`Keep Distinct`**: writes `doNotMergePairs/{sortedA}__${sortedB}` and clears candidate ambiguity.
  - **`Publish Curated Lyrics & Metadata`**: writes `bhajamiOverride: true`, clears `lyricsMissing`, appends `BhajanRevision`.
  - **`Dismiss Non-Bhajan`**: requires reason, excludes `youtubeVideos/{videoId}`, and removes stub.
