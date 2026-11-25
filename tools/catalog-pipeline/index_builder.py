#!/usr/bin/env python3
"""Slim Sharded Search Index Builder for bhaJami Cloud Catalog & Local Fallback.

Compiles full `Bhajan` documents (from Cloud Firestore or a local catalog JSON) into:
1. Slim `BhajanIndexEntry` projections (without full verses or glossary prose)
2. Deterministic `<= 345 KB` shard docs (`catalogIndexShards/{shardId}`, strictly < 350 KB)
3. Atomic `catalogMeta/latest` manifest + local `packages/shared/data/catalog-index.v1.json`

Personal local MP3 archive matching is disabled by default and strictly opt-in via
`LOCAL_ARCHIVE_ENABLED=true` or `--include-local-archives`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
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
import sync_youtube as yt_sync  # noqa: E402

MAX_SHARD_BYTES = 345_000
DEFAULT_CATALOG_JSON = SHARED_DATA_DIR / "catalog.json"
DEFAULT_INDEX_OUT = SHARED_DATA_DIR / "catalog-index.v1.json"
DEFAULT_SEEDS_PATH = SHARED_DATA_DIR / "glossary-variant-seeds.json"

LOCAL_ARCHIVES: list[tuple[str, str, Path]] = [
    ("sssmediacentre_bhajan_a_day", "SSS Media Centre", Path("/Users/chax/Downloads/BhajanDownloader/downloads")),
    ("ravimp3_archive", "RaviMp3 Archive", Path("/Users/chax/Downloads/RaviMp3/Downloads")),
]


def utc_now_iso() -> str:
    """Return strict UTC timestamp formatted as YYYY-MM-DDTHH:MM:SSZ."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clean_search_snippet(text: str, max_len: int = 240) -> str:
    collapsed = re.sub(r"\s+", " ", text).strip()
    return collapsed[:max_len].strip()


def _extract_title_from_recording_label(label: str) -> str:
    clean = str(label or "").strip()
    if not clean:
        return ""
    if ": " in clean:
        clean = clean.split(": ", 1)[1].strip()
    clean = re.sub(r"\s*\(\d{1,2}:\d{2}(?::\d{2})?[–-]\d{1,2}:\d{2}(?::\d{2})?\)\s*$", "", clean).strip()
    return clean


def _resolve_metadata_source(bhajan: Mapping[str, Any]) -> str:
    explicit = str(bhajan.get("metadataSource") or "").strip()
    if explicit:
        return explicit
    for rec in list(bhajan.get("recordings") or []) + list(bhajan.get("addedRecordings") or []):
        coll = str(rec.get("collection") or "").strip()
        if coll.startswith("youtube_"):
            return coll
    if str(bhajan.get("youtubeId") or "").strip():
        return "youtube_channel"
    return "community_contributed"


def _resolve_title(bhajan: Mapping[str, Any], *, metadata_source: str = "") -> str:
    is_yt = metadata_source.startswith("youtube") or bool(str(bhajan.get("youtubeId") or "").strip())
    title = str(bhajan.get("title") or "").strip()
    if title:
        return (yt_sync.clean_youtube_display_title(title) or title) if is_yt else title
    for rec in list(bhajan.get("recordings") or []) + list(bhajan.get("addedRecordings") or []):
        candidate = _extract_title_from_recording_label(str(rec.get("label") or ""))
        if candidate:
            return (yt_sync.clean_youtube_display_title(candidate) or candidate) if is_yt else candidate
    slug = str(bhajan.get("slug") or bhajan.get("id") or "").strip()
    return re.sub(r"[-_]+", " ", slug).strip().title()


