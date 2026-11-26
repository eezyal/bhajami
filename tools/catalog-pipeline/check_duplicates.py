#!/usr/bin/env python3
"""Daily Bhajan Duplicate Checker using Sanskrit Phonetic + Edit Proximity Heuristics.

Scans the catalog for candidate duplicate bhajan entries (for example an existing
Sai Rhythms entry alongside a separate SSS Media Centre or YouTube entry), applies a
stringent full-lyrics + verse-body veto so distinct bhajans sharing a first line
are never falsely merged, excludes admin-reviewed `doNotMergePairs` and `slugAliases`,
and queues high-proximity pairs (`needs_verification` + `matchCandidates`) for
Admin Review (where Admin chooses a required Default Version and preserves alternates
for users under "More Versions").
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass
import json
import os
from pathlib import Path
import sys
import urllib.parse
import urllib.request
from typing import Any, Iterable, Mapping, Sequence

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
SHARED_DATA_DIR = REPO_ROOT / "packages" / "shared" / "data"
DEFAULT_FIRESTORE_PROJECT_ID = "saibhajanverse"
DEFAULT_MIN_SCORE = 0.78
DEFAULT_MAX_CANDIDATES = 200
DEFAULT_MAX_FIRESTORE_WRITES = 500
USER_AGENT = "bhaJami-DuplicateChecker/1.0 (+https://github.com/eezyal/bhajami)"

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import phonetics  # noqa: E402
import sync_sssmediacentre as sssmc  # noqa: E402
import sync_youtube as yt_sync  # noqa: E402


def levenshtein_distance(a: str, b: str) -> int:
    """Standard Levenshtein character edit distance between two normalized strings."""
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la
    if la < lb:
        a, b = b, a
        la, lb = lb, la

    prev = list(range(lb + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i]
        for j, cb in enumerate(b, start=1):
            ins = cur[j - 1] + 1
            dele = prev[j] + 1
            sub = prev[j - 1] + (0 if ca == cb else 1)
            cur.append(min(ins, dele, sub))
        prev = cur
    return prev[-1]


def edit_proximity(a: str, b: str) -> tuple[float, int]:
    """Return normalized Levenshtein proximity in [0, 1] and raw character edit distance."""
    if not a and not b:
        return (1.0, 0)
    if not a or not b:
        return (0.0, max(len(a), len(b)))
    dist = levenshtein_distance(a, b)
    prox = max(0.0, 1.0 - dist / max(len(a), len(b), 1))
    return (round(prox, 4), dist)


def _extract_recording_keys(doc: Mapping[str, Any]) -> set[str]:
    keys: set[str] = set()
    recs = list(doc.get("recordings") or []) + list(doc.get("addedRecordings") or [])
    for rec in recs:
        if not isinstance(rec, Mapping):
            continue
        yt_id = str(rec.get("youtubeVideoId") or "").strip()
        if yt_id:
            keys.add(f"yt:{yt_id}")
        ext_url = str(rec.get("externalUrl") or "").strip()
        if ext_url:
            keys.add(f"url:{ext_url}")
    return keys


def _metadata_source_rank(source: str) -> int:
    order = {
        "sairhythms_verified": 6,
        "admin_curated": 5,
        "sssmediacentre_verified": 4,
        "community_contributed": 3,
        "local_inferred": 2,
        "youtube_sss_bhajans": 1,
        "youtube_prasanthi_mandir_live": 1,
    }
    return order.get(source, 0)


def target_priority_key(doc: Mapping[str, Any]) -> tuple[Any, ...]:
    """Rank canonical preservation preference (higher tuple wins target status)."""
    doc_id = str(doc.get("id") or doc.get("slug") or "")
    lines = sssmc._extract_roman_lines(doc)  # noqa: SLF001
    recs = list(doc.get("recordings") or []) + list(doc.get("addedRecordings") or [])
    has_sssmc = any(
        isinstance(r, Mapping) and r.get("collection") == "sssmediacentre_bhajan_a_day"
        for r in recs
    )
    raga = doc.get("raga")
    raga_name = (
        str(raga.get("name") if isinstance(raga, Mapping) else raga or "").strip().lower()
    )
    has_raga = bool(raga_name and raga_name not in ("unspecified", "unknown", "traditional", "pending sai rhythms sync"))
    has_pitch = bool(str(doc.get("gentsPitchRaw") or "").strip() or doc.get("gentsPitch"))
    return (
        1 if bool(doc.get("bhajamiOverride")) else 0,
        _metadata_source_rank(str(doc.get("metadataSource") or "")),
        1 if len(lines) >= 2 else 0,
        len(lines),
        1 if has_sssmc else 0,
        len(recs),
        1 if (has_raga or has_pitch) else 0,
        # Deterministic reverse-alphabetical tiebreak so lowest lexical ID wins if reversed,
        # or invert with tuple of negative ordinals? Simply keep doc_id inverted check in choose_canonical_target.
        doc_id,
    )


def choose_canonical_target(
    doc_a: Mapping[str, Any],
    doc_b: Mapping[str, Any],
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    """Return `(canonical_target, duplicate_source)` preferring richer, curated, verified records."""
    ka = target_priority_key(doc_a)
    kb = target_priority_key(doc_b)
    if ka[:-1] != kb[:-1]:
        return (doc_a, doc_b) if ka[:-1] > kb[:-1] else (doc_b, doc_a)
    # Deterministic ID tiebreak (lexicographically smaller ID stays canonical)
    id_a = str(ka[-1])
    id_b = str(kb[-1])
    return (doc_a, doc_b) if id_a <= id_b else (doc_b, doc_a)


@dataclass(frozen=True)
class PreparedBhajan:
    doc: Mapping[str, Any]
    doc_id: str
    raw_title: str
    cleaned_title: str
    canonical: str
    tokens: tuple[str, ...]
    core_tokens: tuple[str, ...]
    title_4grams: frozenset[str]
    roman_lines: tuple[str, ...]
    first_line_canon: str
    lyrics_4grams: frozenset[str]
    lyrics_full_4grams: frozenset[str]
    lyrics_tokens: frozenset[str]
    body_tokens: frozenset[str]
    is_instrumental: bool
    slug_aliases: frozenset[str]
    recording_keys: frozenset[str]
    do_not_merge_with: frozenset[str]


def prepare_bhajan(doc: Mapping[str, Any]) -> PreparedBhajan | None:
    doc_id = str(doc.get("id") or doc.get("slug") or "").strip()
    if not doc_id:
        return None
    raw_title = str(doc.get("title") or "").strip()
    cleaned_title = sssmc.clean_bhajan_title_for_match(raw_title) or phonetics.sanitize_title(raw_title)
    canonical = phonetics.canonicalize_phrase(cleaned_title)
    tokens = tuple(canonical.split()) if canonical else ()
    title_tok_set = set(tokens)
    core_tokens = tuple(
        t for t in tokens if len(t) >= 3 and phonetics._get_idf_weight(t) >= 0.6  # noqa: SLF001
    )
    title_4grams = frozenset(phonetics._build_char_4grams(canonical)) if canonical else frozenset()  # noqa: SLF001
    roman_lines = tuple(sssmc._extract_roman_lines(doc))  # noqa: SLF001
    first_line_canon = phonetics.canonicalize_phrase(roman_lines[0]) if roman_lines else ""

    cleaned_lines_24 = [
        phonetics.canonicalize_phrase(phonetics._REPETITION_RE.sub(" ", ln))  # noqa: SLF001
        for ln in roman_lines[:24]
    ]
    cleaned_lines_12 = cleaned_lines_24[:12]
    lyrics_sample_12 = " ".join(c for c in cleaned_lines_12 if c)
    lyrics_4grams = (
        frozenset(phonetics._build_char_4grams(lyrics_sample_12))  # noqa: SLF001
        if len(roman_lines) >= 2 and lyrics_sample_12
        else frozenset()
    )
    lyrics_sample_24 = " ".join(c for c in cleaned_lines_24 if c)
    lyrics_full_4grams = (
        frozenset(phonetics._build_char_4grams(lyrics_sample_24))  # noqa: SLF001
        if len(roman_lines) >= 2 and lyrics_sample_24
        else frozenset()
    )
    lyrics_tokens_set: set[str] = set()
    body_tokens_set: set[str] = set()
    for canon_ln in cleaned_lines_24:
        for tok in canon_ln.split():
            if not tok:
                continue
            lyrics_tokens_set.add(tok)
            if tok not in title_tok_set and phonetics._get_idf_weight(tok) >= 0.6:  # noqa: SLF001
                body_tokens_set.add(tok)

    aliases = frozenset(str(a).strip() for a in (doc.get("slugAliases") or []) if str(a).strip())
    rec_keys = frozenset(_extract_recording_keys(doc))
    dnm_with = frozenset(str(x).strip() for x in (doc.get("doNotMergeWith") or []) if str(x).strip())

    return PreparedBhajan(
        doc=doc,
        doc_id=doc_id,
        raw_title=raw_title or doc_id,
        cleaned_title=cleaned_title or raw_title or doc_id,
        canonical=canonical,
        tokens=tokens,
        core_tokens=core_tokens,
        title_4grams=title_4grams,
        roman_lines=roman_lines,
        first_line_canon=first_line_canon,
        lyrics_4grams=lyrics_4grams,
        lyrics_full_4grams=lyrics_full_4grams,
        lyrics_tokens=frozenset(lyrics_tokens_set),
        body_tokens=frozenset(body_tokens_set),
        is_instrumental=sssmc._is_instrumental_text(raw_title),  # noqa: SLF001
        slug_aliases=aliases,
        recording_keys=rec_keys,
        do_not_merge_with=dnm_with,
    )


def _fast_jaccard(set_a: frozenset[str], set_b: frozenset[str]) -> float:
    if not set_a or not set_b:
        return 0.0
    inter = len(set_a & set_b)
    if inter == 0:
        return 0.0
    return inter / (len(set_a) + len(set_b) - inter)


def _build_candidate_pairs(items: Sequence[PreparedBhajan]) -> list[tuple[int, int]]:
    """Inverted blocking index + O(1) Jaccard filter yielding candidate pairs `(i, j)` with `i < j`."""
    exact_buckets: dict[str, list[int]] = defaultdict(list)
    token_buckets: dict[str, list[int]] = defaultdict(list)
    title_4g_buckets: dict[str, list[int]] = defaultdict(list)
    lyrics_4g_buckets: dict[str, list[int]] = defaultdict(list)

    for idx, item in enumerate(items):
        if item.canonical:
            exact_buckets[f"c:{item.canonical}"].append(idx)
        if item.first_line_canon and len(item.first_line_canon) >= 12:
            exact_buckets[f"fl:{item.first_line_canon}"].append(idx)
        for rkey in item.recording_keys:
            exact_buckets[f"r:{rkey}"].append(idx)

        seen_toks: set[str] = set()
        for tok in item.core_tokens:
            if tok not in seen_toks:
                seen_toks.add(tok)
                token_buckets[tok].append(idx)

        for g in item.title_4grams:
            title_4g_buckets[g].append(idx)
        for g in item.lyrics_4grams:
            lyrics_4g_buckets[g].append(idx)

    max_t4_postings = 120
    max_l4_postings = 60
    max_tok_postings = 200

    exact_pairs: set[tuple[int, int]] = set()
    for bucket in exact_buckets.values():
        if 2 <= len(bucket) <= 40:
            for a_pos in range(len(bucket)):
                ia = bucket[a_pos]
                for b_pos in range(a_pos + 1, len(bucket)):
                    ib = bucket[b_pos]
                    exact_pairs.add((ia, ib) if ia < ib else (ib, ia))

    raw_candidates: set[tuple[int, int]] = set()
    tok_pair_counts: dict[tuple[int, int], int] = defaultdict(int)
    for bucket in token_buckets.values():
        if 2 <= len(bucket) <= 25:
            for a_pos in range(len(bucket)):
                ia = bucket[a_pos]
                for b_pos in range(a_pos + 1, len(bucket)):
                    ib = bucket[b_pos]
                    pair = (ia, ib) if ia < ib else (ib, ia)
                    if pair not in exact_pairs:
                        raw_candidates.add(pair)
        elif 25 < len(bucket) <= max_tok_postings:
            for a_pos in range(len(bucket)):
                ia = bucket[a_pos]
                for b_pos in range(a_pos + 1, len(bucket)):
                    ib = bucket[b_pos]
                    pair = (ia, ib) if ia < ib else (ib, ia)
                    if pair not in exact_pairs and pair not in raw_candidates:
                        tok_pair_counts[pair] += 1
    for pair, cnt in tok_pair_counts.items():
        if cnt >= 2:
            raw_candidates.add(pair)

    t4_pair_counts: dict[tuple[int, int], int] = defaultdict(int)
    for bucket in title_4g_buckets.values():
        if 2 <= len(bucket) <= max_t4_postings:
            for a_pos in range(len(bucket)):
                ia = bucket[a_pos]
                for b_pos in range(a_pos + 1, len(bucket)):
                    ib = bucket[b_pos]
                    pair = (ia, ib) if ia < ib else (ib, ia)
                    if pair not in exact_pairs and pair not in raw_candidates:
                        t4_pair_counts[pair] += 1
    for pair, cnt in t4_pair_counts.items():
        if cnt >= 3:
            raw_candidates.add(pair)

    l4_pair_counts: dict[tuple[int, int], int] = defaultdict(int)
    for bucket in lyrics_4g_buckets.values():
        if 2 <= len(bucket) <= max_l4_postings:
            for a_pos in range(len(bucket)):
                ia = bucket[a_pos]
                for b_pos in range(a_pos + 1, len(bucket)):
                    ib = bucket[b_pos]
                    pair = (ia, ib) if ia < ib else (ib, ia)
                    if pair not in exact_pairs and pair not in raw_candidates:
                        l4_pair_counts[pair] += 1
    for pair, cnt in l4_pair_counts.items():
        if cnt >= 12:
            raw_candidates.add(pair)

    filtered_pairs: set[tuple[int, int]] = set(exact_pairs)
    for ia, ib in raw_candidates:
        pa, pb = items[ia], items[ib]
        if (
            _fast_jaccard(pa.title_4grams, pb.title_4grams) >= 0.28
            or _fast_jaccard(pa.lyrics_4grams, pb.lyrics_4grams) >= 0.30
        ):
            filtered_pairs.add((ia, ib))

    return sorted(filtered_pairs)


def evaluate_duplicate_pair(
    prep_a: PreparedBhajan,
    prep_b: PreparedBhajan,
    *,
    do_not_merge_set: set[str] | frozenset[str] = frozenset(),
    min_score: float = DEFAULT_MIN_SCORE,
) -> dict[str, Any]:
    """Evaluate two prepared bhajan documents using phonetic + edit proximity and full-lyrics veto."""
    if prep_a.doc_id == prep_b.doc_id:
        return {"status": "skip", "reason": "same_id"}

    if prep_b.doc_id in prep_a.slug_aliases or prep_a.doc_id in prep_b.slug_aliases:
        return {"status": "skip", "reason": "already_aliased"}

    if prep_a.doc_id in prep_b.do_not_merge_with or prep_b.doc_id in prep_a.do_not_merge_with:
        return {"status": "skip", "reason": "do_not_merge"}

    if phonetics.make_do_not_merge_key(prep_a.doc_id, prep_b.doc_id) in do_not_merge_set:
        return {"status": "skip", "reason": "do_not_merge"}
    if prep_a.canonical and (
        phonetics.make_do_not_merge_key(prep_a.canonical, prep_b.doc_id) in do_not_merge_set
    ):
        return {"status": "skip", "reason": "do_not_merge"}
    if prep_b.canonical and (
        phonetics.make_do_not_merge_key(prep_a.doc_id, prep_b.canonical) in do_not_merge_set
    ):
        return {"status": "skip", "reason": "do_not_merge"}

    if prep_a.is_instrumental != prep_b.is_instrumental:
        return {"status": "skip", "reason": "instrumental_vs_vocal"}

    shared_recording = bool(prep_a.recording_keys & prep_b.recording_keys)
    same_canon_or_fl = bool(
        (prep_a.canonical and prep_a.canonical == prep_b.canonical)
        or (prep_a.first_line_canon and prep_a.first_line_canon == prep_b.canonical)
        or (prep_b.first_line_canon and prep_b.first_line_canon == prep_a.canonical)
    )
    fast_title_4g = _fast_jaccard(prep_a.title_4grams, prep_b.title_4grams)
    fast_lyrics_4g = _fast_jaccard(prep_a.lyrics_4grams, prep_b.lyrics_4grams)
    if not shared_recording and not same_canon_or_fl:
        if fast_title_4g < 0.28 and fast_lyrics_4g < 0.30:
            return {"status": "below_threshold", "score": 0.0}

    lyrics_sim: float | None = None
    body_sim: float | None = None
    has_both_lyrics = len(prep_a.roman_lines) >= 2 and len(prep_b.roman_lines) >= 2

    if has_both_lyrics:
        flat_4g = _fast_jaccard(prep_a.lyrics_full_4grams, prep_b.lyrics_full_4grams)
        tok_j = _fast_jaccard(prep_a.lyrics_tokens, prep_b.lyrics_tokens)
        fast_flat_sim = 0.55 * flat_4g + 0.45 * tok_j

        body_a = prep_a.body_tokens - set(prep_b.tokens)
        body_b = prep_b.body_tokens - set(prep_a.tokens)
        if len(body_a) >= 3 and len(body_b) >= 3:
            body_sim = len(body_a & body_b) / max(1, len(body_a | body_b))

        # Instant full-lyrics + verse-body veto without running heavy line-by-line DP
        if not shared_recording and (
            fast_flat_sim < 0.32 or (body_sim is not None and body_sim < 0.25)
        ):
            return {
                "status": "vetoed",
                "reason": "different_lyrics",
                "lyricsSim": round(fast_flat_sim, 4),
                "bodyLyricsSim": round(body_sim, 4) if body_sim is not None else None,
            }

        if fast_flat_sim < 0.65:
            line_sim = phonetics.compute_lyrics_overlap(
                prep_a.roman_lines[:24], prep_b.roman_lines[:24]
            )
            lyrics_sim = max(fast_flat_sim, line_sim)
        else:
            lyrics_sim = fast_flat_sim

        if not shared_recording and lyrics_sim < 0.45:
            return {
                "status": "vetoed",
                "reason": "different_lyrics",
                "lyricsSim": round(lyrics_sim, 4),
                "bodyLyricsSim": round(body_sim, 4) if body_sim is not None else None,
            }

    edit_prox, char_dist = edit_proximity(prep_a.canonical, prep_b.canonical)
    phonetic_sim = phonetics.compute_title_similarity(prep_a.cleaned_title, prep_b.cleaned_title)
    title_prox = 0.55 * phonetic_sim + 0.45 * edit_prox

    first_line_title_prox = 0.0
    if prep_a.first_line_canon and prep_b.canonical and prep_a.first_line_canon != prep_a.canonical:
        fl_ep, _ = edit_proximity(prep_a.first_line_canon, prep_b.canonical)
        if fl_ep >= 0.50 or prep_a.first_line_canon == prep_b.canonical:
            fl_ph = phonetics.compute_title_similarity(prep_a.roman_lines[0], prep_b.cleaned_title)
            first_line_title_prox = 0.55 * fl_ph + 0.45 * fl_ep
    if prep_b.first_line_canon and prep_a.canonical and prep_b.first_line_canon != prep_b.canonical:
        fl_ep2, _ = edit_proximity(prep_b.first_line_canon, prep_a.canonical)
        if fl_ep2 >= 0.50 or prep_b.first_line_canon == prep_a.canonical:
            fl_ph2 = phonetics.compute_title_similarity(prep_b.roman_lines[0], prep_a.cleaned_title)
            first_line_title_prox = max(first_line_title_prox, 0.55 * fl_ph2 + 0.45 * fl_ep2)

    best_title_prox = max(title_prox, first_line_title_prox)
    _, matched_core_count = sssmc._is_prefix_subset_match(  # noqa: SLF001
        prep_a.cleaned_title, prep_b.cleaned_title
    )

    if has_both_lyrics:
        assert lyrics_sim is not None
        if lyrics_sim >= 0.55:
            composite = max(
                best_title_prox,
                0.50 * lyrics_sim + 0.50 * best_title_prox,
                0.55 * lyrics_sim + 0.45 * edit_prox,
            )
        else:
            composite = 0.50 * lyrics_sim + 0.50 * best_title_prox
        if shared_recording:
            composite = max(composite, 0.96)

        should_flag = (
            shared_recording
            or composite >= min_score
            or (lyrics_sim >= 0.70 and (body_sim is None or body_sim >= 0.45))
        )
        if not should_flag:
            return {"status": "below_threshold", "score": round(composite, 4)}

        if shared_recording:
            reason = f"shared_recording_and_proximity (dist={char_dist}, lyrics={lyrics_sim:.2f})"
        elif lyrics_sim >= 0.70 and best_title_prox < min_score:
            reason = f"lyrics_confirmed_cross_title (lyrics={lyrics_sim:.2f}, prox={best_title_prox:.2f})"
        else:
            reason = f"proximity+lyrics (dist={char_dist}, prox={best_title_prox:.2f}, lyrics={lyrics_sim:.2f})"
    else:
        # One or both docs missing full lyrics -> guard against short 1-word generic matches
        composite = max(best_title_prox, 0.96 if shared_recording else 0.0)
        both_single_token = len(prep_a.tokens) == 1 and len(prep_b.tokens) == 1
        same_canon = bool(prep_a.canonical and prep_a.canonical == prep_b.canonical)
        passes_token_guard = (
            shared_recording
            or same_canon
            or matched_core_count >= 2
            or (both_single_token and char_dist <= 2)
        )
        # Also allow close Levenshtein distance when canonical titles have >= 12 chars and >= 2 tokens
        if not passes_token_guard and len(prep_a.canonical) >= 12 and len(prep_b.canonical) >= 12:
            if edit_prox >= 0.84 or first_line_title_prox >= max(min_score, 0.84):
                passes_token_guard = True

        if not (passes_token_guard and composite >= min_score):
            return {"status": "below_threshold", "score": round(composite, 4)}

        if shared_recording:
            reason = f"shared_recording (dist={char_dist})"
        elif same_canon:
            reason = f"exact_canonical_proximity (dist={char_dist}, prox={best_title_prox:.2f})"
        else:
            reason = f"title_proximity (dist={char_dist}, prox={best_title_prox:.2f}, phon={phonetic_sim:.2f})"

    target_doc, source_doc = choose_canonical_target(prep_a.doc, prep_b.doc)
    target_recs = list(target_doc.get("recordings") or []) + list(target_doc.get("addedRecordings") or [])
    source_recs = list(source_doc.get("recordings") or []) + list(source_doc.get("addedRecordings") or [])
    target_id = str(target_doc.get("id") or target_doc.get("slug") or "")
    source_id = str(source_doc.get("id") or source_doc.get("slug") or "")

    return {
        "status": "flagged",
        "sourceId": source_id,
        "sourceTitle": str(source_doc.get("title") or source_id),
        "sourceMetadataSource": str(source_doc.get("metadataSource") or ""),
        "sourceRecordingsCount": len(source_recs),
        "targetId": target_id,
        "targetTitle": str(target_doc.get("title") or target_id),
        "targetMetadataSource": str(target_doc.get("metadataSource") or ""),
        "targetRecordingsCount": len(target_recs),
        "score": round(min(1.0, float(composite)), 4),
        "titleProximity": round(float(best_title_prox), 4),
        "phoneticSim": round(float(phonetic_sim), 4),
        "editProximity": round(float(edit_prox), 4),
        "charEditDistance": int(char_dist),
        "lyricsSim": round(float(lyrics_sim), 4) if lyrics_sim is not None else None,
        "bodyLyricsSim": round(float(body_sim), 4) if body_sim is not None else None,
        "reason": reason,
    }


def scan_catalog_duplicates(
    docs: Sequence[Mapping[str, Any]],
    *,
    do_not_merge_pairs: Iterable[str] = (),
    min_score: float = DEFAULT_MIN_SCORE,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
) -> dict[str, Any]:
    """Scan all bhajan documents and return sorted candidate duplicate pairs for Admin Review."""
    prepared: list[PreparedBhajan] = []
    for doc in docs:
        prep = prepare_bhajan(doc)
        if prep is not None:
            prepared.append(prep)

    dnm_set = {str(p).strip() for p in do_not_merge_pairs if str(p).strip()}
    candidate_indices = _build_candidate_pairs(prepared)

    flagged: list[dict[str, Any]] = []
    vetoed_different_lyrics = 0
    skipped_do_not_merge = 0
    skipped_aliased = 0

    for ia, ib in candidate_indices:
        res = evaluate_duplicate_pair(
            prepared[ia],
            prepared[ib],
            do_not_merge_set=dnm_set,
            min_score=min_score,
        )
        status = res.get("status")
        if status == "flagged":
            flagged.append(res)
        elif status == "vetoed":
            vetoed_different_lyrics += 1
        elif status == "skip":
            reason = res.get("reason")
            if reason == "do_not_merge":
                skipped_do_not_merge += 1
            elif reason == "already_aliased":
                skipped_aliased += 1

    flagged.sort(
        key=lambda item: (
            -float(item["score"]),
            int(item["charEditDistance"]),
            str(item["sourceId"]),
            str(item["targetId"]),
        )
    )
    limited = flagged[:max_candidates] if max_candidates > 0 else flagged

    return {
        "scannedBhajans": len(prepared),
        "candidatePairsEvaluated": len(candidate_indices),
        "totalFlaggedBeforeLimit": len(flagged),
        "flaggedPairs": len(limited),
        "vetoedDifferentLyrics": vetoed_different_lyrics,
        "skippedDoNotMerge": skipped_do_not_merge,
        "skippedAliased": skipped_aliased,
        "minScore": float(min_score),
        "pairs": limited,
    }


def load_do_not_merge_pairs(
    fs_client: Any = None,
    *,
    do_not_merge_json: Path | None = None,
) -> list[str]:
    pairs: list[str] = []
    if do_not_merge_json is not None and do_not_merge_json.exists():
        raw = json.loads(do_not_merge_json.read_text(encoding="utf-8"))
        if isinstance(raw, Mapping):
            pairs.extend(str(k) for k in raw.keys())
        elif isinstance(raw, list):
            for entry in raw:
                if isinstance(entry, str):
                    pairs.append(entry)
                elif isinstance(entry, Mapping) and entry.get("id"):
                    pairs.append(str(entry["id"]))
    if fs_client is not None:
        for snap in fs_client.collection("doNotMergePairs").stream():
            if snap.exists:
                pairs.append(snap.id)
    return pairs


def publish_duplicate_candidates_to_firestore(
    fs_client: Any,
    docs_by_id: Mapping[str, Mapping[str, Any]],
    pairs: Sequence[Mapping[str, Any]],
    *,
    scanned_count: int = 0,
    vetoed_count: int = 0,
    max_writes: int = DEFAULT_MAX_FIRESTORE_WRITES,
) -> dict[str, int]:
    """Queue detected duplicate candidates into `needs_verification` on source docs without auto-merging."""
    started_at = sssmc.utc_now_iso()
    by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for pair in pairs:
        src_id = str(pair.get("sourceId") or "")
        if not src_id or src_id not in docs_by_id:
            continue
        by_source[src_id].append(
            {
                "targetBhajanId": str(pair["targetId"]),
                "targetTitle": str(pair["targetTitle"]),
                "score": float(pair["score"]),
                "reason": str(pair["reason"]),
            }
        )

    batch = fs_client.batch()
    batch_ops = 0
    writes = 0
    queued_sources = 0

    for src_id, new_cands in by_source.items():
        if writes >= max_writes - 1:
            break
        existing_doc = docs_by_id[src_id]
        merged_by_target: dict[str, dict[str, Any]] = {}
        for old_c in existing_doc.get("matchCandidates") or []:
            if isinstance(old_c, Mapping) and old_c.get("targetBhajanId"):
                merged_by_target[str(old_c["targetBhajanId"])] = {
                    "targetBhajanId": str(old_c["targetBhajanId"]),
                    "targetTitle": str(old_c.get("targetTitle") or old_c["targetBhajanId"]),
                    "score": float(old_c.get("score") or 0.0),
                    "reason": str(old_c.get("reason") or "prior_candidate"),
                }
        for c in new_cands:
            tid = str(c["targetBhajanId"])
            prev = merged_by_target.get(tid)
            if prev is None or float(c["score"]) >= float(prev.get("score") or 0.0):
                merged_by_target[tid] = c

        def _cand_sort_key(item: Mapping[str, Any]) -> tuple[Any, ...]:
            tid = str(item["targetBhajanId"])
            tdoc = docs_by_id.get(tid)
            if tdoc is not None:
                pk = target_priority_key(tdoc)
                return (-float(item["score"]), tuple(-int(v) for v in pk[:-1]), str(pk[-1]))
            return (-float(item["score"]), (0,), tid)

        top_cands = sorted(merged_by_target.values(), key=_cand_sort_key)[:5]

        # Skip redundant write if status and candidate IDs+scores already match
        existing_top = [
            (str(c.get("targetBhajanId")), round(float(c.get("score") or 0.0), 4))
            for c in (existing_doc.get("matchCandidates") or [])
            if isinstance(c, Mapping)
        ]
        new_top = [
            (str(c["targetBhajanId"]), round(float(c["score"]), 4)) for c in top_cands
        ]
        if (
            existing_doc.get("matchStatus") == "needs_verification"
            and existing_top == new_top
        ):
            continue

        patch = {
            "matchStatus": "needs_verification",
            "matchCandidates": top_cands,
            "updatedAt": sssmc.utc_now_iso(),
        }
        batch.set(fs_client.collection("bhajans").document(src_id), patch, merge=True)
        batch_ops += 1
        writes += 1
        queued_sources += 1
        if batch_ops >= 400:
            batch.commit()
            batch = fs_client.batch()
            batch_ops = 0

    if batch_ops > 0:
        batch.commit()

    finished_at = sssmc.utc_now_iso()
    run_id = f"dup_{started_at.replace(':', '').replace('-', '')}"
    fs_client.collection("ingestionRuns").document(run_id).set(
        {
            "runId": run_id,
            "source": "duplicate_checker",
            "startedAt": started_at,
            "finishedAt": finished_at,
            "status": "success",
            "itemsScanned": int(scanned_count),
            "matchedAuto": 0,
            "queuedDoubt": int(queued_sources),
            "createdNew": 0,
            "skippedDuplicate": int(vetoed_count),
            "parseErrors": 0,
            "youtubeQuotaUnitsUsed": 0,
            "firestoreWrites": writes + 1,
        }
    )
    return {"queuedSources": queued_sources, "firestoreWrites": writes + 1}


def format_dry_run_summary(report: Mapping[str, Any], *, top: int = 30) -> str:
    lines = [
        f"Duplicate Check Summary ({report['scannedBhajans']} bhajans scanned, "
        f"{report['candidatePairsEvaluated']} candidate pairs evaluated):",
        f"  Flagged duplicate pairs: {report['flaggedPairs']} "
        f"(total before cap: {report['totalFlaggedBeforeLimit']}, minScore={report['minScore']})",
        f"  Vetoed (different full lyrics): {report['vetoedDifferentLyrics']}",
        f"  Skipped (doNotMergePairs): {report['skippedDoNotMerge']}, "
        f"Skipped (already aliased): {report['skippedAliased']}",
        "",
        f"Top {min(top, len(report['pairs']))} candidate pairs for Admin Review:",
    ]
    for idx, pair in enumerate(report["pairs"][:top], start=1):
        lyrics_part = (
            f"lyrics={pair['lyricsSim']:.2f}" if pair["lyricsSim"] is not None else "lyrics=n/a"
        )
        lines.append(
            f"  {idx:2d}. [{pair['score']:.3f} | dist={pair['charEditDistance']} | {lyrics_part}] "
            f"Target: \"{pair['targetTitle']}\" ({pair['targetId']}, {pair['targetMetadataSource']}, {pair['targetRecordingsCount']} media) "
            f"<-- Source: \"{pair['sourceTitle']}\" ({pair['sourceId']}, {pair['sourceMetadataSource']}, {pair['sourceRecordingsCount']} media) "
            f"[{pair['reason']}]"
        )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Daily Bhajan Duplicate Checker with Sanskrit phonetic + edit proximity heuristic"
    )
    parser.add_argument(
        "--source",
        choices=("firestore", "firestore-rest", "local"),
        default="firestore",
        help="Catalog source to scan (dry-run auto-falls back to firestore-rest without creds)",
    )
    parser.add_argument("--project-id", default=DEFAULT_FIRESTORE_PROJECT_ID)
    parser.add_argument("--local-json", type=Path, default=SHARED_DATA_DIR / "catalog.json")
    parser.add_argument("--do-not-merge-json", type=Path, default=None)
    parser.add_argument("--min-score", type=float, default=DEFAULT_MIN_SCORE)
    parser.add_argument("--max-candidates", type=int, default=DEFAULT_MAX_CANDIDATES)
    parser.add_argument("--max-firestore-writes", type=int, default=DEFAULT_MAX_FIRESTORE_WRITES)
    parser.add_argument("--dry-run", action="store_true", help="Do not write to Firestore")
    parser.add_argument(
        "--publish-firestore",
        action="store_true",
        help="Queue flagged pairs into needs_verification on source docs in Firestore",
    )
    parser.add_argument("--top", type=int, default=30, help="Number of pairs to print in summary")
    parser.add_argument("--report-json", type=Path, default=None, help="Optional JSON report path")
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
    dnm_pairs = load_do_not_merge_pairs(fs_client, do_not_merge_json=args.do_not_merge_json)

    report = scan_catalog_duplicates(
        docs,
        do_not_merge_pairs=dnm_pairs,
        min_score=args.min_score,
        max_candidates=args.max_candidates,
    )

    if args.publish_firestore and not args.dry_run:
        if fs_client is None:
            raise RuntimeError(
                "--publish-firestore requires --source firestore with Admin credentials."
            )
        docs_by_id = {
            str(d.get("id") or d.get("slug")): d
            for d in docs
            if str(d.get("id") or d.get("slug"))
        }
        pub_stats = publish_duplicate_candidates_to_firestore(
            fs_client,
            docs_by_id,
            report["pairs"],
            scanned_count=report["scannedBhajans"],
            vetoed_count=report["vetoedDifferentLyrics"],
            max_writes=args.max_firestore_writes,
        )
        report["publishStats"] = pub_stats

    if args.report_json is not None:
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    print(format_dry_run_summary(report, top=args.top))


if __name__ == "__main__":
    main()
