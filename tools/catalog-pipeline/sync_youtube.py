#!/usr/bin/env python3
"""YouTube Data API v3 Two-Pass Ingestion & Chapter Segment Matcher for bhaJami.

Ingests:
- Prasanthi Mandir Live playlist (`PLC4MvBXcP7HJS5hkJufdFZzQsfJBzQMBc`)
- Sri Sathya Sai Bhajans channel (`UCWW5Z9BGsa14XLFXdRf01TA`)

Uses stdlib `urllib.request` (< 100 backfill quota units; ~2-6 daily incremental units),
classifies videos into `single` / `volume` / `ambiguous_long` (> 390s without chapters),
runs Pass 1 (single & ambiguous_long attachment/stubbing) + Pass 2 (embeddable volume
chapter slicing into `yt_<videoId>_t<startSec>`), preserves human `bhajamiOverride: True`
fields, and records `youtubeVideos/{videoId}`, `syncState/{source}`, and `ingestionRuns/{runId}`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
SHARED_DATA_DIR = REPO_ROOT / "packages" / "shared" / "data"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import crawl_sairhythms as crawler  # noqa: E402
import phonetics  # noqa: E402

YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"
PRASANTHI_MANDIR_PLAYLIST_ID = "PLC4MvBXcP7HJS5hkJufdFZzQsfJBzQMBc"
SSS_BHAJANS_CHANNEL_ID = "UCWW5Z9BGsa14XLFXdRf01TA"
AMBIGUOUS_LONG_THRESHOLD_SEC = 390
DEFAULT_MAX_FIRESTORE_WRITES = 4000
DEFAULT_INDEX_JSON = SHARED_DATA_DIR / "catalog-index.v1.json"

VOLUME_TITLE_RE = re.compile(
    r"\b(?:medley|collection|jukebox|non[\s-]*stop|vol\.?\s*\d+|volume\s*\d+|marathon|compilation|continuous)\b"
    r"|\b\d+\s+(?:best|top|popular|divine|non[\s-]*stop|sai|sathya\s+sai|devotional|shiva|krishna|rama|ganesha|devi|hanuman|guru)?\s*bhajans?\b",
    re.I,
)

STRUCTURAL_CHAPTER_RE = re.compile(
    r"\b(?:intro(?:duction)?|outro|a*laa*p|prelude|interlude|ending|credits|tuning|silence|announcement|sponsor|subscribe|closing|disclaimer|start|end)\b",
    re.I,
)

ISO_DURATION_RE = re.compile(
    r"^P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)?$",
    re.I,
)

TIMESTAMP_TOKEN_RE = re.compile(r"(?<!\d)(\d{1,2}:[0-5]\d(?::[0-5]\d)?)(?!\d)")

LYRICS_MARKER_RE = re.compile(r"^\s*lyrics\s*[-–:]\s*(.*)$", re.I)

FOOTER_STOP_RE = re.compile(
    r"(?:https?://|www\.|radio\s*sai|sri\s+sathya\s+sai\s+media\s+centre|follow\s+us|subscribe\s+(?:to|now)|"
    r"prasanthi\s+nilayam|timings\s*:|schedule\s*:|broadcast|watch\s+live|download\s+app|"
    r"copyright|for\s+more\s+updates|website\s*:|whatsapp|telegram)",
    re.I,
)

SEPARATOR_LINE_RE = re.compile(r"^[-_=*~]{3,}\s*$")
PURE_HASHTAGS_RE = re.compile(r"^(?:#[^\s#]+\s*)+$")


def utc_now_iso() -> str:
    """Return strict UTC timestamp formatted as YYYY-MM-DDTHH:MM:SSZ."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso8601_duration(raw: str | None) -> int:
    """Parse YouTube ISO-8601 duration strings like `PT5M12S` into seconds."""
    if not raw:
        return 0
    m = ISO_DURATION_RE.match(raw.strip())
    if not m:
        return 0
    days = int(m.group("days") or 0)
    hours = int(m.group("hours") or 0)
    minutes = int(m.group("minutes") or 0)
    seconds = int(m.group("seconds") or 0)
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def format_mmss(seconds: int) -> str:
    """Format non-negative integer seconds as M:SS or H:MM:SS."""
    total = max(0, int(seconds))
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def _parse_timestamp_str(ts: str) -> int:
    parts = [int(p) for p in ts.strip().split(":")]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return 0


def extract_mandir_lyrics(description: str | None) -> list[str]:
    """Extract clean lyric lines following a `Lyrics -` block, stripping footers and URLs."""
    if not description:
        return []
    raw_lines = description.splitlines()
    started = False
    collected: list[str] = []

    for raw_line in raw_lines:
        stripped = raw_line.strip()
        if not started:
            m = LYRICS_MARKER_RE.match(stripped)
            if m:
                started = True
                inline = m.group(1).strip()
                if inline and not FOOTER_STOP_RE.search(inline):
                    collected.append(inline)
            continue

        if not stripped:
            if collected:
                continue
            continue

        if SEPARATOR_LINE_RE.match(stripped) or FOOTER_STOP_RE.search(stripped):
            if collected:
                break
            continue

        if PURE_HASHTAGS_RE.match(stripped):
            if collected:
                break
            continue

        # Strip inline hashtags while preserving lyric words
        cleaned = re.sub(r"\s*#[^\s#]+", "", stripped).strip()
        if cleaned:
            collected.append(cleaned)

    return collected if len(collected) >= 2 else []


