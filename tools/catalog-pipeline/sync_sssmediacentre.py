#!/usr/bin/env python3
"""Rule-compliant SSS Media Centre (Bhajan A Day) MP3 & Metadata Enrichment Pipeline.

Fetches explicitly allowed `/listen/<slug>` pages from `www.sssmediacentre.org` (respecting
`robots.txt`: never calling disallowed `/api/`, `/payload/`, `/admin/`, `/user/`, or `/backup/`
endpoints and sleeping `>= 1.5s` between HTTP requests), extracts direct Cloudflare CDN `.mp3`
links + full metadata (`raga`, `tala`, `tempo`, `deity`, `sruthi_male`, `sruthi_female`, `meaning`,
`lyrics`, `DurationSpan`), performs fool-proof multi-signal matching against existing Firestore
bhajan docs, creates clean `sssmediacentre_verified` docs for unmatched bhajans, and checkpoints
progress in `crawl_state.sqlite3`.
"""

from __future__ import annotations

import argparse
import hashlib
import html as html_lib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
SHARED_DATA_DIR = REPO_ROOT / "packages" / "shared" / "data"
DEFAULT_STATE_DB = SCRIPT_DIR / "crawl_state.sqlite3"
DEFAULT_MAX_FIRESTORE_WRITES = 4000
DEFAULT_FIRESTORE_PROJECT_ID = "saibhajanverse"
SSSMC_ORIGIN = "https://www.sssmediacentre.org"
USER_AGENT = "bhaJami-CatalogBot/1.0 (+https://github.com/eezyal/bhajami)"

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import crawl_sairhythms as crawler  # noqa: E402
import phonetics  # noqa: E402
import sync_youtube as yt_sync  # noqa: E402

DISALLOWED_ROBOTS_PREFIXES: tuple[str, ...] = (
    "/admin",
    "/api",
    "/payload",
    "/user",
    "/backup",
)

INSTRUMENTAL_KEYWORDS_RE = re.compile(
    r"\b(?:instrumental|veena|flute|bansuri|sitar|violin|guitar|piano|karaoke|nadaswaram|saxophone|harmonium)\b",
    re.I,
)

WESTERN_PITCH_SEMITONES: dict[str, int] = {
    "C": 0,
    "B#": 0,
    "C#": 1,
    "DB": 1,
    "D": 2,
    "D#": 3,
    "EB": 3,
    "E": 4,
    "FB": 4,
    "E#": 5,
    "F": 5,
    "F#": 6,
    "GB": 6,
    "G": 7,
    "G#": 8,
    "AB": 8,
    "A": 9,
    "A#": 10,
    "BB": 10,
    "B": 11,
    "CB": 11,
}

LEADING_WESTERN_NOTE_RE = re.compile(
    r"^\s*([A-G](?:\s*[#b♯♭])?)(?=\s*[-–—/,(]|$)",
    re.I,
)

NEXT_F_PUSH_RE = re.compile(
    r'self\.__next_f\.push\(\[\s*\d+\s*,\s*("(?:\\.|[^"\\])*")\s*\]\)'
)

BROWSER_EXPORT_SNIPPET = r"""// Paste in DevTools Console on:
// https://www.sssmediacentre.org/listen/group/bhajan-a-day?view=list&categories=69d9f362f994d5e33bbebb11&sortBy=publishDate
// Click through pages (or "Load More") while it collects /listen/<slug> links, then run downloadSssmcUrls().
(() => {
  const urls = window.__sssmcCollectedUrls || (window.__sssmcCollectedUrls = new Set());
  const collect = () => {
    document.querySelectorAll('a[href*="/listen/"]').forEach((a) => {
      try {
        const u = new URL(a.href, location.origin);
        if (/^\/listen\/[a-z0-9-]+-[a-f0-9]{24}$/i.test(u.pathname)) {
          urls.add(u.origin + u.pathname);
        }
      } catch {}
    });
    console.log('[bhaJami] Collected', urls.size, 'Bhajan A Day URLs so far');
  };
  collect();
  if (!window.__sssmcObserver) {
    window.__sssmcObserver = new MutationObserver(collect);
    window.__sssmcObserver.observe(document.body, { childList: true, subtree: true });
  }
  window.downloadSssmcUrls = () => {
    collect();
    const text = Array.from(urls).sort().join('\n') + '\n';
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sssmc_bhajan_a_day_urls.txt';
    a.click();
    return urls.size;
  };
  console.log('Now paginate/scroll through the list, then run: downloadSssmcUrls()');
})();"""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_url_allowed_by_robots(url: str) -> bool:
    """Enforce www.sssmediacentre.org robots.txt rules before any HTTP request."""
    try:
        parsed = urllib.parse.urlsplit(url.strip())
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    if host not in ("www.sssmediacentre.org", "sssmediacentre.org"):
        return False
    path = parsed.path or "/"
    for prefix in DISALLOWED_ROBOTS_PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            return False
    return True


def encode_media_url(raw_url: str) -> str:
    """Percent-encode spaces and unsafe path characters while keeping scheme/host/query intact."""
    raw = str(raw_url or "").strip()
    if not raw:
        return ""
    parts = urllib.parse.urlsplit(raw)
    decoded_path = urllib.parse.unquote(parts.path)
    safe_path = urllib.parse.quote(decoded_path, safe="/:@!$&'()*+,;=-._~")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, safe_path, parts.query, parts.fragment))


def parse_duration_span(raw: str | None) -> int | None:
    """Parse `HH:MM:SS` or `MM:SS` strings like `00:04:02` into integer seconds."""
    text = str(raw or "").strip()
    if not text:
        return None
    if re.fullmatch(r"\d+", text):
        val = int(text)
        return val if val > 0 else None
    parts = text.split(":")
    if len(parts) not in (2, 3) or not all(p.isdigit() for p in parts):
        return None
    nums = [int(p) for p in parts]
    total = nums[0] * 60 + nums[1] if len(nums) == 2 else nums[0] * 3600 + nums[1] * 60 + nums[2]
    return total if total > 0 else None


def parse_sssmc_pitch(raw: str | None) -> dict[str, Any] | None:
    """Parse SSSMC pitch strings like `A - 3 M` or `G - 5 P` without confusing Madhyam/Pancham."""
    if not raw or not str(raw).strip():
        return None
    cleaned = crawler.clean_text(str(raw))
    m = LEADING_WESTERN_NOTE_RE.match(cleaned)
    if m:
        note_token = re.sub(r"\s+", "", m.group(1)).replace("♯", "#").replace("♭", "b").upper()
        semitone = WESTERN_PITCH_SEMITONES.get(note_token)
        if semitone is not None:
            _, pancham, western = crawler.CHROMATIC_STEPS[semitone]
            return {
                "raw": cleaned,
                "pancham": pancham,
                "western": western,
                "semitoneFromC": semitone,
            }
    return crawler.parse_pitch_info_optional(cleaned)


