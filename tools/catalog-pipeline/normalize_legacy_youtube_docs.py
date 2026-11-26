#!/usr/bin/env python3
"""Retroactive idempotent migration for legacy YouTube-sourced Firestore bhajan documents.

Cleans numbered prefixes ("01 - ") and pipe channel suffixes ("| Sri Sathya Sai Bhajans"),
hydrates `id`/`slug`, converts legacy `lyrics` strings into structured `lyricsSets`, and
ensures `youtubeId` links are represented as embeddable `recordings` entries.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import crawl_sairhythms as crawler  # noqa: E402
import sync_youtube as yt_sync  # noqa: E402

DEFAULT_MAX_FIRESTORE_WRITES = 4000


def _is_legacy_or_youtube_doc(raw: Mapping[str, Any]) -> bool:
    meta_src = str(raw.get("metadataSource") or "").strip()
    source = str(raw.get("source") or "").strip().lower()
    youtube_id = str(raw.get("youtubeId") or "").strip()
    return meta_src.startswith("youtube") or source == "youtube" or bool(youtube_id)


def _clean_recording_label(label: str) -> str:
    clean = str(label or "").strip()
    if not clean:
        return ""
    if ": " in clean:
        prefix, right = clean.split(": ", 1)
        cleaned_right = yt_sync.clean_youtube_display_title(right) or right.strip()
        return f"{prefix}: {cleaned_right}"
    if "|" in clean or clean[:1].isdigit():
        return yt_sync.clean_youtube_display_title(clean) or clean
    return clean


def normalize_bhajan_doc(
    doc_id: str,
    raw: Mapping[str, Any],
    *,
    now_iso: str,
) -> dict[str, Any] | None:
    """Return updated fields for a legacy/YouTube doc, or `None` if already normalized."""
    if raw.get("bhajamiOverride") is True:
        return None
    if not _is_legacy_or_youtube_doc(raw):
        return None

    updated = dict(raw)
    changed = False

    if str(updated.get("id") or "").strip() != doc_id:
        updated["id"] = doc_id
        changed = True
    if not str(updated.get("slug") or "").strip():
        updated["slug"] = doc_id
        changed = True

    raw_title = str(updated.get("title") or "").strip()
    clean_title = yt_sync.clean_youtube_display_title(raw_title) if raw_title else ""
    if clean_title and clean_title != raw_title:
        updated["title"] = clean_title
        changed = True
    effective_title = str(updated.get("title") or doc_id).strip()

    if not str(updated.get("deity") or "").strip() and effective_title:
        inferred_deity = crawler.infer_deity(effective_title)
        if inferred_deity:
            updated["deity"] = inferred_deity
            changed = True

    meta_src = str(updated.get("metadataSource") or "").strip()
    if not meta_src:
        recs_existing = list(updated.get("recordings") or [])
        rec_coll = next(
            (str(r.get("collection") or "").strip() for r in recs_existing if str(r.get("collection") or "").startswith("youtube_")),
            "",
        )
        updated["metadataSource"] = rec_coll or "youtube_sss_bhajans"
        changed = True

    recordings: list[dict[str, Any]] = []
    seen_yt_ids: set[str] = set()
    for rec in updated.get("recordings") or []:
        rec_copy = dict(rec)
        yt_vid = str(rec_copy.get("youtubeVideoId") or "").strip()
        if yt_vid:
            seen_yt_ids.add(yt_vid)
        old_label = str(rec_copy.get("label") or "")
        new_label = _clean_recording_label(old_label)
        if new_label and new_label != old_label:
            rec_copy["label"] = new_label
            changed = True
        recordings.append(rec_copy)

    legacy_yt_id = str(updated.get("youtubeId") or "").strip()
    if legacy_yt_id and legacy_yt_id not in seen_yt_ids:
        recordings.append(
            {
                "id": f"yt_{legacy_yt_id}",
                "label": f"SSS Bhajans: {effective_title}",
                "collection": "youtube_sss_bhajans",
                "externalUrl": f"https://www.youtube.com/watch?v={legacy_yt_id}",
                "youtubeVideoId": legacy_yt_id,
                "embeddable": True,
                "lastVerifiedAt": now_iso,
            }
        )
        changed = True

    if recordings and recordings != (updated.get("recordings") or []):
        updated["recordings"] = recordings
        changed = True

    raw_lyrics_sets = list(updated.get("lyricsSets") or [])
    cleaned_lyrics_sets: list[dict[str, Any]] = []
    lyrics_sets_changed = False
    for ls in raw_lyrics_sets:
        if not isinstance(ls, dict):
            lyrics_sets_changed = True
            continue
        orig_lines = [str(ln) for ln in (ls.get("lines") or [])]
        cleaned_lines = yt_sync.strip_youtube_lyrics_footer(orig_lines)
        if cleaned_lines != orig_lines:
            lyrics_sets_changed = True
        if cleaned_lines:
            cleaned_entry = dict(ls)
            cleaned_entry["lines"] = cleaned_lines
            cleaned_lyrics_sets.append(cleaned_entry)
        elif orig_lines:
            lyrics_sets_changed = True

    if lyrics_sets_changed:
        updated["lyricsSets"] = cleaned_lyrics_sets
        changed = True

    lyrics_sets = cleaned_lyrics_sets
    legacy_lyrics = str(updated.get("lyrics") or "").strip() if isinstance(updated.get("lyrics"), str) else ""
    if legacy_lyrics:
        cleaned_legacy_lines = yt_sync.strip_youtube_lyrics_footer(legacy_lyrics.splitlines())
        cleaned_legacy_text = "\n".join(cleaned_legacy_lines)
        if cleaned_legacy_text != legacy_lyrics:
            updated["lyrics"] = cleaned_legacy_text
            changed = True
        if not lyrics_sets and cleaned_legacy_lines:
            lyrics_sets = [
                {
                    "language": "Roman",
                    "script": crawler.infer_script_kind(cleaned_legacy_lines, "Roman"),
                    "lines": cleaned_legacy_lines,
                }
            ]
            updated["lyricsSets"] = lyrics_sets
            changed = True

    lyrics_missing = len(lyrics_sets) == 0
    if updated.get("lyricsMissing") != lyrics_missing:
        updated["lyricsMissing"] = lyrics_missing
        changed = True

    computed_missing = crawler.compute_missing_bhajan_fields(updated)
    if list(updated.get("missingFields") or []) != computed_missing:
        updated["missingFields"] = computed_missing
        changed = True

    if not changed:
        return None

    updated["updatedAt"] = now_iso
    return updated


def run_migration(
    *,
    publish_firestore: bool = False,
    max_firestore_writes: int = DEFAULT_MAX_FIRESTORE_WRITES,
) -> dict[str, Any]:
    """Stream Firestore `bhajans`, normalize legacy YouTube records, and commit in bounded batches."""
    import firebase_admin
    from firebase_admin import credentials, firestore

    if not firebase_admin._apps:
        cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        if cred_path:
            firebase_admin.initialize_app(credentials.Certificate(cred_path))
        else:
            project_id = os.environ.get("FIREBASE_PROJECT_ID", "saibhajanverse")
            firebase_admin.initialize_app(options={"projectId": project_id})

    fs_client = firestore.client()
    now_iso = yt_sync.utc_now_iso()
    scanned = 0
    updated_count = 0
    skipped_override = 0
    already_clean = 0
    writes = 0

    col = fs_client.collection("bhajans")
    batch = fs_client.batch()
    ops_in_batch = 0

    for snap in col.stream():
        if not snap.exists:
            continue
        scanned += 1
        raw = snap.to_dict() or {}
        if raw.get("bhajamiOverride") is True:
            skipped_override += 1
            continue
        patched = normalize_bhajan_doc(snap.id, raw, now_iso=now_iso)
        if patched is None:
            already_clean += 1
            continue
        updated_count += 1
        if publish_firestore and writes < max_firestore_writes:
            batch.set(col.document(snap.id), patched, merge=True)
            writes += 1
            ops_in_batch += 1
            if ops_in_batch >= 350:
                batch.commit()
                batch = fs_client.batch()
                ops_in_batch = 0

    if publish_firestore and ops_in_batch > 0:
        batch.commit()

    return {
        "dryRun": not publish_firestore,
        "scanned": scanned,
        "updated": updated_count,
        "skippedOverride": skipped_override,
        "alreadyClean": already_clean,
        "firestoreWrites": writes,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Normalize legacy YouTube Firestore bhajan documents")
    parser.add_argument("--publish-firestore", action="store_true", help="Write normalized records to Firestore")
    parser.add_argument("--max-firestore-writes", type=int, default=DEFAULT_MAX_FIRESTORE_WRITES)
    args = parser.parse_args()
    summary = run_migration(
        publish_firestore=args.publish_firestore,
        max_firestore_writes=args.max_firestore_writes,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