def _extract_chapter_title_from_line(line: str, ts_match: re.Match[str]) -> str:
    prefix = line[: ts_match.start()].strip()
    suffix = line[ts_match.end() :].strip()
    candidate = suffix if len(suffix) >= len(prefix) else prefix
    candidate = re.sub(r"^[\s\[\]()\-–:|•.*0-9]+(?=[A-Za-z\u0900-\u097F])", "", candidate)
    candidate = re.sub(r"[\s\[\]()\-–:|•]+$", "", candidate)
    # Handle cases where only prefix had brackets e.g. `[04:30] Title` or `1. 04:30 - Title`
    candidate = candidate.strip("[]() -–:|•\t")
    return re.sub(r"\s+", " ", candidate).strip()


def parse_description_chapters(
    description: str | None,
    duration_sec: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Parse sorted chapter markers from a video description.

    Returns `(non_structural_chapters, all_raw_markers)`. Each chapter's `endSec` stops at
    the immediately following raw marker's `startSec` (including structural markers such as
    `Outro`), or `duration_sec` when it is the final marker.
    """
    if not description:
        return [], []

    raw_by_start: dict[int, dict[str, Any]] = {}
    for line in description.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        m = TIMESTAMP_TOKEN_RE.search(stripped)
        if not m:
            continue
        start_sec = _parse_timestamp_str(m.group(1))
        if duration_sec > 0 and start_sec >= duration_sec:
            continue
        title = _extract_chapter_title_from_line(stripped, m)
        if not title:
            continue
        is_structural = bool(STRUCTURAL_CHAPTER_RE.search(title))
        if start_sec not in raw_by_start:
            raw_by_start[start_sec] = {
                "title": title,
                "startSec": start_sec,
                "isStructural": is_structural,
            }

    sorted_raw = sorted(raw_by_start.values(), key=lambda item: item["startSec"])
    if not sorted_raw:
        return [], []

    all_markers: list[dict[str, Any]] = []
    non_structural: list[dict[str, Any]] = []
    for idx, marker in enumerate(sorted_raw):
        start_sec = int(marker["startSec"])
        next_start = int(sorted_raw[idx + 1]["startSec"]) if idx + 1 < len(sorted_raw) else int(duration_sec)
        end_sec = next_start if next_start > start_sec else max(start_sec, int(duration_sec))
        entry = {
            "title": marker["title"],
            "startSec": start_sec,
            "endSec": end_sec,
            "isStructural": bool(marker["isStructural"]),
        }
        if end_sec > start_sec:
            all_markers.append(entry)
            if not entry["isStructural"]:
                non_structural.append(entry)

    return non_structural, all_markers


def classify_youtube_video(
    raw_title: str,
    raw_description: str,
    duration_sec: int,
) -> dict[str, Any]:
    """Classify a YouTube video as `single`, `volume`, or `ambiguous_long`."""
    non_structural, all_markers = parse_description_chapters(raw_description, duration_sec)
    is_volume = bool(VOLUME_TITLE_RE.search(raw_title or "")) or len(non_structural) >= 2
    if is_volume:
        classification = "volume"
    elif duration_sec > AMBIGUOUS_LONG_THRESHOLD_SEC:
        classification = "ambiguous_long"
    else:
        classification = "single"

    cleaned_title = phonetics.sanitize_title(raw_title or "") or (raw_title or "").strip()
    return {
        "classification": classification,
        "cleanedTitle": cleaned_title,
        "chapters": [
            {"title": c["title"], "startSec": int(c["startSec"]), "endSec": int(c["endSec"])}
            for c in non_structural
        ],
        "allMarkers": all_markers,
    }


class YouTubeApiClient:
    """Lightweight stdlib `urllib.request` client for YouTube Data API v3."""

    def __init__(self, api_key: str) -> None:
        if not api_key:
            raise ValueError("YOUTUBE_API_KEY is required for live YouTube API requests.")
        self.api_key = api_key
        self.quota_units_used = 0

    def _get_json(self, endpoint: str, params: Mapping[str, Any], *, quota_cost: int = 1) -> dict[str, Any]:
        query = dict(params)
        query["key"] = self.api_key
        url = f"{YOUTUBE_API_BASE}/{endpoint}?{urllib.parse.urlencode(query)}"
        req = urllib.request.Request(url, headers={"User-Agent": "bhaJami-YouTubeSync/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            self.quota_units_used += quota_cost
            return json.loads(resp.read().decode("utf-8"))

    def get_uploads_playlist_id(self, channel_id: str) -> str:
        data = self._get_json(
            "channels",
            {"part": "contentDetails", "id": channel_id},
            quota_cost=1,
        )
        items = data.get("items") or []
        if not items:
            raise RuntimeError(f"Channel not found: {channel_id}")
        return str(items[0]["contentDetails"]["relatedPlaylists"]["uploads"])

    def iter_playlist_video_ids(
        self,
        playlist_id: str,
        *,
        max_videos: int = 0,
        stop_before_published_at: str | None = None,
    ) -> list[str]:
        video_ids: list[str] = []
        seen: set[str] = set()
        page_token: str | None = None

        while True:
            params: dict[str, Any] = {
                "part": "snippet,contentDetails",
                "playlistId": playlist_id,
                "maxResults": 50,
            }
            if page_token:
                params["pageToken"] = page_token
            data = self._get_json("playlistItems", params, quota_cost=1)
            reached_watermark = False
            for item in data.get("items") or []:
                c_det = item.get("contentDetails") or {}
                snippet = item.get("snippet") or {}
                vid = str(c_det.get("videoId") or snippet.get("resourceId", {}).get("videoId") or "").strip()
                pub_at = str(c_det.get("videoPublishedAt") or snippet.get("publishedAt") or "").strip()
                if stop_before_published_at and pub_at and pub_at <= stop_before_published_at:
                    reached_watermark = True
                    continue
                if vid and vid not in seen:
                    seen.add(vid)
                    video_ids.append(vid)
                    if max_videos > 0 and len(video_ids) >= max_videos:
                        return video_ids
            page_token = data.get("nextPageToken")
            if not page_token or reached_watermark:
                break
        return video_ids

    def fetch_videos_batch(self, video_ids: list[str]) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for idx in range(0, len(video_ids), 50):
            chunk = video_ids[idx : idx + 50]
            if not chunk:
                continue
            data = self._get_json(
                "videos",
                {"part": "snippet,contentDetails,status", "id": ",".join(chunk)},
                quota_cost=1,
            )
            for item in data.get("items") or []:
                snippet = item.get("snippet") or {}
                cdet = item.get("contentDetails") or {}
                status = item.get("status") or {}
                results.append(
                    {
                        "videoId": str(item.get("id") or ""),
                        "channelId": str(snippet.get("channelId") or ""),
                        "rawTitle": str(snippet.get("title") or ""),
                        "rawDescription": str(snippet.get("description") or ""),
                        "durationSec": parse_iso8601_duration(cdet.get("duration")),
                        "publishedAt": str(snippet.get("publishedAt") or ""),
                        "embeddable": bool(status.get("embeddable", True)),
                    }
                )
        return results


def _normalize_ts(ts: str | None, fallback: str) -> str:
    if not ts:
        return fallback
    cleaned = ts.strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", cleaned):
        return cleaned
    try:
        dt = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return fallback


def _merge_recording_into_bhajan(
    target_doc: dict[str, Any],
    recording: dict[str, Any],
    now_iso: str,
) -> dict[str, Any]:
    """Attach a deterministic YouTube recording while preserving `bhajamiOverride: True` fields."""
    merged = dict(target_doc)
    recs = [dict(r) for r in (merged.get("recordings") or [])]
    idx_by_id = {str(r.get("id")): idx for idx, r in enumerate(recs) if r.get("id")}
    rec_id = str(recording["id"])
    if rec_id in idx_by_id:
        recs[idx_by_id[rec_id]] = recording
    else:
        recs.append(recording)
    merged["recordings"] = recs
    merged["updatedAt"] = now_iso
    merged["missingFields"] = crawler.compute_missing_bhajan_fields(merged)
    return merged


def _build_unmatched_youtube_bhajan(
    *,
    video: Mapping[str, Any],
    cleaned_title: str,
    lyrics: list[str],
    recording: dict[str, Any],
    collection: str,
    match_status: str,
    match_candidates: list[dict[str, Any]],
    now_iso: str,
) -> dict[str, Any]:
    vid = str(video["videoId"])
    bhajan_id = f"yt_{vid}"
    title = cleaned_title or str(video.get("rawTitle") or vid).strip()
    lyrics_sets: list[dict[str, Any]] = []
    if lyrics:
        lyrics_sets.append(
            {
                "language": "Roman",
                "script": crawler.infer_script_kind(lyrics, "Roman"),
                "lines": lyrics,
            }
        )
    doc: dict[str, Any] = {
        "id": bhajan_id,
        "slug": f"yt-{vid.lower()}",
        "title": title,
        "deity": crawler.infer_deity(title),
        "language": "",
        "raga": {"name": ""},
        "beat": "",
        "tempo": "",
        "gentsPitch": None,
        "ladiesPitch": None,
        "firstLineNotes": None,
        "notesRange": None,
        "meaning": None,
        "lyricsSets": lyrics_sets,
        "glossary": [],
        "recordings": [recording],
        "sheetMusicUrl": None,
        "sourceUrl": f"https://www.youtube.com/watch?v={vid}",
        "metadataSource": collection,
        "lyricsMissing": len(lyrics_sets) == 0,
        "matchStatus": match_status,
        "matchCandidates": match_candidates[:3],
        "createdAt": now_iso,
        "updatedAt": now_iso,
    }
    doc["missingFields"] = crawler.compute_missing_bhajan_fields(doc)
    return doc


def _build_matched_youtube_stub(
    *,
    target_id: str,
    candidate_title: str,
    fallback_title: str,
    lyrics: list[str] | None,
    recording: dict[str, Any],
    collection: str,
    now_iso: str,
) -> dict[str, Any]:
    """Create a complete structured record when a YouTube match targets a slug not yet in Firestore."""
    resolved_title = (
        str(candidate_title or "").strip()
        or str(fallback_title or "").strip()
        or re.sub(r"[-_]+", " ", target_id).strip().title()
    )
    lyrics_sets: list[dict[str, Any]] = []
    if lyrics:
        lyrics_sets.append(
            {
                "language": "Roman",
                "script": crawler.infer_script_kind(lyrics, "Roman"),
                "lines": lyrics,
            }
        )
    doc: dict[str, Any] = {
        "id": target_id,
        "slug": target_id,
        "title": resolved_title,
        "deity": crawler.infer_deity(resolved_title),
        "language": None,
        "raga": None,
        "beat": None,
        "tala": None,
        "tempo": None,
        "gentsPitch": None,
        "ladiesPitch": None,
        "firstLineNotes": None,
        "notesRange": None,
        "meaning": None,
        "lyricsSets": lyrics_sets,
        "glossary": [],
        "recordings": [recording],
        "sheetMusicUrl": None,
        "sourceUrl": None,
        "metadataSource": collection,
        "lyricsMissing": len(lyrics_sets) == 0,
        "matchStatus": "verified",
        "createdAt": now_iso,
        "updatedAt": now_iso,
    }
    doc["missingFields"] = crawler.compute_missing_bhajan_fields(doc)
    return doc


class _CandidateIndex:
    """Fast token + 3-gram pre-filter to shrink O(V*C) Levenshtein scans to top candidates."""

    def __init__(self, candidates: Iterable[Mapping[str, Any]]) -> None:
        self.candidates: list[dict[str, Any]] = [dict(c) for c in candidates]
        self.by_id: dict[str, dict[str, Any]] = {
            str(c.get("id") or ""): c for c in self.candidates if c.get("id")
        }
        self._word_index: dict[str, list[int]] = {}
        self._prefix_index: dict[str, list[int]] = {}
        self._trigram_index: dict[str, list[int]] = {}

        for idx, cand in enumerate(self.candidates):
            canon = phonetics.canonicalize_phrase(str(cand.get("title") or ""))
            if not canon:
                continue
            words = {w for w in canon.split() if len(w) >= 3}
            for w in words:
                self._word_index.setdefault(w, []).append(idx)
                self._prefix_index.setdefault(w[:3], []).append(idx)
            compact = canon.replace(" ", "")
            if len(compact) >= 3:
                grams = {compact[i : i + 3] for i in range(len(compact) - 2)}
                for g in grams:
                    self._trigram_index.setdefault(g, []).append(idx)

    def shortlist(
        self,
        query_title: str,
        *,
        entity_aliases: Mapping[str, str] | None = None,
        max_candidates: int = 30,
    ) -> list[dict[str, Any]]:
        if len(self.candidates) <= max_candidates:
            return self.candidates

        canon = phonetics.canonicalize_phrase(query_title)
        scores: dict[int, int] = {}
        if canon:
            words = {w for w in canon.split() if len(w) >= 3}
            for w in words:
                for idx in self._word_index.get(w, ()):
                    scores[idx] = scores.get(idx, 0) + 3
                for idx in self._prefix_index.get(w[:3], ()):
                    scores[idx] = scores.get(idx, 0) + 2
            compact = canon.replace(" ", "")
            if len(compact) >= 3:
                for g in {compact[i : i + 3] for i in range(len(compact) - 2)}:
                    for idx in self._trigram_index.get(g, ()):
                        scores[idx] = scores.get(idx, 0) + 1

        ranked_indices = sorted(scores, key=lambda i: (-scores[i], i))[:max_candidates]
        shortlisted = [self.candidates[i] for i in ranked_indices]
        seen_ids = {str(c.get("id") or "") for c in shortlisted}

        if canon and entity_aliases and canon in entity_aliases:
            target_id = str(entity_aliases[canon])
            if target_id not in seen_ids and target_id in self.by_id:
                shortlisted.insert(0, self.by_id[target_id])

        return shortlisted


def process_youtube_videos(
    videos: Iterable[Mapping[str, Any]],
    catalog_candidates: Iterable[Mapping[str, Any]],
    *,
    existing_bhajans: Mapping[str, Mapping[str, Any]] | None = None,
    source_key: str = "youtube_sss_bhajans",
    playlist_id: str | None = None,
    entity_aliases: Mapping[str, str] | None = None,
    do_not_merge_pairs: Iterable[str] | None = None,
    now_iso: str | None = None,
    quota_units_used: int = 0,
) -> dict[str, Any]:
    """Execute Pass 1 (singles/ambiguous_long) and Pass 2 (volume chapters) offline or pre-write.

    Returns `{ updatedBhajans, createdBhajans, youtubeVideos, syncState, ingestionRun, stats }`.
    """
    ts_now = now_iso or utc_now_iso()
    collection = (
        "youtube_prasanthi_mandir_live"
        if source_key == "youtube_mandir_live"
        else "youtube_sss_bhajans"
    )
    cand_index = _CandidateIndex(catalog_candidates)
    candidates_list = cand_index.candidates
    bhajans_state: dict[str, dict[str, Any]] = {
        str(k): dict(v) for k, v in (existing_bhajans or {}).items()
    }
    updated_ids: set[str] = set()
    created_ids: set[str] = set()
    provenance_docs: dict[str, dict[str, Any]] = {}

    stats = {
        "itemsScanned": 0,
        "matchedAuto": 0,
        "queuedDoubt": 0,
        "createdNew": 0,
        "skippedDuplicate": 0,
        "chapterMatches": 0,
        "parseErrors": 0,
    }

    latest_pub_at: str | None = None
    classified_rows: list[tuple[Mapping[str, Any], dict[str, Any]]] = []
    for video in videos:
        vid = str(video.get("videoId") or "").strip()
        if not vid:
            stats["parseErrors"] += 1
            continue
        stats["itemsScanned"] += 1
        pub_norm = _normalize_ts(str(video.get("publishedAt") or ""), ts_now)
        if latest_pub_at is None or pub_norm > latest_pub_at:
            latest_pub_at = pub_norm
        cls = classify_youtube_video(
            str(video.get("rawTitle") or ""),
            str(video.get("rawDescription") or ""),
            int(video.get("durationSec") or 0),
        )
        classified_rows.append((video, cls))

    # Pass 1: single & ambiguous_long videos
    for video, cls in classified_rows:
        vid = str(video["videoId"])
        classification = cls["classification"]
        cleaned_title = cls["cleanedTitle"]
        duration_sec = int(video.get("durationSec") or 0)
        embeddable = bool(video.get("embeddable", True))
        channel_id = str(video.get("channelId") or SSS_BHAJANS_CHANNEL_ID)
        pub_norm = _normalize_ts(str(video.get("publishedAt") or ""), ts_now)

        if classification == "volume":
            provenance_docs[vid] = {
                "videoId": vid,
                "channelId": channel_id,
                **({"playlistId": playlist_id} if playlist_id else {}),
                "rawTitle": str(video.get("rawTitle") or ""),
                "rawDescription": str(video.get("rawDescription") or ""),
                "cleanedTitle": cleaned_title,
                "durationSec": duration_sec,
                "publishedAt": pub_norm,
                "classification": "volume",
                "embeddable": embeddable,
                "chapters": cls["chapters"],
                "linkedBhajanIds": [],
                "lastVerifiedAt": ts_now,
                "ingestedAt": ts_now,
            }
            continue

        lyrics = extract_mandir_lyrics(str(video.get("rawDescription") or ""))
        shortlist = cand_index.shortlist(cleaned_title, entity_aliases=entity_aliases)
        eval_res = phonetics.evaluate_match_candidate(
            cleaned_title,
            shortlist,
            query_lyrics=lyrics,
            query_id=f"yt_{vid}",
            entity_aliases=entity_aliases,
            do_not_merge_pairs=do_not_merge_pairs,
        )
        best_score = float(eval_res.get("bestScore") or 0.0)
        match_method = str(eval_res.get("reason") or "title_similarity")
        rec_label_prefix = "Prasanthi Mandir Live" if source_key == "youtube_mandir_live" else "SSS Bhajans"
        recording: dict[str, Any] = {
            "id": f"yt_{vid}",
            "label": f"{rec_label_prefix}: {cleaned_title}",
            "collection": collection,
            "externalUrl": f"https://www.youtube.com/watch?v={vid}",
            "youtubeVideoId": vid,
            "embeddable": embeddable,
            "channelId": channel_id,
            "durationSec": duration_sec,
            "matchScore": round(best_score, 4),
            "matchMethod": match_method,
            "lastVerifiedAt": ts_now,
        }

        linked_ids: list[str] = []
        if classification == "single" and eval_res.get("matchStatus") == "verified" and eval_res.get("bestTargetId"):
            target_id = str(eval_res["bestTargetId"])
            existing_target = bhajans_state.get(target_id)
            if existing_target is not None:
                had_rec = any(r.get("id") == recording["id"] for r in (existing_target.get("recordings") or []))
                bhajans_state[target_id] = _merge_recording_into_bhajan(existing_target, recording, ts_now)
                if had_rec:
                    stats["skippedDuplicate"] += 1
                else:
                    stats["matchedAuto"] += 1
            else:
                cand = cand_index.by_id.get(target_id)
                bhajans_state[target_id] = _build_matched_youtube_stub(
                    target_id=target_id,
                    candidate_title=str((cand or {}).get("title") or ""),
                    fallback_title=cleaned_title,
                    lyrics=lyrics,
                    recording=recording,
                    collection=collection,
                    now_iso=ts_now,
                )
                stats["matchedAuto"] += 1
            updated_ids.add(target_id)
            linked_ids.append(target_id)
        else:
            stub_id = f"yt_{vid}"
            resolved_status = "needs_verification" if (classification == "ambiguous_long" or eval_res.get("matchStatus") == "needs_verification") else "unmatched"
            existing_stub = bhajans_state.get(stub_id)
            if existing_stub is not None and existing_stub.get("bhajamiOverride") is True:
                bhajans_state[stub_id] = _merge_recording_into_bhajan(existing_stub, recording, ts_now)
                updated_ids.add(stub_id)
                stats["skippedDuplicate"] += 1
            else:
                stub_doc = _build_unmatched_youtube_bhajan(
                    video=video,
                    cleaned_title=cleaned_title,
                    lyrics=lyrics,
                    recording=recording,
                    collection=collection,
                    match_status=resolved_status,
                    match_candidates=list(eval_res.get("matchCandidates") or []),
                    now_iso=ts_now,
                )
                bhajans_state[stub_id] = stub_doc
                if existing_stub is None:
                    created_ids.add(stub_id)
                    stats["createdNew"] += 1
                else:
                    updated_ids.add(stub_id)
                if resolved_status == "needs_verification":
                    stats["queuedDoubt"] += 1
            linked_ids.append(stub_id)

        provenance_docs[vid] = {
            "videoId": vid,
            "channelId": channel_id,
            **({"playlistId": playlist_id} if playlist_id else {}),
            "rawTitle": str(video.get("rawTitle") or ""),
            "rawDescription": str(video.get("rawDescription") or ""),
            "cleanedTitle": cleaned_title,
            "durationSec": duration_sec,
            "publishedAt": pub_norm,
            "classification": classification,
            "embeddable": embeddable,
            "linkedBhajanIds": linked_ids,
            "lastVerifiedAt": ts_now,
            "ingestedAt": ts_now,
        }

    # Pass 2: embeddable volume chapters
    for video, cls in classified_rows:
        if cls["classification"] != "volume":
            continue
        vid = str(video["videoId"])
        embeddable = bool(video.get("embeddable", True))
        if not embeddable:
            continue
        channel_id = str(video.get("channelId") or SSS_BHAJANS_CHANNEL_ID)
        linked = list(provenance_docs[vid].get("linkedBhajanIds") or [])

        for chap in cls["chapters"]:
            c_title_clean = phonetics.sanitize_title(chap["title"]) or chap["title"]
            start_sec = int(chap["startSec"])
            end_sec = int(chap["endSec"])
            shortlist = cand_index.shortlist(c_title_clean, entity_aliases=entity_aliases)
            eval_res = phonetics.evaluate_match_candidate(
                c_title_clean,
                shortlist,
                query_id=f"yt_{vid}_t{start_sec}",
                entity_aliases=entity_aliases,
                do_not_merge_pairs=do_not_merge_pairs,
            )
            if eval_res.get("matchStatus") != "verified" or not eval_res.get("bestTargetId"):
                continue

            target_id = str(eval_res["bestTargetId"])
            chap_rec: dict[str, Any] = {
                "id": f"yt_{vid}_t{start_sec}",
                "label": f"{c_title_clean} ({format_mmss(start_sec)}–{format_mmss(end_sec)})",
                "collection": "youtube_volume_chapter",
                "externalUrl": f"https://www.youtube.com/watch?v={vid}&t={start_sec}s",
                "youtubeVideoId": vid,
                "startSec": start_sec,
                "endSec": end_sec,
                "embeddable": True,
                "channelId": channel_id,
                "durationSec": end_sec - start_sec,
                "matchScore": round(float(eval_res.get("bestScore") or 0.0), 4),
                "matchMethod": str(eval_res.get("reason") or "title_similarity"),
                "lastVerifiedAt": ts_now,
            }
            existing_target = bhajans_state.get(target_id)
            if existing_target is not None:
                had_rec = any(r.get("id") == chap_rec["id"] for r in (existing_target.get("recordings") or []))
                bhajans_state[target_id] = _merge_recording_into_bhajan(existing_target, chap_rec, ts_now)
                if had_rec:
                    stats["skippedDuplicate"] += 1
                else:
                    stats["chapterMatches"] += 1
            else:
                cand = cand_index.by_id.get(target_id)
                bhajans_state[target_id] = _build_matched_youtube_stub(
                    target_id=target_id,
                    candidate_title=str((cand or {}).get("title") or ""),
                    fallback_title=c_title_clean,
                    lyrics=None,
                    recording=chap_rec,
                    collection="youtube_volume_chapter",
                    now_iso=ts_now,
                )
                stats["chapterMatches"] += 1
            updated_ids.add(target_id)
            if target_id not in linked:
                linked.append(target_id)
        provenance_docs[vid]["linkedBhajanIds"] = linked

    run_digest = hashlib.sha1(f"{source_key}:{ts_now}".encode("utf-8")).hexdigest()[:8]
    run_id = f"yt_{source_key}_{ts_now.replace(':', '').replace('-', '')}_{run_digest}"
    sync_state = {
        "source": source_key,
        "lastRunAt": ts_now,
        "lastPublishedAt": latest_pub_at,
        "itemsIndexedCount": len(provenance_docs),
    }
    ingestion_run = {
        "runId": run_id,
        "source": source_key,
        "startedAt": ts_now,
        "finishedAt": utc_now_iso(),
        "status": "success",
        "itemsScanned": stats["itemsScanned"],
        "matchedAuto": stats["matchedAuto"],
        "queuedDoubt": stats["queuedDoubt"],
        "createdNew": stats["createdNew"],
        "skippedDuplicate": stats["skippedDuplicate"],
        "parseErrors": stats["parseErrors"],
        "youtubeQuotaUnitsUsed": quota_units_used,
        "firestoreWrites": 0,
    }
    return {
        "updatedBhajans": {bid: bhajans_state[bid] for bid in sorted(updated_ids)},
        "createdBhajans": {bid: bhajans_state[bid] for bid in sorted(created_ids)},
        "youtubeVideos": provenance_docs,
        "syncState": sync_state,
        "ingestionRun": ingestion_run,
        "stats": stats,
    }


def _load_candidates_from_json(index_path: Path) -> list[dict[str, Any]]:
    raw = json.loads(index_path.read_text(encoding="utf-8"))
    if "entries" in raw:
        return [
            {"id": e["id"], "title": e["title"], "lyricsLines": []}
            for e in raw["entries"]
        ]
    return [
        {
            "id": b["id"],
            "title": b["title"],
            "lyricsLines": [ln for s in (b.get("lyricsSets") or []) for ln in (s.get("lines") or [])],
        }
        for b in raw.get("bhajans", [])
    ]


def _init_firestore_client():
    import firebase_admin
    from firebase_admin import credentials, firestore

    if not firebase_admin._apps:
        cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        if cred_path:
            firebase_admin.initialize_app(credentials.Certificate(cred_path))
        else:
            project_id = os.environ.get("FIREBASE_PROJECT_ID", "saibhajanverse")
            firebase_admin.initialize_app(options={"projectId": project_id})
    return firestore.client()


def run_sync(
    *,
    source_key: str = "youtube_sss_bhajans",
    playlist_id: str | None = None,
    channel_id: str | None = None,
    fixture_json: Path | None = None,
    index_path: Path = DEFAULT_INDEX_JSON,
    incremental: bool = False,
    max_videos: int = 0,
    liveness_check_limit: int = 0,
    publish_firestore: bool = False,
    max_firestore_writes: int = DEFAULT_MAX_FIRESTORE_WRITES,
) -> dict[str, Any]:
    """Run offline or live YouTube Data API v3 sync and return compact summary."""
    fs_client = _init_firestore_client() if publish_firestore else None
    candidates: list[dict[str, Any]] = []
    entity_aliases: dict[str, str] = {}
    do_not_merge_pairs: list[str] = []
    existing_bhajans: dict[str, dict[str, Any]] = {}

    if fs_client is not None:
        meta_snap = fs_client.collection("catalogMeta").document("latest").get()
        shard_ids = (meta_snap.to_dict() or {}).get("shardIds", []) if meta_snap.exists else []
        for sid in shard_ids:
            s_snap = fs_client.collection("catalogIndexShards").document(sid).get()
            if s_snap.exists:
                for e in (s_snap.to_dict() or {}).get("entries", []):
                    candidates.append({"id": e["id"], "title": e["title"], "lyricsLines": []})
        for snap in fs_client.collection("entityAliases").stream():
            d = snap.to_dict() or {}
            canon = str(d.get("canonicalPhrase") or phonetics.canonicalize_phrase(str(d.get("variantTitle") or ""))).strip()
            if canon and d.get("targetBhajanId"):
                entity_aliases[canon] = str(d["targetBhajanId"])
        for snap in fs_client.collection("doNotMergePairs").stream():
            do_not_merge_pairs.append(snap.id)
    if not candidates and index_path.exists():
        candidates = _load_candidates_from_json(index_path)

    quota_used = 0
    resolved_playlist = playlist_id
    if fixture_json is not None:
        raw_fixture = json.loads(fixture_json.read_text(encoding="utf-8"))
        videos = list(raw_fixture.get("videos", raw_fixture) if isinstance(raw_fixture, dict) else raw_fixture)
    else:
        api_key = os.environ.get("YOUTUBE_API_KEY", "").strip()
        client = YouTubeApiClient(api_key)
        stop_before: str | None = None
        if incremental and fs_client is not None:
            sync_snap = fs_client.collection("syncState").document(source_key).get()
            if sync_snap.exists:
                stop_before = (sync_snap.to_dict() or {}).get("lastPublishedAt")
        if source_key == "youtube_mandir_live":
            resolved_playlist = resolved_playlist or PRASANTHI_MANDIR_PLAYLIST_ID
        else:
            cid = channel_id or SSS_BHAJANS_CHANNEL_ID
            resolved_playlist = resolved_playlist or client.get_uploads_playlist_id(cid)
        vids = client.iter_playlist_video_ids(
            resolved_playlist,
            max_videos=max_videos,
            stop_before_published_at=stop_before,
        )
        videos = client.fetch_videos_batch(vids)
        if liveness_check_limit > 0 and fs_client is not None:
            old_snaps = list(fs_client.collection("youtubeVideos").limit(liveness_check_limit).stream())
            check_ids = [s.id for s in old_snaps if s.id not in {v["videoId"] for v in videos}]
            if check_ids:
                liveness_videos = client.fetch_videos_batch(check_ids)
                for lv in liveness_videos:
                    fs_client.collection("youtubeVideos").document(lv["videoId"]).update(
                        {"embeddable": lv["embeddable"], "lastVerifiedAt": utc_now_iso()}
                    )
        quota_used = client.quota_units_used

    if fs_client is not None:
        referenced_ids = {c["id"] for c in candidates}
        # Only hydrate referenced bhajan docs as needed inside target updates
        for vid_row in videos:
            referenced_ids.add(f"yt_{vid_row['videoId']}")

    result = process_youtube_videos(
        videos,
        candidates,
        existing_bhajans=existing_bhajans,
        source_key=source_key,
        playlist_id=resolved_playlist,
        entity_aliases=entity_aliases,
        do_not_merge_pairs=do_not_merge_pairs,
        quota_units_used=quota_used,
    )

    writes = 0
    if publish_firestore and fs_client is not None:
        batch = fs_client.batch()
        ops_in_batch = 0

        def commit_if_needed(force: bool = False) -> None:
            nonlocal batch, ops_in_batch
            if ops_in_batch > 0 and (force or ops_in_batch >= 350):
                batch.commit()
                batch = fs_client.batch()
                ops_in_batch = 0

        all_bhajan_items = list({**result["updatedBhajans"], **result["createdBhajans"]}.items())
        col = fs_client.collection("bhajans")
        existing_docs_map: dict[str, dict[str, Any]] = {}
        for idx in range(0, len(all_bhajan_items), 200):
            chunk_ids = [bid for bid, _ in all_bhajan_items[idx : idx + 200]]
            refs = [col.document(bid) for bid in chunk_ids]
            for snap in fs_client.get_all(refs):
                if snap.exists:
                    existing_docs_map[snap.id] = snap.to_dict() or {}

        for bid, bdoc in all_bhajan_items:
            if writes >= max_firestore_writes:
                break
            ref = col.document(bid)
            if bid in existing_docs_map:
                merged_doc = existing_docs_map[bid]
                for rec in bdoc.get("recordings") or []:
                    merged_doc = _merge_recording_into_bhajan(merged_doc, rec, utc_now_iso())
                batch.set(ref, merged_doc)
            else:
                batch.set(ref, bdoc)
            writes += 1
            ops_in_batch += 1
            commit_if_needed()

        for vid, ydoc in result["youtubeVideos"].items():
            if writes >= max_firestore_writes:
                break
            batch.set(fs_client.collection("youtubeVideos").document(vid), ydoc)
            writes += 1
            ops_in_batch += 1
            commit_if_needed()

        if writes + 2 <= max_firestore_writes:
            batch.set(fs_client.collection("syncState").document(source_key), result["syncState"])
            result["ingestionRun"]["firestoreWrites"] = writes + 2
            batch.set(
                fs_client.collection("ingestionRuns").document(result["ingestionRun"]["runId"]),
                result["ingestionRun"],
            )
            writes += 2
            ops_in_batch += 2
        commit_if_needed(force=True)

    return {
        "source": source_key,
        "dryRun": not publish_firestore,
        **result["stats"],
        "quotaUnitsUsed": quota_used,
        "firestoreWrites": writes,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="YouTube Data API v3 Two-Pass Ingestion for bhaJami")
    parser.add_argument(
        "--source",
        choices=("youtube_sss_bhajans", "youtube_mandir_live"),
        default="youtube_sss_bhajans",
        help="YouTube ingestion source",
    )
    parser.add_argument("--playlist-id", type=str, default=None, help="Explicit YouTube playlist ID")
    parser.add_argument("--channel-id", type=str, default=None, help="Explicit YouTube channel ID")
    parser.add_argument("--fixture-json", type=Path, default=None, help="Offline JSON fixture of video items")
    parser.add_argument("--index-path", type=Path, default=DEFAULT_INDEX_JSON, help="Catalog index JSON fallback")
    parser.add_argument("--incremental", action="store_true", help="Stop paging at syncState.lastPublishedAt watermark")
    parser.add_argument("--max-videos", type=int, default=0, help="Cap videos scanned (0 = all)")
    parser.add_argument("--liveness-check-limit", type=int, default=0, help="Rotate embeddability refresh up to N videos")
    parser.add_argument("--publish-firestore", action="store_true", help="Write results to Cloud Firestore")
    parser.add_argument("--max-firestore-writes", type=int, default=DEFAULT_MAX_FIRESTORE_WRITES, help="Hard Firestore write cap")
    args = parser.parse_args()

    summary = run_sync(
        source_key=args.source,
        playlist_id=args.playlist_id,
        channel_id=args.channel_id,
        fixture_json=args.fixture_json,
        index_path=args.index_path,
        incremental=args.incremental,
        max_videos=args.max_videos,
        liveness_check_limit=args.liveness_check_limit,
        publish_firestore=args.publish_firestore,
        max_firestore_writes=args.max_firestore_writes,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