def clean_sssmc_title(raw_title: str | None) -> str:
    """Clean SSS Media Centre title variants such as `<Title> - A Bhajan A Day`."""
    t = html_lib.unescape(str(raw_title or "")).replace("\xa0", " ").strip()
    t = re.sub(r"^\s*Listen\s*[-–—:]\s*", "", t, flags=re.I)
    t = re.sub(r"\s*[-–—]\s*(?:A\s+)?Bhajan\s+A\s+Day.*$", "", t, flags=re.I)
    t = yt_sync.clean_youtube_display_title(t) or t
    t = re.sub(r"\s+", " ", t).strip()
    return t


def clean_bhajan_title_for_match(raw_title: str | None) -> str:
    """Normalize either SSSMC or catalog titles by stripping prefixes, pipes, and tags."""
    stripped = clean_sssmc_title(raw_title)
    return phonetics.sanitize_title(stripped)


def _extract_rsc_stream_text(html: str) -> str:
    chunks: list[str] = []
    for match in NEXT_F_PUSH_RE.finditer(html):
        try:
            decoded = json.loads(match.group(1))
            if isinstance(decoded, str):
                chunks.append(decoded)
        except json.JSONDecodeError:
            continue
    return "\n".join(chunks)


def _extract_json_string_field(text: str, key: str, from_pos: int) -> str | None:
    """Decode a single JSON string property from the item payload slice starting at `from_pos`."""
    window_end = min(len(text), from_pos + 16000)
    snippet = text[from_pos:window_end]
    m = re.search(rf'"{re.escape(key)}"\s*:\s*("(?:\\.|[^"\\])*")', snippet)
    if not m:
        return None
    try:
        val = json.loads(m.group(1))
        return val if isinstance(val, str) else None
    except json.JSONDecodeError:
        return None


def _find_sssmc_item_object(stream_text: str) -> dict[str, Any]:
    """Locate and JSON-decode the main SSR item object containing `audioUrl`, `customMetaData`, and `lyrics`."""
    decoder = json.JSONDecoder()
    anchors = ['"customMetaData"', '"audioUrl"']
    for anchor in anchors:
        idx = 0
        while True:
            pos = stream_text.find(anchor, idx)
            if pos == -1:
                break
            search_from = pos
            for _ in range(120):
                brace_pos = stream_text.rfind("{", max(0, pos - 25000), search_from)
                if brace_pos == -1:
                    break
                try:
                    obj, _ = decoder.raw_decode(stream_text, brace_pos)
                    if isinstance(obj, dict) and isinstance(obj.get("customMetaData"), dict):
                        return obj
                except json.JSONDecodeError:
                    pass
                search_from = brace_pos
            idx = pos + len(anchor)

    # Targeted fallback: decode `customMetaData` + sibling fields strictly following it
    cm_pos = stream_text.find('"customMetaData"')
    if cm_pos != -1:
        colon_pos = stream_text.find("{", cm_pos)
        if colon_pos != -1:
            try:
                custom_meta, after_cm = decoder.raw_decode(stream_text, colon_pos)
                if isinstance(custom_meta, dict):
                    synthesized: dict[str, Any] = {"customMetaData": custom_meta}
                    for k in ("audioUrl", "content", "title", "slug", "id", "lyrics"):
                        val = _extract_json_string_field(stream_text, k, after_cm)
                        if val is not None:
                            synthesized[k] = val
                    return synthesized
            except json.JSONDecodeError:
                pass
    return {}


def _extract_object_id_and_slug(page_url: str, item_obj: Mapping[str, Any]) -> tuple[str, str]:
    parsed_url = urllib.parse.urlsplit(page_url.strip())
    path_slug = parsed_url.path.rstrip("/").rsplit("/", 1)[-1]
    slug = str(path_slug or item_obj.get("slug") or "").strip()
    m = re.search(r"-([a-f0-9]{24})$", slug, re.I)
    if m:
        return m.group(1).lower(), slug
    if slug:
        return hashlib.sha1(slug.encode("utf-8")).hexdigest()[:24], slug
    obj_id = str(item_obj.get("id") or "").strip()
    if re.fullmatch(r"[a-f0-9]{24}", obj_id, re.I):
        return obj_id.lower(), slug
    return hashlib.sha1(page_url.encode("utf-8")).hexdigest()[:24], slug


def _split_lyric_lines(raw_lyrics: str | None) -> list[str]:
    if not raw_lyrics:
        return []
    normalized = str(raw_lyrics).replace("\r\n", "\n").replace("\r", "\n")
    out: list[str] = []
    for line in normalized.split("\n"):
        cleaned = re.sub(r"\s+", " ", html_lib.unescape(line)).strip()
        if cleaned:
            out.append(cleaned)
    return out


def parse_sssmc_listen_html(html: str, page_url: str) -> dict[str, Any] | None:
    """Extract normalized bhajan metadata, Roman lyrics, and direct CDN MP3 URL from SSR HTML."""
    stream_text = _extract_rsc_stream_text(html) or html
    item_obj = _find_sssmc_item_object(stream_text)
    if not item_obj:
        # Fallback to plain HTML regex scan if chunk wasn't inside __next_f
        item_obj = _find_sssmc_item_object(html)

    raw_audio_url = str(item_obj.get("audioUrl") or "").strip()
    if not raw_audio_url:
        m_audio = re.search(
            r'https://content\.sssmediacentre\.org/audio/[^"\\<>]+\.(?:mp3|m4a)',
            stream_text,
            re.I,
        )
        if m_audio:
            raw_audio_url = m_audio.group(0)
    if not raw_audio_url:
        return None

    audio_url = encode_media_url(raw_audio_url)
    obj_id, slug = _extract_object_id_and_slug(page_url, item_obj)
    custom = item_obj.get("customMetaData")
    if not isinstance(custom, Mapping):
        custom = {}

    seo = item_obj.get("seo") if isinstance(item_obj.get("seo"), Mapping) else {}
    raw_title = (
        str(item_obj.get("content") or "").strip()
        or str(item_obj.get("title") or "").strip()
        or str((seo or {}).get("title") or "").strip()
    )
    title = clean_sssmc_title(raw_title)
    if not title:
        stem = re.sub(r"-[a-f0-9]{24}$", "", slug)
        title = re.sub(r"[-_]+", " ", stem).strip().title()

    deity = crawler.clean_text(str(custom.get("deity") or "")) or crawler.infer_deity(title)
    raga_name = crawler.clean_text(str(custom.get("raga") or ""))
    tala_raw = crawler.clean_text(str(custom.get("tala") or ""))
    beat_display = tala_raw.title() if tala_raw.lower().endswith("beat") else tala_raw
    tempo = crawler.clean_text(str(custom.get("tempo") or ""))
    gents_raw = crawler.clean_text(str(custom.get("sruthi_male") or ""))
    ladies_raw = crawler.clean_text(str(custom.get("sruthi_female") or ""))
    meaning = crawler.clean_text(str(custom.get("meaning") or "")) or None
    artiste = crawler.clean_text(str(custom.get("album_artiste") or "")) or "Bhajan Group"
    duration_sec = parse_duration_span(str(custom.get("DurationSpan") or ""))
    lyric_lines = _split_lyric_lines(item_obj.get("lyrics") if isinstance(item_obj.get("lyrics"), str) else "")

    clean_slug = re.sub(r"-[a-f0-9]{24}$", "", slug).strip("-")
    if not clean_slug:
        clean_slug = re.sub(r"[^a-z0-9-]+", "-", title.lower()).strip("-") or f"sssmc-{obj_id[:10]}"

    canonical_source_url = page_url.split("#", 1)[0].split("?", 1)[0].strip()

    return {
        "objectId": obj_id,
        "slug": slug,
        "cleanSlug": clean_slug,
        "title": title,
        "sourceUrl": canonical_source_url,
        "audioUrl": audio_url,
        "durationSec": duration_sec,
        "deity": deity,
        "ragaName": raga_name,
        "beat": beat_display,
        "tala": tala_raw,
        "tempo": tempo,
        "gentsPitchRaw": gents_raw or None,
        "ladiesPitchRaw": ladies_raw or None,
        "gentsPitch": parse_sssmc_pitch(gents_raw),
        "ladiesPitch": parse_sssmc_pitch(ladies_raw),
        "meaning": meaning,
        "albumArtiste": artiste,
        "fileName": crawler.clean_text(str(custom.get("file_name") or "")) or Path(urllib.parse.urlsplit(audio_url).path).name,
        "lyricLines": lyric_lines,
        "lyricsSets": (
            [{"language": "Roman", "script": "roman", "lines": lyric_lines}]
            if lyric_lines
            else []
        ),
    }