def project_bhajan_to_index_entry(
    bhajan: Mapping[str, Any],
    *,
    entity_aliases: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Project a full Bhajan record into a compact `BhajanIndexEntry` for client search."""
    metadata_source = _resolve_metadata_source(bhajan)
    title = _resolve_title(bhajan, metadata_source=metadata_source)
    deity = str(bhajan.get("deity") or "").strip() or (crawler.infer_deity(title) if title else "")
    language = str(bhajan.get("language") or "").strip()
    raga_obj = bhajan.get("raga") or {}
    raga_name = str(raga_obj.get("name") or "").strip()
    beat = str(bhajan.get("beat") or "").strip()
    gents_raw = str((bhajan.get("gentsPitch") or {}).get("raw") or bhajan.get("gentsPitchRaw") or "").strip()
    ladies_raw = str((bhajan.get("ladiesPitch") or {}).get("raw") or bhajan.get("ladiesPitchRaw") or "").strip()

    lyrics_sets = list(bhajan.get("lyricsSets") or [])
    if not lyrics_sets and isinstance(bhajan.get("lyrics"), str) and bhajan["lyrics"].strip():
        lines = [ln.strip() for ln in bhajan["lyrics"].splitlines() if ln.strip()]
        if lines:
            lyrics_sets = [{"language": "Roman", "script": crawler.infer_script_kind(lines, "Roman"), "lines": lines}]
    first_two_lines: list[str] = []
    for lset in lyrics_sets:
        lines = [str(ln).strip() for ln in (lset.get("lines") or []) if str(ln).strip()]
        if lines:
            first_two_lines = lines[:2]
            break

    raw_search = " ".join(part for part in (title, deity, raga_name, " ".join(first_two_lines)) if part)
    search_text = _clean_search_snippet(raw_search, max_len=240)

    token_set: list[str] = []
    seen_tokens: set[str] = set()
    for word in phonetics.canonicalize_phrase(title).split():
        if word and word not in seen_tokens:
            seen_tokens.add(word)
            token_set.append(word)
    for alias in bhajan.get("slugAliases") or []:
        for word in phonetics.canonicalize_phrase(str(alias).replace("-", " ")).split():
            if word and word not in seen_tokens:
                seen_tokens.add(word)
                token_set.append(word)

    normalized_for_missing = bhajan if lyrics_sets == (bhajan.get("lyricsSets") or []) else {**bhajan, "lyricsSets": lyrics_sets, "lyricsMissing": False}
    if bhajan.get("missingFields") and lyrics_sets == (bhajan.get("lyricsSets") or []):
        missing_fields = list(bhajan["missingFields"])
        lyrics_missing = bool(bhajan.get("lyricsMissing")) or ("lyrics" in missing_fields)
    else:
        missing_fields = crawler.compute_missing_bhajan_fields(normalized_for_missing)
        lyrics_missing = ("lyrics" in missing_fields)

    recording_count = len(bhajan.get("recordings") or []) + len(bhajan.get("addedRecordings") or [])
    if recording_count == 0 and str(bhajan.get("youtubeId") or "").strip():
        recording_count = 1

    entry: dict[str, Any] = {
        "id": str(bhajan.get("id") or bhajan.get("slug") or ""),
        "slug": str(bhajan.get("slug") or bhajan.get("id") or ""),
        "title": title,
        "searchText": search_text,
        "phoneticTokens": token_set[:18],
        "lyricsMissing": lyrics_missing,
        "matchStatus": str(bhajan.get("matchStatus") or "verified"),
        "missingFields": missing_fields,
        "recordingCount": recording_count,
        "metadataSource": metadata_source,
    }
    if deity:
        entry["deity"] = deity
    if language:
        entry["language"] = language
    if raga_name and not re.match(r"^Pending Sai Rhythms Sync$", raga_name, re.I):
        entry["ragaName"] = raga_name
    if beat and "(est.)" not in beat.lower():
        entry["beat"] = beat
    if gents_raw and not bhajan.get("isEstimated"):
        entry["gentsPitchRaw"] = gents_raw
    if ladies_raw and not bhajan.get("isEstimated"):
        entry["ladiesPitchRaw"] = ladies_raw
    if bhajan.get("slugAliases"):
        entry["slugAliases"] = list(bhajan["slugAliases"])
    if bhajan.get("updatedAt"):
        entry["updatedAt"] = str(bhajan["updatedAt"])
    return entry


def compute_catalog_stats(bhajans: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Compute exact `CatalogStats` totals from the catalog bhajan records."""
    items = list(bhajans)
    verified = 0
    total_local = 0
    bhajan_downloader = 0
    ravi_mp3 = 0
    youtube_count = 0
    missing_lyrics = 0
    needs_verification = 0

    for item in items:
        if item.get("metadataSource") == "sairhythms_verified":
            verified += 1
        missing = item.get("missingFields") or crawler.compute_missing_bhajan_fields(item)
        if bool(item.get("lyricsMissing")) or ("lyrics" in missing):
            missing_lyrics += 1
        if item.get("matchStatus") == "needs_verification":
            needs_verification += 1
        recs = list(item.get("recordings") or []) + list(item.get("addedRecordings") or [])
        for rec in recs:
            coll = str(rec.get("collection") or "")
            if coll == "sssmediacentre_bhajan_a_day":
                bhajan_downloader += 1
                total_local += 1
            elif coll == "ravimp3_archive":
                ravi_mp3 += 1
                total_local += 1
            elif coll.startswith("youtube"):
                youtube_count += 1
        if not recs and str(item.get("youtubeId") or "").strip():
            youtube_count += 1

    return {
        "totalBhajans": len(items),
        "verifiedSaiRhythmsCount": verified,
        "totalLocalRecordings": total_local,
        "bhajanDownloaderCount": bhajan_downloader,
        "raviMp3Count": ravi_mp3,
        "youtubeVideosCount": youtube_count,
        "missingLyricsCount": missing_lyrics,
        "needsVerificationCount": needs_verification,
    }


def _serialized_shard_size(shard_id: str, version: int, entries: list[dict[str, Any]]) -> int:
    doc = {
        "shardId": shard_id,
        "version": version,
        "count": len(entries),
        "entries": entries,
    }
    return len(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def pack_index_shards(
    entries: list[dict[str, Any]],
    *,
    version: int,
    max_shard_bytes: int = MAX_SHARD_BYTES,
) -> list[dict[str, Any]]:
    """Pack sorted index entries into Firestore shards strictly <= `max_shard_bytes` (< 350 KB)."""
    if not entries:
        return []

    shards: list[dict[str, Any]] = []
    current_entries: list[dict[str, Any]] = []

    def next_shard_id() -> str:
        return f"v{version}_shard_{len(shards) + 1:03d}"

    for entry in entries:
        candidate = current_entries + [entry]
        sid = next_shard_id()
        if current_entries and _serialized_shard_size(sid, version, candidate) > max_shard_bytes:
            shards.append(
                {
                    "shardId": sid,
                    "version": version,
                    "count": len(current_entries),
                    "entries": current_entries,
                }
            )
            current_entries = [entry]
            single_sid = next_shard_id()
            if _serialized_shard_size(single_sid, version, current_entries) > max_shard_bytes:
                raise ValueError(f"Single BhajanIndexEntry {entry.get('id')} exceeds max_shard_bytes={max_shard_bytes}")
        else:
            current_entries = candidate

    if current_entries:
        sid = next_shard_id()
        shards.append(
            {
                "shardId": sid,
                "version": version,
                "count": len(current_entries),
                "entries": current_entries,
            }
        )
    return shards


def compute_index_hash(entries: list[dict[str, Any]]) -> str:
    """Return deterministic SHA-256 hex digest of canonical sorted index entries."""
    encoded = json.dumps(entries, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_catalog_meta(
    *,
    version: int,
    entries: list[dict[str, Any]],
    shards: list[dict[str, Any]],
    stats: dict[str, Any],
    updated_at: str | None = None,
) -> dict[str, Any]:
    """Build canonical `catalogMeta/latest` manifest matching Firestore schema."""
    return {
        "version": version,
        "totalBhajans": len(entries),
        "indexHash": compute_index_hash(entries),
        "shardIds": [s["shardId"] for s in shards],
        "stats": stats,
        "updatedAt": updated_at or utc_now_iso(),
    }


def load_entity_aliases(fs_client: Any = None, seeds_path: Path | None = None) -> dict[str, str]:
    """Load canonical_phrase -> targetBhajanId aliases from Firestore `entityAliases`."""
    aliases: dict[str, str] = {}
    if fs_client is not None:
        for snap in fs_client.collection("entityAliases").stream():
            d = snap.to_dict() or {}
            canon = str(d.get("canonicalPhrase") or phonetics.canonicalize_phrase(str(d.get("variantTitle") or ""))).strip()
            target_id = str(d.get("targetBhajanId") or "").strip()
            if canon and target_id:
                aliases[canon] = target_id
    return aliases


def cross_match_local_archives(
    bhajans: list[dict[str, Any]],
    *,
    entity_aliases: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Opt-in cross-matching against personal local MP3 archives (off unless explicitly enabled)."""
    candidates = [
        {
            "id": b["id"],
            "title": b["title"],
            "lyricsLines": [ln for s in (b.get("lyricsSets") or []) for ln in (s.get("lines") or [])],
        }
        for b in bhajans
    ]
    out_bhajans = [dict(b) for b in bhajans]
    by_id = {b["id"]: b for b in out_bhajans}

    for collection_id, collection_label, root in LOCAL_ARCHIVES:
        if not root.exists():
            continue
        for dirpath, _, filenames in os.walk(root):
            for fname in sorted(filenames):
                if not fname.lower().endswith(".mp3"):
                    continue
                full_path = Path(dirpath) / fname
                title = phonetics.sanitize_title(full_path.stem.replace("_", " "))
                if not title:
                    continue
                eval_res = phonetics.evaluate_match_candidate(
                    title,
                    candidates,
                    entity_aliases=entity_aliases,
                )
                rec_digest = hashlib.sha1(str(full_path).encode("utf-8")).hexdigest()[:12]
                recording = {
                    "id": f"{collection_id[:4]}_{rec_digest}",
                    "label": f"{collection_label}: {full_path.name}",
                    "collection": collection_id,
                    "localPath": str(full_path),
                    "fileSizeBytes": full_path.stat().st_size,
                }
                if eval_res.get("matchStatus") == "verified" and eval_res.get("bestTargetId"):
                    target = by_id[str(eval_res["bestTargetId"])]
                    recs = list(target.get("recordings") or [])
                    if not any(r.get("id") == recording["id"] for r in recs):
                        recs.append(recording)
                        target["recordings"] = recs
                else:
                    slug = re.sub(r"[^a-z0-9-]+", "-", title.lower()).strip("-") or f"local-{rec_digest}"
                    if slug in by_id:
                        slug = f"{slug}-{rec_digest[:6]}"
                    new_doc = {
                        "id": slug,
                        "slug": slug,
                        "title": title,
                        "deity": crawler.infer_deity(title),
                        "language": "",
                        "raga": {"name": ""},
                        "beat": "",
                        "tempo": "",
                        "gentsPitch": None,
                        "ladiesPitch": None,
                        "meaning": None,
                        "lyricsSets": [],
                        "glossary": [],
                        "recordings": [recording],
                        "metadataSource": "local_inferred",
                        "lyricsMissing": True,
                        "matchStatus": str(eval_res.get("matchStatus") or "unmatched"),
                        "matchCandidates": list(eval_res.get("matchCandidates") or [])[:3],
                    }
                    new_doc["missingFields"] = crawler.compute_missing_bhajan_fields(new_doc)
                    by_id[slug] = new_doc
                    out_bhajans.append(new_doc)
    return out_bhajans


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


def _hydrate_firestore_bhajan_doc(
    doc_id: str,
    raw: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Ensure Firestore document ID populates missing `id`/`slug` on legacy records."""
    doc = dict(raw or {})
    if not str(doc.get("id") or "").strip():
        doc["id"] = doc_id
    if not str(doc.get("slug") or "").strip():
        doc["slug"] = doc_id
    return doc


def build_index(
    *,
    source: str = "json",
    input_path: Path = DEFAULT_CATALOG_JSON,
    out_path: Path = DEFAULT_INDEX_OUT,
    seeds_path: Path = DEFAULT_SEEDS_PATH,
    include_local_archives: bool = False,
    publish_firestore: bool = False,
    max_firestore_writes: int = 4000,
    version: int | None = None,
) -> dict[str, Any]:
    """Build slim search entries, validate < 350 KB shards, write index JSON, and optionally publish."""
    fs_client = _init_firestore_client() if (source == "firestore" or publish_firestore) else None

    if source == "firestore":
        bhajans = [
            _hydrate_firestore_bhajan_doc(snap.id, snap.to_dict())
            for snap in fs_client.collection("bhajans").stream()
            if snap.exists
        ]
    else:
        raw = json.loads(input_path.read_text(encoding="utf-8"))
        bhajans = list(raw.get("bhajans", []))

    entity_aliases = load_entity_aliases(fs_client if source == "firestore" else None, seeds_path)
    local_enabled = include_local_archives or (os.environ.get("LOCAL_ARCHIVE_ENABLED", "").lower() == "true")
    if local_enabled:
        bhajans = cross_match_local_archives(bhajans, entity_aliases=entity_aliases)

    entries = [project_bhajan_to_index_entry(b, entity_aliases=entity_aliases) for b in bhajans]
    entries.sort(key=lambda e: (e["title"].lower(), e["id"]))

    resolved_version = version or 1
    if fs_client is not None and version is None:
        meta_snap = fs_client.collection("catalogMeta").document("latest").get()
        if meta_snap.exists:
            resolved_version = int((meta_snap.to_dict() or {}).get("version") or 0) + 1

    shards = pack_index_shards(entries, version=resolved_version, max_shard_bytes=MAX_SHARD_BYTES)
    stats = compute_catalog_stats(bhajans)
    updated_at = utc_now_iso()
    meta = build_catalog_meta(
        version=resolved_version,
        entries=entries,
        shards=shards,
        stats=stats,
        updated_at=updated_at,
    )

    local_payload = {
        "generatedAt": updated_at,
        "version": resolved_version,
        "stats": stats,
        "entries": entries,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(local_payload, indent=2, ensure_ascii=False), encoding="utf-8")

    firestore_writes = 0
    if publish_firestore and fs_client is not None:
        total_ops = len(shards) + 1
        if total_ops > max_firestore_writes:
            raise RuntimeError(f"Index publish needs {total_ops} writes > max_firestore_writes={max_firestore_writes}")
        batch = fs_client.batch()
        for idx, shard in enumerate(shards):
            batch.set(fs_client.collection("catalogIndexShards").document(shard["shardId"]), shard)
            firestore_writes += 1
            if (idx + 1) % 350 == 0:
                batch.commit()
                batch = fs_client.batch()
        batch.set(fs_client.collection("catalogMeta").document("latest"), meta)
        firestore_writes += 1
        batch.commit()

    max_shard_seen = max(
        (_serialized_shard_size(s["shardId"], resolved_version, s["entries"]) for s in shards),
        default=0,
    )
    return {
        "version": resolved_version,
        "totalEntries": len(entries),
        "shardCount": len(shards),
        "maxShardBytes": max_shard_seen,
        "indexHash": meta["indexHash"],
        "localArchivesEnabled": local_enabled,
        "outPath": str(out_path),
        "firestoreWrites": firestore_writes,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build slim sharded bhaJami search index & catalogMeta")
    parser.add_argument("--source", choices=("json", "firestore"), default="json", help="Source of full Bhajan docs")
    parser.add_argument("--input", type=Path, default=DEFAULT_CATALOG_JSON, help="Input catalog.json when --source=json")
    parser.add_argument("--out", type=Path, default=DEFAULT_INDEX_OUT, help="Output slim index JSON path")
    parser.add_argument("--seeds", type=Path, default=DEFAULT_SEEDS_PATH, help="Glossary variant seeds JSON")
    parser.add_argument("--include-local-archives", action="store_true", help="Opt-in local MP3 archive matching")
    parser.add_argument("--publish-firestore", action="store_true", help="Publish catalogIndexShards + catalogMeta/latest")
    parser.add_argument("--max-firestore-writes", type=int, default=4000, help="Hard Firestore write cap")
    parser.add_argument("--version", type=int, default=None, help="Explicit catalog version integer")
    args = parser.parse_args()

    summary = build_index(
        source=args.source,
        input_path=args.input,
        out_path=args.out,
        seeds_path=args.seeds,
        include_local_archives=args.include_local_archives,
        publish_firestore=args.publish_firestore,
        max_firestore_writes=args.max_firestore_writes,
        version=args.version,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
