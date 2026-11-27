#!/usr/bin/env python3
"""Backfill `trackType`, repair truncated YouTube titles (e.g. `Karaoke`, `SAMA - 02`),
mark instrumental/karaoke/special tracks so they stay off Random Stream & missing_lyrics queues,
and recover missing description lyrics when available.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Mapping, Sequence

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
SHARED_DATA_DIR = REPO_ROOT / "packages" / "shared" / "data"
DEFAULT_FIRESTORE_PROJECT_ID = "saibhajanverse"
DEFAULT_MAX_FIRESTORE_WRITES = 800

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import crawl_sairhythms as crawler  # noqa: E402
import sync_sssmediacentre as sssmc  # noqa: E402
import sync_youtube as yt_sync  # noqa: E402

_PLACEHOLDER_TITLE_RE = re.compile(
    r"^(?:karaoke|instrumental|sama\s*[-–:]?\s*\d+|must\s+hear(?:\s+.*)?|part\s*[-–:]?\s*\d+)$",
    re.I,
)


def _fetch_youtube_oembed_title(video_id: str) -> str:
    url = (
        "https://www.youtube.com/oembed?url="
        + urllib.parse.quote(f"https://www.youtube.com/watch?v={video_id}", safe="")
        + "&format=json"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "bhaJami-ClassifySpecialTracks/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return str(data.get("title") or "").strip()
    except Exception:
        return ""


def _first_youtube_video_id(doc: Mapping[str, Any]) -> str:
    for rec in list(doc.get("recordings") or []) + list(doc.get("addedRecordings") or []):
        if not isinstance(rec, Mapping):
            continue
        vid = str(rec.get("youtubeVideoId") or "").strip()
        if vid:
            return vid
    return ""


def _should_inspect_doc(doc: Mapping[str, Any]) -> bool:
    title = str(doc.get("title") or "").strip()
    rec_labels = " ".join(
        str(r.get("label") or "")
        for r in (list(doc.get("recordings") or []) + list(doc.get("addedRecordings") or []))
        if isinstance(r, Mapping)
    )
    inferred_type = yt_sync.classify_track_type(title, "", rec_labels)
    if inferred_type != "bhajan":
        return True
    if bool(doc.get("lyricsMissing")) or _PLACEHOLDER_TITLE_RE.match(title):
        return True
    if "|" in title:
        return True
    return False


def build_special_track_patch(
    doc: Mapping[str, Any],
    *,
    raw_yt_title: str = "",
    raw_yt_description: str = "",
    now_iso: str,
) -> dict[str, Any] | None:
    """Compute a minimal Firestore merge patch for `trackType`, repaired title, and queue cleanup."""
    cur_title = str(doc.get("title") or "").strip()
    recs = list(doc.get("recordings") or []) + list(doc.get("addedRecordings") or [])
    rec_labels = " ".join(str(r.get("label") or "") for r in recs if isinstance(r, Mapping))

    combined_raw_title = raw_yt_title.strip() or cur_title
    new_track_type = yt_sync.classify_track_type(
        f"{combined_raw_title} {cur_title}",
        raw_yt_description,
        rec_labels,
    )
    existing_track_type = str(doc.get("trackType") or "").strip().lower()
    if existing_track_type in ("bhajan", "instrumental", "karaoke", "special"):
        if existing_track_type == "bhajan" and new_track_type != "bhajan":
            resolved_type = new_track_type
        else:
            resolved_type = existing_track_type
    else:
        resolved_type = new_track_type

    override_locked = doc.get("bhajamiOverride") is True
    patch: dict[str, Any] = {}

    if resolved_type != "bhajan" and existing_track_type != resolved_type:
        patch["trackType"] = resolved_type

    # Extract better song/bhajan title when raw YouTube metadata clarifies a truncated/generic title
    repaired_title = ""
    if resolved_type != "bhajan" or _PLACEHOLDER_TITLE_RE.match(cur_title) or "|" in cur_title:
        candidate = yt_sync.clean_youtube_display_title(
            combined_raw_title,
            raw_yt_description,
            track_type=resolved_type,
        )
        if candidate and not _PLACEHOLDER_TITLE_RE.match(candidate) and candidate != cur_title:
            if not override_locked or _PLACEHOLDER_TITLE_RE.match(cur_title):
                repaired_title = candidate

    if repaired_title:
        patch["title"] = repaired_title
        deity = crawler.infer_deity(repaired_title)
        if deity and not str(doc.get("deity") or "").strip():
            patch["deity"] = deity

    # Recover lyrics from description if this is a vocal bhajan currently missing lyrics
    effective_lyrics_sets = list(doc.get("lyricsSets") or [])
    if (
        resolved_type == "bhajan"
        and bool(doc.get("lyricsMissing"))
        and len(effective_lyrics_sets) == 0
        and raw_yt_description
    ):
        extracted = yt_sync.extract_mandir_lyrics(raw_yt_description)
        if len(extracted) >= 2:
            effective_lyrics_sets = [
                {
                    "language": "Roman",
                    "script": crawler.infer_script_kind(extracted, "Roman"),
                    "lines": extracted,
                }
            ]
            patch["lyricsSets"] = effective_lyrics_sets
            patch["lyricsMissing"] = False

    if resolved_type != "bhajan":
        if doc.get("matchStatus") != "verified":
            patch["matchStatus"] = "verified"
        if doc.get("matchCandidates"):
            patch["matchCandidates"] = []
        if resolved_type in ("instrumental", "karaoke") and doc.get("lyricsMissing") is True:
            patch["lyricsMissing"] = False

    if not patch:
        return None

    preview_doc = {**doc, **patch}
    patch["missingFields"] = crawler.compute_missing_bhajan_fields(preview_doc)
    patch["updatedAt"] = now_iso
    return patch


def classify_catalog_special_tracks(
    docs: Sequence[Mapping[str, Any]],
    *,
    youtube_meta_by_vid: Mapping[str, Mapping[str, str]] | None = None,
    now_iso: str | None = None,
) -> dict[str, Any]:
    ts_now = now_iso or yt_sync.utc_now_iso()
    yt_meta = youtube_meta_by_vid or {}
    patches_by_id: dict[str, dict[str, Any]] = {}
    counts = {"instrumental": 0, "karaoke": 0, "special": 0, "titlesRepaired": 0, "lyricsRecovered": 0}

    for doc in docs:
        doc_id = str(doc.get("id") or doc.get("slug") or "").strip()
        if not doc_id or not _should_inspect_doc(doc):
            continue
        vid = _first_youtube_video_id(doc)
        meta = yt_meta.get(vid, {}) if vid else {}
        patch = build_special_track_patch(
            doc,
            raw_yt_title=str(meta.get("rawTitle") or ""),
            raw_yt_description=str(meta.get("rawDescription") or ""),
            now_iso=ts_now,
        )
        if patch is None:
            continue
        patches_by_id[doc_id] = patch
        ttype = str(patch.get("trackType") or doc.get("trackType") or "bhajan")
        if ttype in ("instrumental", "karaoke", "special"):
            counts[ttype] += 1
        if "title" in patch:
            counts["titlesRepaired"] += 1
        if "lyricsSets" in patch:
            counts["lyricsRecovered"] += 1

    return {
        "scanned": len(docs),
        "updatedCount": len(patches_by_id),
        "counts": counts,
        "patches": patches_by_id,
    }


def _collect_youtube_metadata(
    docs: Sequence[Mapping[str, Any]],
    *,
    fs_client: Any = None,
    fetch_youtube: bool = True,
) -> dict[str, dict[str, str]]:
    vid_targets: list[str] = []
    seen: set[str] = set()
    for doc in docs:
        if not _should_inspect_doc(doc):
            continue
        vid = _first_youtube_video_id(doc)
        if vid and vid not in seen:
            seen.add(vid)
            vid_targets.append(vid)

    meta_map: dict[str, dict[str, str]] = {}
    if fs_client is not None and vid_targets:
        for snap in fs_client.collection("youtubeVideos").stream():
            if not snap.exists:
                continue
            d = snap.to_dict() or {}
            vid = str(d.get("videoId") or snap.id or "").strip()
            if vid in seen:
                meta_map[vid] = {
                    "rawTitle": str(d.get("rawTitle") or ""),
                    "rawDescription": str(d.get("rawDescription") or ""),
                }

    if not fetch_youtube or not vid_targets:
        return meta_map

    missing_or_no_desc = [
        v for v in vid_targets if not meta_map.get(v, {}).get("rawDescription")
    ]
    api_key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if api_key and missing_or_no_desc:
        try:
            client = yt_sync.YouTubeApiClient(api_key)
            for row in client.fetch_videos_batch(missing_or_no_desc):
                vid = str(row.get("videoId") or "").strip()
                if vid:
                    meta_map[vid] = {
                        "rawTitle": str(row.get("rawTitle") or ""),
                        "rawDescription": str(row.get("rawDescription") or ""),
                    }
        except Exception as err:
            print(f"Warning: YouTube API batch fetch failed: {err}", file=sys.stderr)

    still_missing_title = [
        v for v in vid_targets if not meta_map.get(v, {}).get("rawTitle")
    ]
    if still_missing_title:
        with ThreadPoolExecutor(max_workers=8) as pool:
            titles = list(pool.map(_fetch_youtube_oembed_title, still_missing_title))
        for vid, t in zip(still_missing_title, titles):
            if t:
                meta_map.setdefault(vid, {})["rawTitle"] = t

    return meta_map


def publish_special_track_patches(
    fs_client: Any,
    patches_by_id: Mapping[str, Mapping[str, Any]],
    *,
    max_writes: int = DEFAULT_MAX_FIRESTORE_WRITES,
) -> int:
    batch = fs_client.batch()
    batch_ops = 0
    writes = 0
    for doc_id, patch in patches_by_id.items():
        if writes >= max_writes:
            break
        batch.set(fs_client.collection("bhajans").document(doc_id), dict(patch), merge=True)
        batch_ops += 1
        writes += 1
        if batch_ops >= 400:
            batch.commit()
            batch = fs_client.batch()
            batch_ops = 0
    if batch_ops > 0:
        batch.commit()
    return writes


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Classify instrumental/karaoke/special tracks & repair truncated YouTube titles"
    )
    parser.add_argument(
        "--source",
        choices=("firestore", "firestore-rest", "local"),
        default="firestore",
    )
    parser.add_argument("--project-id", default=DEFAULT_FIRESTORE_PROJECT_ID)
    parser.add_argument("--local-json", type=Path, default=SHARED_DATA_DIR / "catalog.json")
    parser.add_argument("--max-firestore-writes", type=int, default=DEFAULT_MAX_FIRESTORE_WRITES)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--publish-firestore", action="store_true")
    parser.add_argument("--no-youtube-fetch", action="store_true")
    args = parser.parse_args()

    source = args.source
    if args.dry_run and source == "firestore" and not (
        os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        or os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    ):
        source = "firestore-rest"

    docs, _, fs_client = sssmc.load_catalog_docs(
        source,
        project_id=args.project_id,
        local_json_path=args.local_json,
    )
    yt_meta = _collect_youtube_metadata(
        docs,
        fs_client=fs_client,
        fetch_youtube=not args.no_youtube_fetch,
    )
    result = classify_catalog_special_tracks(docs, youtube_meta_by_vid=yt_meta)

    writes = 0
    if args.publish_firestore and not args.dry_run:
        if fs_client is None:
            raise RuntimeError("--publish-firestore requires --source firestore with Admin credentials.")
        writes = publish_special_track_patches(
            fs_client,
            result["patches"],
            max_writes=args.max_firestore_writes,
        )

    print(
        json.dumps(
            {
                "scanned": result["scanned"],
                "updatedCount": result["updatedCount"],
                "firestoreWrites": writes,
                "counts": result["counts"],
                "sampleTitles": {
                    k: v.get("title") or v.get("trackType")
                    for k, v in list(result["patches"].items())[:15]
                },
            },
            indent=2,
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