def fetch_html_polite(
    url: str,
    *,
    timeout: int = 20,
    max_retries: int = 3,
    sleep_fn=time.sleep,
) -> str:
    """Fetch an allowed SSS Media Centre HTML page with exponential backoff on 429/5xx."""
    if not is_url_allowed_by_robots(url):
        raise ValueError(f"Refusing URL disallowed by robots.txt policy: {url}")

    last_err: Exception | None = None
    for attempt in range(max_retries):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                charset = resp.headers.get_content_charset() or "utf-8"
                return resp.read().decode(charset, errors="replace")
        except urllib.error.HTTPError as err:
            last_err = err
            if err.code in (429, 500, 502, 503, 504) and attempt < max_retries - 1:
                sleep_fn(2.0 * (2**attempt))
                continue
            raise
        except Exception as err:
            last_err = err
            if attempt < max_retries - 1:
                sleep_fn(2.0 * (2**attempt))
                continue
            raise
    assert last_err is not None
    raise last_err


def verify_audio_url_head(
    audio_url: str,
    *,
    timeout: int = 12,
) -> tuple[bool, int | None, str]:
    """Run an HTTP HEAD check verifying direct audio availability and byte length."""
    req = urllib.request.Request(
        audio_url,
        method="HEAD",
        headers={"User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ctype = (resp.headers.get("Content-Type") or "").lower()
            clen_raw = resp.headers.get("Content-Length") or ""
            clen = int(clen_raw) if clen_raw.isdigit() else None
            is_audio = ("audio/" in ctype) or ("octet-stream" in ctype) or audio_url.lower().endswith(".mp3")
            return (resp.status == 200 and is_audio, clen, ctype)
    except Exception as err:
        return (False, None, str(err))


def _extract_roman_lines(doc: Mapping[str, Any]) -> list[str]:
    lsets = list(doc.get("lyricsSets") or [])
    roman: list[str] = []
    ascii_fallback: list[str] = []
    for lset in lsets:
        if not isinstance(lset, Mapping):
            continue
        lines = [str(ln).strip() for ln in (lset.get("lines") or []) if str(ln).strip()]
        if not lines:
            continue
        if str(lset.get("script") or "").lower() == "roman" or str(lset.get("language") or "").lower() == "roman":
            roman.extend(lines)
        elif not ascii_fallback and any(re.search(r"[a-zA-Z]{3,}", ln) for ln in lines[:2]):
            ascii_fallback.extend(lines)
    if roman:
        return roman
    if ascii_fallback:
        return ascii_fallback
    raw_lyrics = doc.get("lyrics")
    if isinstance(raw_lyrics, str) and raw_lyrics.strip():
        return [ln.strip() for ln in raw_lyrics.splitlines() if ln.strip()]
    return []


def _get_doc_duration_sec(doc: Mapping[str, Any]) -> int | None:
    recs = list(doc.get("recordings") or []) + list(doc.get("addedRecordings") or [])
    for rec in recs:
        if isinstance(rec, Mapping):
            d = rec.get("durationSec")
            if isinstance(d, (int, float)) and d > 0:
                return int(d)
    return None


def _is_instrumental_text(text: str) -> bool:
    return bool(INSTRUMENTAL_KEYWORDS_RE.search(text or ""))


def _core_content_tokens(phrase: str) -> list[str]:
    canon = phonetics.canonicalize_phrase(phrase)
    if not canon:
        return []
    tokens = canon.split()
    strong = [t for t in tokens if phonetics._get_idf_weight(t) >= 0.6]  # noqa: SLF001
    return strong if strong else tokens


def _is_prefix_subset_match(title_a: str, title_b: str) -> tuple[bool, int]:
    core_a = _core_content_tokens(title_a)
    core_b = _core_content_tokens(title_b)
    if not core_a or not core_b:
        return (False, 0)
    shorter, longer = (core_a, core_b) if len(core_a) <= len(core_b) else (core_b, core_a)
    matched = 0
    for ts in shorter:
        if any(phonetics.normalized_word_sim(ts, tl) >= 0.85 for tl in longer):
            matched += 1
    return (matched == len(shorter) and len(shorter) >= 2, matched)


def compute_sssmc_lyrics_similarity(
    lines_a: Sequence[str],
    lines_b: Sequence[str],
) -> float:
    """Line-break-invariant lyrics similarity combining line overlap with flat 4-gram + token Jaccard.

    SSSMC stores entire verses on single lines while Sai Rhythms / YouTube often split half-lines;
    blending flat 4-gram and canonical token Jaccard prevents false vetoes when lyrics match word-for-word.
    """
    sample_a = list(lines_a[:24])
    sample_b = list(lines_b[:24])
    line_sim = phonetics.compute_lyrics_overlap(sample_a, sample_b)

    canon_a = " ".join(
        phonetics.canonicalize_phrase(phonetics._REPETITION_RE.sub(" ", ln))  # noqa: SLF001
        for ln in sample_a
    ).strip()
    canon_b = " ".join(
        phonetics.canonicalize_phrase(phonetics._REPETITION_RE.sub(" ", ln))  # noqa: SLF001
        for ln in sample_b
    ).strip()
    if not canon_a or not canon_b:
        return line_sim

    flat_4g = phonetics._jaccard_similarity(  # noqa: SLF001
        phonetics._build_char_4grams(canon_a),  # noqa: SLF001
        phonetics._build_char_4grams(canon_b),  # noqa: SLF001
    )
    toks_a = set(canon_a.split())
    toks_b = set(canon_b.split())
    tok_jaccard = len(toks_a & toks_b) / max(1, len(toks_a | toks_b))
    flat_sim = 0.55 * flat_4g + 0.45 * tok_jaccard
    return max(line_sim, flat_sim)


def compute_body_lyrics_similarity(
    lines_a: Sequence[str],
    lines_b: Sequence[str],
    title_hint: str = "",
) -> float | None:
    """Compare distinctive non-title verse-body tokens so shared first lines cannot mask distinct songs.

    Returns `None` when either lyric set has fewer than 3 distinctive non-title tokens.
    """
    title_toks = set(phonetics.canonicalize_phrase(title_hint).split()) if title_hint else set()

    def _distinctive_tokens(lines: Sequence[str]) -> set[str]:
        tokens: set[str] = set()
        for ln in list(lines)[:24]:
            canon_ln = phonetics.canonicalize_phrase(phonetics._REPETITION_RE.sub(" ", ln))  # noqa: SLF001
            for tok in canon_ln.split():
                if not tok or tok in title_toks:
                    continue
                if phonetics._get_idf_weight(tok) >= 0.6:  # noqa: SLF001
                    tokens.add(tok)
        return tokens

    body_a = _distinctive_tokens(lines_a)
    body_b = _distinctive_tokens(lines_b)
    if len(body_a) < 3 or len(body_b) < 3:
        return None
    return len(body_a & body_b) / max(1, len(body_a | body_b))


def match_sssmc_to_catalog(
    parsed: Mapping[str, Any],
    catalog_docs: Sequence[Mapping[str, Any]],
    *,
    entity_aliases: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Fool-proof multi-pass matcher connecting SSSMC audio to Firestore bhajan docs.

    Passes:
      0. Already linked by `sssmc_<objectId>` or `externalUrl` / exact canonical or entity alias
      1. Lyrics-confirmed phonetic match (strongest cross-title safeguard)
      2. High-confidence sanitized title (+ optional YouTube duration proximity within ±15s)
      3. Review band (`>= 0.72`) vs clean new `sssmediacentre_verified` document
    """
    obj_id = str(parsed.get("objectId") or "").strip()
    rec_id = f"sssmc_{obj_id}"
    audio_url = str(parsed.get("audioUrl") or "").strip()

    # Fast idempotency check
    for doc in catalog_docs:
        doc_id = str(doc.get("id") or doc.get("slug") or "").strip()
        recs = list(doc.get("recordings") or []) + list(doc.get("addedRecordings") or [])
        if any(
            isinstance(r, Mapping) and (r.get("id") == rec_id or (audio_url and r.get("externalUrl") == audio_url))
            for r in recs
        ):
            return {
                "status": "matched",
                "targetId": doc_id,
                "targetTitle": str(doc.get("title") or ""),
                "score": 1.0,
                "method": "sssmc_already_linked",
                "candidates": [],
            }

    sssmc_title = clean_bhajan_title_for_match(str(parsed.get("title") or ""))
    sssmc_canon = phonetics.canonicalize_phrase(sssmc_title)
    sssmc_tokens = sssmc_canon.split()
    sssmc_lines = list(parsed.get("lyricLines") or [])
    sssmc_first_line = sssmc_lines[0] if sssmc_lines else ""
    sssmc_dur = parsed.get("durationSec")
    sssmc_instr = _is_instrumental_text(str(parsed.get("title") or ""))
    sssmc_title_4grams = phonetics._build_char_4grams(sssmc_canon)  # noqa: SLF001
    sssmc_lyrics_4grams = (
        phonetics._build_char_4grams(  # noqa: SLF001
            " ".join(phonetics.canonicalize_phrase(ln) for ln in sssmc_lines[:12])
        )
        if len(sssmc_lines) >= 2
        else set()
    )

    alias_target_id = entity_aliases.get(sssmc_canon) if (sssmc_canon and entity_aliases) else None

    evaluated: list[dict[str, Any]] = []
    confused_candidates: list[dict[str, Any]] = []
    for doc in catalog_docs:
        doc_id = str(doc.get("id") or doc.get("slug") or "").strip()
        if not doc_id:
            continue

        blocked = {str(x).strip() for x in (doc.get("doNotMergeWith") or []) if str(x).strip()}
        if obj_id in blocked or str(parsed.get("slug") or "") in blocked or sssmc_canon in blocked:
            continue

        raw_cand_title = str(doc.get("title") or "").strip()
        cand_title = clean_bhajan_title_for_match(raw_cand_title)
        if not cand_title:
            continue

        # Veto instrumental vs vocal mismatch
        if sssmc_instr != _is_instrumental_text(raw_cand_title):
            continue

        cand_canon = phonetics.canonicalize_phrase(cand_title)
        cand_lines = _extract_roman_lines(doc)

        # Ultra-fast O(1) candidate gate so DP similarity only runs on plausible matches (<10ms across 1,800 docs)
        cand_title_4grams = phonetics._build_char_4grams(cand_canon)  # noqa: SLF001
        fast_title_4gram = phonetics._jaccard_similarity(sssmc_title_4grams, cand_title_4grams)  # noqa: SLF001
        fast_lyrics_4gram = (
            phonetics._jaccard_similarity(  # noqa: SLF001
                sssmc_lyrics_4grams,
                phonetics._build_char_4grams(  # noqa: SLF001
                    " ".join(phonetics.canonicalize_phrase(ln) for ln in cand_lines[:12])
                ),
            )
            if (sssmc_lyrics_4grams and len(cand_lines) >= 2)
            else 0.0
        )
        is_exact_canon = bool(
            (sssmc_canon and cand_canon and sssmc_canon == cand_canon)
            or (alias_target_id and doc_id == alias_target_id)
            or any(
                phonetics.canonicalize_phrase(str(a).replace("-", " ")) == sssmc_canon
                for a in (doc.get("slugAliases") or [])
                if sssmc_canon
            )
        )
        if not is_exact_canon and fast_title_4gram < 0.14 and fast_lyrics_4gram < 0.15:
            continue

        title_sim = phonetics.compute_title_similarity(sssmc_title, cand_title)
        first_line_sim = (
            phonetics.compute_title_similarity(sssmc_first_line, cand_title)
            if sssmc_first_line
            else 0.0
        )
        best_title_sim = max(title_sim, first_line_sim)

        lyrics_sim: float | None = None
        body_sim: float | None = None
        if len(sssmc_lines) >= 2 and len(cand_lines) >= 2:
            lyrics_sim = compute_sssmc_lyrics_similarity(sssmc_lines, cand_lines)
            body_sim = compute_body_lyrics_similarity(sssmc_lines, cand_lines, sssmc_title)
            # Stringent full-lyrics + verse-body veto prevents merging distinct bhajans sharing a 1st line
            if lyrics_sim < 0.45 or (body_sim is not None and body_sim < 0.30):
                if best_title_sim >= 0.85:
                    body_note = f", body={body_sim:.2f}" if body_sim is not None else ""
                    confused_candidates.append(
                        {
                            "targetBhajanId": doc_id,
                            "targetTitle": raw_cand_title,
                            "score": round(float(best_title_sim * 0.8), 4),
                            "reason": f"lyrics_conflict (title={best_title_sim:.2f}, lyrics={lyrics_sim:.2f}{body_note})",
                        }
                    )
                continue

        is_prefix, matched_core_count = _is_prefix_subset_match(sssmc_title, cand_title)

        cand_dur = _get_doc_duration_sec(doc)
        dur_match = bool(
            isinstance(sssmc_dur, int)
            and isinstance(cand_dur, int)
            and sssmc_dur > 0
            and cand_dur > 0
            and abs(sssmc_dur - cand_dur) <= 15
        )

        eligible_auto = False
        method = "title_similarity"
        rank_score = best_title_sim

        if is_exact_canon and (len(sssmc_tokens) >= 2 or len(cand_canon.split()) == 1):
            eligible_auto = True
            method = "sssmc_exact_canonical"
            rank_score = 1.0 if lyrics_sim is None else round(0.95 + 0.05 * lyrics_sim, 4)
        elif lyrics_sim is not None and (
            (lyrics_sim >= 0.58 and (body_sim is None or body_sim >= 0.35) and (best_title_sim >= 0.65 or is_prefix))
            or (lyrics_sim >= 0.58 and (body_sim is None or body_sim >= 0.45) and best_title_sim >= 0.80)
        ):
            eligible_auto = True
            method = "sssmc_lyrics_confirmed"
            prefix_floor = 0.85 if is_prefix else 0.0
            rank_score = round(0.55 * lyrics_sim + 0.45 * max(best_title_sim, prefix_floor), 4)
        elif matched_core_count >= 2 or (len(sssmc_tokens) == 1 and len(cand_canon.split()) == 1):
            if best_title_sim >= 0.90:
                eligible_auto = True
                method = "sssmc_title_phonetic"
                rank_score = round(min(0.98, best_title_sim + (0.02 if dur_match else 0.0)), 4)
            elif dur_match and (best_title_sim >= 0.85 or (is_prefix and matched_core_count >= 3)):
                eligible_auto = True
                method = "sssmc_title_duration"
                rank_score = round(max(best_title_sim, 0.89), 4)

        if not eligible_auto and lyrics_sim is not None and lyrics_sim >= 0.50:
            rank_score = max(rank_score, round(0.55 * lyrics_sim + 0.45 * best_title_sim, 4))

        evaluated.append(
            {
                "targetBhajanId": doc_id,
                "targetTitle": raw_cand_title,
                "score": round(float(rank_score), 4),
                "titleSim": round(float(best_title_sim), 4),
                "lyricsOverlap": round(float(lyrics_sim), 4) if lyrics_sim is not None else None,
                "bodyLyricsSim": round(float(body_sim), 4) if body_sim is not None else None,
                "durationMatch": dur_match,
                "eligibleAuto": eligible_auto,
                "isExactCanon": is_exact_canon,
                "reason": method,
            }
        )

    evaluated.sort(key=lambda item: (-float(item["score"]), item["targetBhajanId"]))
    confused_candidates.sort(key=lambda item: (-float(item["score"]), item["targetBhajanId"]))

    if not evaluated:
        if confused_candidates:
            return {
                "status": "needs_verification",
                "targetId": confused_candidates[0]["targetBhajanId"],
                "targetTitle": confused_candidates[0]["targetTitle"],
                "score": confused_candidates[0]["score"],
                "method": "sssmc_lyrics_conflict_review",
                "candidates": confused_candidates[:3],
            }
        return {
            "status": "new_bhajan",
            "targetId": None,
            "targetTitle": None,
            "score": 0.0,
            "method": "sssmc_unmatched",
            "candidates": [],
        }

    top = evaluated[0]

    def _cand_summary(c: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "targetBhajanId": c["targetBhajanId"],
            "targetTitle": c["targetTitle"],
            "score": c["score"],
            "reason": c["reason"],
        }

    top_candidates_clean = [
        _cand_summary(c)
        for c in evaluated[:3]
        if float(c["score"]) >= 0.65
    ]

    if top["eligibleAuto"]:
        close = [c for c in evaluated[1:] if float(top["score"]) - float(c["score"]) < 0.06]
        if not close:
            return {
                "status": "matched",
                "targetId": top["targetBhajanId"],
                "targetTitle": top["targetTitle"],
                "score": top["score"],
                "method": top["reason"],
                "candidates": top_candidates_clean,
            }

        def _is_strictly_lyrics_verified(c: Mapping[str, Any]) -> bool:
            lo = c.get("lyricsOverlap")
            bs = c.get("bodyLyricsSim")
            return lo is not None and float(lo) >= 0.65 and (bs is None or float(bs) >= 0.40)

        if _is_strictly_lyrics_verified(top):
            verified_close = [c for c in close if _is_strictly_lyrics_verified(c)]
            return {
                "status": "matched",
                "targetId": top["targetBhajanId"],
                "targetTitle": top["targetTitle"],
                "additionalTargetIds": [c["targetBhajanId"] for c in verified_close],
                "score": top["score"],
                "method": top["reason"],
                "candidates": top_candidates_clean,
            }

        return {
            "status": "needs_verification",
            "targetId": top["targetBhajanId"],
            "targetTitle": top["targetTitle"],
            "score": top["score"],
            "method": "sssmc_ambiguous_candidate",
            "candidates": top_candidates_clean,
        }

    if float(top["score"]) >= 0.72 or confused_candidates:
        merged_review = top_candidates_clean + [
            c
            for c in confused_candidates
            if c["targetBhajanId"] not in {tc["targetBhajanId"] for tc in top_candidates_clean}
        ]
        return {
            "status": "needs_verification",
            "targetId": top["targetBhajanId"],
            "targetTitle": top["targetTitle"],
            "score": top["score"],
            "method": (
                "sssmc_lyrics_conflict_review"
                if confused_candidates and float(top["score"]) < 0.72
                else "sssmc_review_band"
            ),
            "candidates": merged_review[:3],
        }

    return {
        "status": "new_bhajan",
        "targetId": None,
        "targetTitle": None,
        "score": float(top["score"]),
        "method": "sssmc_unmatched",
        "candidates": [],
    }


def build_sssmc_recording(
    parsed: Mapping[str, Any],
    *,
    match_score: float = 1.0,
    match_method: str = "sssmc_verified",
    file_size_bytes: int | None = None,
    verified_at: str | None = None,
) -> dict[str, Any]:
    obj_id = str(parsed["objectId"])
    artiste = str(parsed.get("albumArtiste") or "Bhajan Group").strip()
    rec: dict[str, Any] = {
        "id": f"sssmc_{obj_id}",
        "label": f"SSS Media Centre — A Bhajan A Day ({artiste})",
        "collection": "sssmediacentre_bhajan_a_day",
        "externalUrl": str(parsed["audioUrl"]),
        "matchScore": round(float(match_score), 4),
        "matchMethod": match_method,
        "lastVerifiedAt": verified_at or utc_now_iso(),
    }
    if isinstance(parsed.get("durationSec"), int) and parsed["durationSec"] > 0:
        rec["durationSec"] = int(parsed["durationSec"])
    if isinstance(file_size_bytes, int) and file_size_bytes > 0:
        rec["fileSizeBytes"] = int(file_size_bytes)
    return rec


def _upsert_recording(
    existing_recs: Sequence[Mapping[str, Any]],
    new_rec: Mapping[str, Any],
) -> list[dict[str, Any]]:
    rec_id = str(new_rec.get("id") or "")
    ext_url = str(new_rec.get("externalUrl") or "")
    cleaned = [
        dict(r)
        for r in existing_recs
        if isinstance(r, Mapping) and r.get("id") != rec_id and r.get("externalUrl") != ext_url
    ]
    return [dict(new_rec), *cleaned]


def _is_placeholder_raga(doc: Mapping[str, Any]) -> bool:
    raga = doc.get("raga")
    name = str(raga.get("name") if isinstance(raga, Mapping) else raga or "").strip().lower()
    return name in ("", "unspecified", "pending sai rhythms sync", "unknown", "traditional", "n/a")


def build_sssmc_merge_patch(
    existing_doc: Mapping[str, Any],
    parsed: Mapping[str, Any],
    match_info: Mapping[str, Any],
    *,
    file_size_bytes: int | None = None,
    now_iso: str | None = None,
) -> dict[str, Any]:
    """Compute an idempotent Firestore update payload respecting `bhajamiOverride` & Sai Rhythms precedence."""
    ts = now_iso or utc_now_iso()
    recording = build_sssmc_recording(
        parsed,
        match_score=float(match_info.get("score") or 1.0),
        match_method=str(match_info.get("method") or "sssmc_matched"),
        file_size_bytes=file_size_bytes,
        verified_at=ts,
    )
    updated_recordings = _upsert_recording(existing_doc.get("recordings") or [], recording)

    if bool(existing_doc.get("bhajamiOverride")):
        return {
            "recordings": updated_recordings,
            "updatedAt": ts,
        }

    merged = dict(existing_doc)
    patch: dict[str, Any] = {
        "recordings": updated_recordings,
        "updatedAt": ts,
    }
    is_sairhythms = existing_doc.get("metadataSource") == "sairhythms_verified"

    # Fill missing scalar metadata (Sai Rhythms retains its curated values; YouTube stubs get enriched)
    if not str(existing_doc.get("deity") or "").strip() and parsed.get("deity"):
        patch["deity"] = parsed["deity"]

    if parsed.get("ragaName") and _is_placeholder_raga(existing_doc):
        patch["raga"] = {"name": parsed["ragaName"]}

    cur_beat = str(existing_doc.get("beat") or "").strip()
    if parsed.get("beat") and (not cur_beat or "(est.)" in cur_beat.lower()):
        patch["beat"] = parsed["beat"]

    if parsed.get("tala") and not str(existing_doc.get("tala") or "").strip():
        patch["tala"] = parsed["tala"]

    if parsed.get("tempo") and not str(existing_doc.get("tempo") or "").strip():
        patch["tempo"] = parsed["tempo"]

    if parsed.get("gentsPitch") and (
        not existing_doc.get("gentsPitch") or (bool(existing_doc.get("isEstimated")) and not is_sairhythms)
    ):
        patch["gentsPitch"] = parsed["gentsPitch"]
        if parsed.get("gentsPitchRaw"):
            patch["gentsPitchRaw"] = parsed["gentsPitchRaw"]

    if parsed.get("ladiesPitch") and (
        not existing_doc.get("ladiesPitch") or (bool(existing_doc.get("isEstimated")) and not is_sairhythms)
    ):
        patch["ladiesPitch"] = parsed["ladiesPitch"]
        if parsed.get("ladiesPitchRaw"):
            patch["ladiesPitchRaw"] = parsed["ladiesPitchRaw"]

    if parsed.get("meaning") and not str(existing_doc.get("meaning") or "").strip():
        patch["meaning"] = parsed["meaning"]

    existing_lsets = list(existing_doc.get("lyricsSets") or [])
    has_non_empty_lyrics = any(
        isinstance(s, Mapping) and len([ln for ln in (s.get("lines") or []) if str(ln).strip()]) > 0
        for s in existing_lsets
    )
    if parsed.get("lyricsSets") and not has_non_empty_lyrics:
        patch["lyricsSets"] = parsed["lyricsSets"]
        patch["lyricsMissing"] = False

    if parsed.get("sourceUrl") and not str(existing_doc.get("sourceUrl") or "").strip():
        patch["sourceUrl"] = parsed["sourceUrl"]

    merged.update(patch)
    patch["missingFields"] = crawler.compute_missing_bhajan_fields(merged)
    return patch


def build_new_sssmc_bhajan_doc(
    parsed: Mapping[str, Any],
    *,
    existing_ids: set[str],
    match_status: str = "verified",
    match_candidates: Sequence[Mapping[str, Any]] = (),
    file_size_bytes: int | None = None,
    now_iso: str | None = None,
) -> dict[str, Any]:
    """Build a complete new Firestore `bhajans/{id}` document from an SSSMC Bhajan A Day entry."""
    ts = now_iso or utc_now_iso()
    obj_id = str(parsed["objectId"])
    base_slug = str(parsed.get("cleanSlug") or f"sssmc-{obj_id[:10]}").strip("-")
    doc_id = base_slug if base_slug not in existing_ids else f"{base_slug}-{obj_id[:6]}"
    existing_ids.add(doc_id)

    rec = build_sssmc_recording(
        parsed,
        match_score=1.0 if match_status == "verified" else 0.72,
        match_method="sssmc_new_bhajan",
        file_size_bytes=file_size_bytes,
        verified_at=ts,
    )

    doc: dict[str, Any] = {
        "id": doc_id,
        "slug": doc_id,
        "title": str(parsed["title"]),
        "deity": str(parsed.get("deity") or "Sai"),
        "language": "",
        "raga": {"name": str(parsed.get("ragaName") or "")} if parsed.get("ragaName") else None,
        "beat": str(parsed.get("beat") or ""),
        "tala": str(parsed.get("tala") or ""),
        "tempo": str(parsed.get("tempo") or ""),
        "gentsPitch": parsed.get("gentsPitch"),
        "ladiesPitch": parsed.get("ladiesPitch"),
        "gentsPitchRaw": parsed.get("gentsPitchRaw"),
        "ladiesPitchRaw": parsed.get("ladiesPitchRaw"),
        "meaning": parsed.get("meaning"),
        "lyricsSets": list(parsed.get("lyricsSets") or []),
        "glossary": [],
        "recordings": [rec],
        "sourceUrl": str(parsed.get("sourceUrl") or ""),
        "metadataSource": "sssmediacentre_verified",
        "lyricsMissing": len(parsed.get("lyricsSets") or []) == 0,
        "matchStatus": match_status,
        "matchCandidates": list(match_candidates)[:3],
        "slugAliases": [str(parsed["slug"])] if parsed.get("slug") else [],
        "createdAt": ts,
        "updatedAt": ts,
    }
    doc["missingFields"] = crawler.compute_missing_bhajan_fields(doc)
    return doc


def _init_sssmc_state_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sssmc_urls (
            url TEXT PRIMARY KEY,
            slug TEXT NOT NULL,
            object_id TEXT NOT NULL,
            status TEXT NOT NULL,
            matched_bhajan_id TEXT,
            match_method TEXT,
            audio_url TEXT,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.commit()


def _load_processed_urls(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT url FROM sssmc_urls WHERE status IN ('matched', 'new_bhajan', 'needs_verification')").fetchall()
    return {str(r[0]) for r in rows}


def _record_url_state(
    conn: sqlite3.Connection,
    *,
    url: str,
    slug: str,
    object_id: str,
    status: str,
    matched_bhajan_id: str | None,
    match_method: str | None,
    audio_url: str | None,
) -> None:
    conn.execute(
        """
        INSERT INTO sssmc_urls (url, slug, object_id, status, matched_bhajan_id, match_method, audio_url, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
            slug=excluded.slug,
            object_id=excluded.object_id,
            status=excluded.status,
            matched_bhajan_id=excluded.matched_bhajan_id,
            match_method=excluded.match_method,
            audio_url=excluded.audio_url,
            updated_at=excluded.updated_at
        """,
        (url, slug, object_id, status, matched_bhajan_id, match_method, audio_url, utc_now_iso()),
    )
    conn.commit()


def _from_firestore_rest_val(val: Any) -> Any:
    if not isinstance(val, Mapping):
        return val
    if "nullValue" in val:
        return None
    if "booleanValue" in val:
        return bool(val["booleanValue"])
    if "integerValue" in val:
        return int(val["integerValue"])
    if "doubleValue" in val:
        return float(val["doubleValue"])
    if "stringValue" in val:
        return str(val["stringValue"])
    if "timestampValue" in val:
        return str(val["timestampValue"])
    if "arrayValue" in val:
        return [_from_firestore_rest_val(v) for v in (val["arrayValue"].get("values") or [])]
    if "mapValue" in val:
        return {
            k: _from_firestore_rest_val(v)
            for k, v in (val["mapValue"].get("fields") or {}).items()
        }
    return None


def load_catalog_docs(
    source: str,
    *,
    project_id: str = DEFAULT_FIRESTORE_PROJECT_ID,
    local_json_path: Path = SHARED_DATA_DIR / "catalog.json",
) -> tuple[list[dict[str, Any]], dict[str, str], Any]:
    """Load catalog bhajans + entityAliases from Firestore Admin, public Firestore REST, or local JSON."""
    if source == "firestore":
        fs_client = yt_sync._init_firestore_client()
        docs: list[dict[str, Any]] = []
        for snap in fs_client.collection("bhajans").stream():
            if not snap.exists:
                continue
            d = dict(snap.to_dict() or {})
            d.setdefault("id", snap.id)
            d.setdefault("slug", snap.id)
            if not str(d.get("id") or "").strip():
                d["id"] = snap.id
            docs.append(d)
        aliases: dict[str, str] = {}
        for snap in fs_client.collection("entityAliases").stream():
            ad = snap.to_dict() or {}
            canon = str(ad.get("canonicalPhrase") or "").strip()
            target_id = str(ad.get("targetBhajanId") or "").strip()
            if canon and target_id:
                aliases[canon] = target_id
        return docs, aliases, fs_client

    if source == "firestore-rest":
        base = f"https://firestore.googleapis.com/v1/projects/{project_id}/databases/(default)/documents"
        docs = []
        page_token = ""
        while True:
            q = f"{base}/bhajans?pageSize=300" + (f"&pageToken={urllib.parse.quote(page_token)}" if page_token else "")
            req = urllib.request.Request(q, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=20) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            for raw_doc in payload.get("documents") or []:
                doc_id = str(raw_doc.get("name") or "").rsplit("/", 1)[-1]
                decoded = {k: _from_firestore_rest_val(v) for k, v in (raw_doc.get("fields") or {}).items()}
                if not str(decoded.get("id") or "").strip():
                    decoded["id"] = doc_id
                if not str(decoded.get("slug") or "").strip():
                    decoded["slug"] = doc_id
                docs.append(decoded)
            page_token = str(payload.get("nextPageToken") or "")
            if not page_token:
                break
        return docs, {}, None

    raw = json.loads(local_json_path.read_text(encoding="utf-8"))
    return list(raw.get("bhajans") or []), {}, None


def collect_input_urls(urls: Sequence[str], urls_file: Path | None) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()

    def _add(raw_line: str) -> None:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            return
        clean = line.split("#", 1)[0].strip()
        if clean and clean not in seen:
            seen.add(clean)
            ordered.append(clean)

    for u in urls:
        _add(u)
    if urls_file is not None and urls_file.exists():
        for line in urls_file.read_text(encoding="utf-8").splitlines():
            _add(line)
    return ordered


def run_sync(
    *,
    urls: Sequence[str],
    catalog_source: str = "firestore",
    state_db_path: Path = DEFAULT_STATE_DB,
    delay_sec: float = 1.5,
    max_items_per_run: int = 200,
    max_firestore_writes: int = DEFAULT_MAX_FIRESTORE_WRITES,
    publish_firestore: bool = False,
    dry_run: bool = False,
    skip_head_check: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    effective_delay = max(1.0, float(delay_sec))
    docs, entity_aliases, fs_client = load_catalog_docs(catalog_source)
    docs_by_id = {str(d.get("id") or d.get("slug")): d for d in docs if str(d.get("id") or d.get("slug"))}
    existing_ids = set(docs_by_id.keys())

    conn: sqlite3.Connection | None = None
    processed: set[str] = set()
    if not dry_run:
        state_db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(state_db_path)
        _init_sssmc_state_table(conn)
        if not force:
            processed = _load_processed_urls(conn)

    pending_urls = [u for u in urls if u not in processed][:max_items_per_run]
    stats = {
        "scanned": 0,
        "matched": 0,
        "alreadyLinked": 0,
        "needsVerification": 0,
        "newBhajan": 0,
        "errors": 0,
        "firestoreWrites": 0,
        "results": [],
    }

    started_at = utc_now_iso()
    batch = fs_client.batch() if (publish_firestore and not dry_run and fs_client is not None) else None
    batch_ops = 0

    def _flush_batch() -> None:
        nonlocal batch, batch_ops
        if batch is not None and batch_ops > 0:
            batch.commit()
            stats["firestoreWrites"] += batch_ops
            batch = fs_client.batch()
            batch_ops = 0

    try:
        for idx, page_url in enumerate(pending_urls):
            if idx > 0:
                time.sleep(effective_delay)

            if not is_url_allowed_by_robots(page_url):
                print(f"[SKIP robots] {page_url}", file=sys.stderr)
                stats["errors"] += 1
                continue

            try:
                html = fetch_html_polite(page_url)
                parsed = parse_sssmc_listen_html(html, page_url)
                if not parsed:
                    print(f"[PARSE ERROR] No audioUrl/metadata found at {page_url}", file=sys.stderr)
                    stats["errors"] += 1
                    continue
            except Exception as err:
                print(f"[FETCH ERROR] {page_url}: {err}", file=sys.stderr)
                stats["errors"] += 1
                continue

            stats["scanned"] += 1
            file_size: int | None = None
            head_status = "skipped"
            if not skip_head_check:
                ok, clen, ctype = verify_audio_url_head(parsed["audioUrl"])
                file_size = clen
                head_status = f"200 ({ctype})" if ok else f"FAIL ({ctype})"
                if not ok:
                    print(f"[WARN audio HEAD] {parsed['audioUrl']} -> {ctype}", file=sys.stderr)

            match_info = match_sssmc_to_catalog(parsed, docs, entity_aliases=entity_aliases)
            status = match_info["status"]
            method = str(match_info.get("method") or "")
            target_id = match_info.get("targetId")

            if status == "matched" and target_id and target_id in docs_by_id:
                target_ids_to_patch = [target_id]
                for extra_id in match_info.get("additionalTargetIds") or []:
                    if extra_id and extra_id in docs_by_id and extra_id not in target_ids_to_patch:
                        target_ids_to_patch.append(extra_id)

                for tid in target_ids_to_patch:
                    existing = docs_by_id[tid]
                    patch = build_sssmc_merge_patch(existing, parsed, match_info, file_size_bytes=file_size)
                    existing.update(patch)
                    if batch is not None and stats["firestoreWrites"] + batch_ops < max_firestore_writes:
                        batch.set(fs_client.collection("bhajans").document(tid), patch, merge=True)
                        batch_ops += 1

                if method == "sssmc_already_linked":
                    stats["alreadyLinked"] += 1
                else:
                    stats["matched"] += 1
            else:
                if status == "needs_verification":
                    stats["needsVerification"] += 1
                else:
                    stats["newBhajan"] += 1
                new_doc = build_new_sssmc_bhajan_doc(
                    parsed,
                    existing_ids=existing_ids,
                    match_status="needs_verification" if status == "needs_verification" else "verified",
                    match_candidates=match_info.get("candidates") or (),
                    file_size_bytes=file_size,
                )
                docs_by_id[new_doc["id"]] = new_doc
                docs.append(new_doc)
                target_id = new_doc["id"]

                if batch is not None and stats["firestoreWrites"] + batch_ops < max_firestore_writes:
                    batch.set(fs_client.collection("bhajans").document(new_doc["id"]), new_doc)
                    batch_ops += 1

            if batch is not None and batch_ops >= 350:
                _flush_batch()

            if conn is not None:
                _record_url_state(
                    conn,
                    url=page_url,
                    slug=str(parsed.get("slug") or ""),
                    object_id=str(parsed.get("objectId") or ""),
                    status=status,
                    matched_bhajan_id=str(target_id or ""),
                    match_method=method,
                    audio_url=str(parsed.get("audioUrl") or ""),
                )

            summary = {
                "url": page_url,
                "title": parsed["title"],
                "audioUrl": parsed["audioUrl"],
                "headCheck": head_status,
                "fileSizeBytes": file_size,
                "durationSec": parsed.get("durationSec"),
                "raga": parsed.get("ragaName"),
                "beat": parsed.get("beat"),
                "gentsPitch": parsed.get("gentsPitch"),
                "ladiesPitch": parsed.get("ladiesPitch"),
                "lyricLinesCount": len(parsed.get("lyricLines") or []),
                "matchResult": match_info,
            }
            stats["results"].append(summary)

        _flush_batch()
        if publish_firestore and not dry_run and fs_client is not None:
            finished_at = utc_now_iso()
            run_id = f"sssmc_{started_at.replace(':', '').replace('-', '')}"
            fs_client.collection("ingestionRuns").document(run_id).set(
                {
                    "runId": run_id,
                    "source": "sssmediacentre_bhajan_a_day",
                    "startedAt": started_at,
                    "finishedAt": finished_at,
                    "status": "partial" if stats["errors"] > 0 else "success",
                    "itemsScanned": stats["scanned"],
                    "matchedAuto": stats["matched"],
                    "queuedDoubt": stats["needsVerification"],
                    "createdNew": stats["newBhajan"],
                    "skippedDuplicate": stats["alreadyLinked"],
                    "parseErrors": stats["errors"],
                    "youtubeQuotaUnitsUsed": 0,
                    "firestoreWrites": stats["firestoreWrites"] + 1,
                }
            )
            stats["firestoreWrites"] += 1
    finally:
        if conn is not None:
            conn.close()

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="SSS Media Centre Bhajan A Day MP3 enrichment sync")
    parser.add_argument("--url", action="append", default=[], help="Specific /listen/<slug> URL to process (repeatable)")
    parser.add_argument("--urls-file", type=Path, default=None, help="Newline-separated list of /listen/<slug> URLs")
    parser.add_argument(
        "--catalog-source",
        choices=("firestore", "firestore-rest", "local"),
        default="firestore",
        help="Where to read existing catalog docs for matching",
    )
    parser.add_argument("--state-db", type=Path, default=DEFAULT_STATE_DB)
    parser.add_argument("--delay", type=float, default=1.5, help="Seconds between page fetches (>= 1.0s Crawl-delay)")
    parser.add_argument("--max-items-per-run", type=int, default=200)
    parser.add_argument("--max-firestore-writes", type=int, default=DEFAULT_MAX_FIRESTORE_WRITES)
    parser.add_argument("--publish-firestore", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="Do not write SQLite or Firestore; print parsed + matched JSON")
    parser.add_argument("--skip-head-check", action="store_true")
    parser.add_argument("--force", action="store_true", help="Re-process URLs even if checkpointed")
    parser.add_argument("--print-browser-snippet", action="store_true", help="Print DevTools snippet to export Bhajan A Day URLs")
    args = parser.parse_args()

    if args.print_browser_snippet:
        print(BROWSER_EXPORT_SNIPPET)
        return

    urls = collect_input_urls(args.url, args.urls_file)
    if not urls:
        print("No input URLs provided (--url or --urls-file). Run with --print-browser-snippet to export the Bhajan A Day list.")
        return

    catalog_source = args.catalog_source
    if args.dry_run and catalog_source == "firestore" and not (
        os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    ):
        catalog_source = "firestore-rest"

    res = run_sync(
        urls=urls,
        catalog_source=catalog_source,
        state_db_path=args.state_db,
        delay_sec=args.delay,
        max_items_per_run=args.max_items_per_run,
        max_firestore_writes=args.max_firestore_writes,
        publish_firestore=args.publish_firestore and not args.dry_run,
        dry_run=args.dry_run,
        skip_head_check=args.skip_head_check,
        force=args.force,
    )
    print(json.dumps(res, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
