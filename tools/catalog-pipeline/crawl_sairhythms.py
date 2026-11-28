#!/usr/bin/env python3
"""Resumable 28-language Sai Rhythms crawler with SQLite checkpoints & safe (var) seeding.

Respects Sai Rhythms robots.txt (`Crawl-delay: 10`) with a hard floor of `10.2s`
between network requests, stores raw HTML gzipped in `.cache/`, preserves human-curated
`bhajamiOverride: True` fields when merging with Firestore docs, bounds Firestore writes
per run (`--max-firestore-writes 4000`), and emits conservative glossary variant seeds.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import html as html_lib
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from bs4 import BeautifulSoup, FeatureNotFound

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
SHARED_DATA_DIR = REPO_ROOT / "packages" / "shared" / "data"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import phonetics  # noqa: E402

BASE_URL = "https://sairhythms.sathyasai.org"
SITEMAP_URL = f"{BASE_URL}/sitemap.xml"
USER_AGENT = "bhaJami-CatalogCrawler/1.0 (+https://github.com/eezyal/bhajami)"
MIN_CRAWL_DELAY_SEC = 10.2
DEFAULT_MAX_FIRESTORE_WRITES = 4000
DEFAULT_BATCH_SIZE = 200
DEFAULT_CACHE_DIR = SCRIPT_DIR / ".cache"
DEFAULT_STATE_DB = SCRIPT_DIR / "crawl_state.sqlite3"
DEFAULT_AUDIT_LOG = SCRIPT_DIR / "crawl_audit.jsonl"
DEFAULT_SEEDS_OUT = SHARED_DATA_DIR / "glossary-variant-seeds.json"

NON_SONG_SLUGS = frozenset(
    {
        "glossary",
        "signup",
        "slides",
        "submit-new-song",
        "tags",
        "sheet_music",
        "api",
        "deity",
        "level",
        "tempo",
        "language",
        "raga",
        "beat",
    }
)

DEFAULT_DISCOVERY_SOURCES: tuple[str, ...] = (
    "/song/tags/sheet-music",
    "/song/deity/sai",
    "/song/deity/ganesha",
    "/song/deity/krishna",
    "/song/deity/shiva",
    "/song/deity/devi",
    "/song/deity/rama",
    "/song/deity/guru",
    "/song/deity/anjaneya",
    "/song/deity/narayana",
    "/song/deity/sarva-dharma",
    "/song/deity/subrahmanya",
    "/song/deity/vittala",
    "/song/deity/gayathri",
    "/song/deity/ayyappa",
    "/song/deity/narasimha",
    "/song/deity/surya",
    "/song/deity/allah",
    "/song/deity/buddha",
    "/song/deity/jesus",
    "/song/deity/jehovah",
    "/song/level/simple",
    "/song/level/intermediate",
    "/song/level/advanced",
    "/song/tempo/medium",
    "/song/tempo/medium-fast",
    "/song/tempo/fast",
    "/song/tempo/medium-slow",
    "/song/tempo/slow",
    "/song/tags/prayers",
)

CHROMATIC_STEPS: list[tuple[int, str, str]] = [
    (0, "1 Pancham", "C"),
    (1, "1.5 Pancham", "C# / Db"),
    (2, "2 Pancham", "D"),
    (3, "2.5 Pancham", "D# / Eb"),
    (4, "3 Pancham", "E"),
    (5, "4 Pancham", "F"),
    (6, "4.5 Pancham", "F# / Gb"),
    (7, "5 Pancham", "G"),
    (8, "5.5 Pancham", "G# / Ab"),
    (9, "6 Pancham", "A"),
    (10, "6.5 Pancham", "A# / Bb"),
    (11, "7 Pancham", "B"),
]

DEITY_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("Ganesha", ("ganesha", "gajanana", "vinayaka", "ganapathi", "ganapathe", "vighna", "lambodara")),
    ("Guru", ("guru", "datta", "dattatreya", "sadguru")),
    ("Devi", ("devi", "amba", "bhavani", "durga", "lakshmi", "saraswathi", "saraswati", "matha", "janani", "eshwaramba")),
    ("Shiva", ("shiva", "shankara", "shambho", "shamboo", "mahadeva", "nataraja", "mahesha", "gangadhara", "arunachala", "linga")),
    ("Rama", ("rama", "raghu", "sita", "janaki", "ayodhya", "kausalya", "dasharatha", "kodanda", "raghava")),
    ("Hanuman", ("hanuman", "anjaneya", "maruti", "ramadootha", "rama dootha")),
    ("Krishna", ("krishna", "govinda", "gopala", "gopal", "madhava", "mukunda", "muralidhara", "nandalala", "radha", "radhey", "vitthala", "vittala", "panduranga", "narayana", "hari", "keshava", "giridhari", "shyam", "shyama")),
    ("Sarva Dharma", ("allah", "maula", "jesus", "christ", "buddha", "sarva dharma", "zoroaster", "nanak")),
    ("Sai", ("sai", "parthi", "prasanthi", "prashanthi", "shirdi", "bhagawan", "baba", "sathya")),
]

MISSING_FIELD_ORDER: tuple[str, ...] = (
    "lyrics",
    "meaning",
    "gentsPitch",
    "ladiesPitch",
    "raga",
    "beat",
    "tempo",
    "notation",
    "alternateScripts",
)

GENDER_OR_MORPH_TAGS = re.compile(r"\((?:f|m|fem|masc|pl|sg|f\.|m\.)\)", re.I)
PAREN_NOTE_PATTERN = re.compile(r"\([^)]*\)")
NON_WORD_VAR_CLEAN = re.compile(r"^[\s.,;:'\"“”‘’!?-]+|[\s.,;:'\"“”‘’!?-]+$")


def utc_now_iso() -> str:
    """Return strict UTC timestamp formatted as YYYY-MM-DDTHH:MM:SSZ."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_soup(html: str) -> BeautifulSoup:
    """Create BeautifulSoup tree using lxml when available, falling back to html.parser."""
    try:
        return BeautifulSoup(html, "lxml")
    except FeatureNotFound:
        return BeautifulSoup(html, "html.parser")


def clean_text(raw: str | None) -> str:
    """Collapse internal whitespace and decode HTML entities cleanly."""
    if not raw:
        return ""
    text = html_lib.unescape(raw).replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


DEITY_ALIASES: dict[str, str] = {
    "anjaneya": "Hanuman",
}


def normalize_deity(raw: str | None) -> str:
    """Canonicalize comma/semicolon/slash-separated deity names (e.g. `Anjaneya` -> `Hanuman`)."""
    cleaned = clean_text(raw)
    if not cleaned:
        return ""
    parts: list[str] = []
    seen_low: set[str] = set()
    for seg in re.split(r"[,;/]+", cleaned):
        tok = seg.strip()
        if not tok:
            continue
        canonical = DEITY_ALIASES.get(tok.lower(), tok)
        key = canonical.lower()
        if key not in seen_low:
            seen_low.add(key)
            parts.append(canonical)
    return ", ".join(parts)


def infer_deity(title: str) -> str:
    """Infer deity from song title when the page metadata row is empty."""
    low = title.lower()
    for deity, kws in DEITY_KEYWORDS:
        if any(kw in low for kw in kws):
            return deity
    return "Universal"


def parse_pitch_info_optional(raw: str | None) -> dict[str, Any] | None:
    """Parse Sai Rhythms pitch string with boundary checks; return None if missing/invalid."""
    if not raw or not raw.strip():
        return None
    cleaned = clean_text(raw)
    low = cleaned.lower()
    for semitone, pancham, western in CHROMATIC_STEPS:
        pancham_pattern = re.compile(rf"(^|[^0-9.]){re.escape(pancham.lower())}($|[^a-z0-9])")
        if pancham_pattern.search(low):
            return {
                "raw": cleaned,
                "pancham": pancham,
                "western": western,
                "semitoneFromC": semitone,
            }
        w_tokens = [w.strip().lower() for w in western.split("/")]
        for wt in w_tokens:
            if re.search(rf"(^|[^a-z#]){re.escape(wt)}([^a-z#]|$)", low):
                return {
                    "raw": cleaned,
                    "pancham": pancham,
                    "western": western,
                    "semitoneFromC": semitone,
                }
    return None


def infer_script_kind(lines: list[str], language_label: str = "") -> str:
    """Classify lyric lines into the canonical 14 LyricsScriptKind identifiers."""
    joined = " ".join(lines)
    if any("\u0900" <= ch <= "\u097f" for ch in joined):
        return "devanagari"
    if any("\u0c00" <= ch <= "\u0c7f" for ch in joined):
        return "telugu"
    if any("\u0b80" <= ch <= "\u0bff" for ch in joined):
        return "tamil"
    if any("\u0c80" <= ch <= "\u0cff" for ch in joined):
        return "kannada"
    if any("\u0d00" <= ch <= "\u0d7f" for ch in joined):
        return "malayalam"
    if any("\u0980" <= ch <= "\u09ff" for ch in joined):
        return "bengali"
    if any("\u0a80" <= ch <= "\u0aff" for ch in joined):
        return "gujarati"
    if any("\u0b00" <= ch <= "\u0b7f" for ch in joined):
        return "odia"
    if any("\u0a00" <= ch <= "\u0a7f" for ch in joined):
        return "gurmukhi"
    if any("\u0600" <= ch <= "\u06ff" for ch in joined):
        return "arabic"
    if any("\u0400" <= ch <= "\u04ff" for ch in joined):
        return "cyrillic"
    if any(("\u3040" <= ch <= "\u30ff") or ("\u4e00" <= ch <= "\u9fff") for ch in joined):
        return "cjk"
    for ch in joined:
        code = ord(ch)
        if code > 0x024F and not (0x1E00 <= code <= 0x1EFF) and not (0x2000 <= code <= 0x206F):
            if unicodedata.category(ch).startswith("L"):
                return "other"

    label_low = (language_label or "").lower()
    if "devanagari" in label_low:
        return "devanagari"
    if "telugu" in label_low:
        return "telugu"
    if "tamil" in label_low:
        return "tamil"
    if "kannada" in label_low:
        return "kannada"
    if "malayalam" in label_low:
        return "malayalam"
    if "bengali" in label_low:
        return "bengali"
    if "gujarati" in label_low:
        return "gujarati"
    if "odia" in label_low or "oriya" in label_low:
        return "odia"
    if "gurmukhi" in label_low:
        return "gurmukhi"
    if "arabic" in label_low or "urdu" in label_low:
        return "arabic"
    if "cyrillic" in label_low or "russian" in label_low:
        return "cyrillic"
    if any(tok in label_low for tok in ("cjk", "chinese", "kanji", "hiragana", "katakana")):
        return "cjk"
    return "roman"


def compute_missing_bhajan_fields(doc: Mapping[str, Any]) -> list[str]:
    """Mirror `getMissingBhajanFields` from packages/shared/src/missing-fields.ts."""
    missing: list[str] = []
    lyrics_sets = doc.get("lyricsSets") or []
    is_estimated = bool(doc.get("isEstimated"))
    lyrics_absent = (
        bool(doc.get("lyricsMissing"))
        or not lyrics_sets
        or all(
            not (s.get("lines") or [])
            or any("awaiting sai rhythms" in str(line).lower() for line in (s.get("lines") or []))
            for s in lyrics_sets
        )
    )
    if lyrics_absent:
        missing.append("lyrics")

    meaning = (doc.get("meaning") or "").strip()
    if not meaning or meaning.startswith("Synced from local"):
        missing.append("meaning")

    if not doc.get("gentsPitch") or is_estimated:
        missing.append("gentsPitch")
    if not doc.get("ladiesPitch") or is_estimated:
        missing.append("ladiesPitch")

    raga_obj = doc.get("raga") or {}
    raga_name = (raga_obj.get("name") or "").strip()
    if (not raga_name) or (
        re.match(r"^(Traditional|Pending Sai Rhythms Sync)$", raga_name, re.I)
        and not raga_obj.get("arohanam")
    ):
        missing.append("raga")

    beat = (doc.get("beat") or "").strip()
    if (not beat) or is_estimated or "(est.)" in beat.lower():
        missing.append("beat")

    tempo = (doc.get("tempo") or "").strip()
    if (not tempo) or is_estimated:
        missing.append("tempo")

    first_notes = doc.get("firstLineNotes") or {}
    if not (first_notes.get("sargam") or "").strip() and not (first_notes.get("westernInC") or "").strip():
        missing.append("notation")

    if len(lyrics_sets) <= 1:
        missing.append("alternateScripts")

    order_map = {k: idx for idx, k in enumerate(MISSING_FIELD_ORDER)}
    return sorted(missing, key=lambda key: order_map.get(key, 999))


def extract_super_song_json(html: str) -> dict[str, Any] | None:
    """Safely extract embedded `super_song` or `Drupal.settings` song JSON when present."""
    decoder = json.JSONDecoder()
    for marker in ('"super_song":', "'super_song':", "Drupal.settings, "):
        idx = html.find(marker)
        while idx != -1:
            brace_idx = html.find("{", idx + len(marker))
            if brace_idx == -1:
                break
            try:
                obj, _ = decoder.raw_decode(html, brace_idx)
                if isinstance(obj, dict):
                    if "super_song" in obj and isinstance(obj["super_song"], dict):
                        return obj["super_song"]
                    if marker.startswith("Drupal"):
                        # Keep looking only if super_song wasn't inside this Drupal.settings block
                        return obj.get("super_song") if isinstance(obj.get("super_song"), dict) else None
                    return obj
            except json.JSONDecodeError:
                pass
            idx = html.find(marker, idx + len(marker))
    return None


def _extract_meta_row_bs4(soup: BeautifulSoup, row_class: str) -> str:
    for row in soup.select(f"div.{row_class}"):
        cols = row.find_all("div", recursive=False)
        if len(cols) >= 2:
            val = clean_text(cols[1].get_text(" ", strip=True))
            if val:
                return val
        elif len(cols) == 1:
            val = clean_text(cols[0].get_text(" ", strip=True))
            if val:
                return val
    return ""


def _resolve_abs_url(raw_url: str | None) -> str | None:
    if not raw_url:
        return None
    cleaned = html_lib.unescape(raw_url.strip())
    if not cleaned:
        return None
    if cleaned.startswith("http://") or cleaned.startswith("https://"):
        return cleaned
    return urllib.parse.urljoin(BASE_URL, cleaned)


YOUTUBE_URL_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|embed/|shorts/)|youtube-nocookie\.com/embed/|youtu\.be/)([A-Za-z0-9_-]{11})",
    re.I,
)


def extract_youtube_video_id(raw_url: str | None) -> str | None:
    """Extract canonical 11-char YouTube video ID from watch/embed/short links."""
    if not raw_url:
        return None
    m = YOUTUBE_URL_RE.search(html_lib.unescape(raw_url.strip()))
    return m.group(1) if m else None


def parse_sairhythms_html(slug: str, html: str, crawled_at: str | None = None) -> dict[str, Any] | None:
    """Parse a Sai Rhythms devotional song HTML page into the canonical Bhajan record."""
    if not html or ("node-type-devotional-song" not in html and "devotional-song-content" not in html):
        return None

    soup = make_soup(html)
    super_song = extract_super_song_json(html) or {}

    header_el = soup.select_one("h1.page-header, h2.page-header")
    title = clean_text(header_el.get_text(" ", strip=True)) if header_el else ""
    if not title or title.lower() == "sai rhythms":
        if soup.title and soup.title.string:
            t_raw = soup.title.string.split("|")[0]
            title = clean_text(t_raw)
    if not title:
        title = str(super_song.get("title") or "").strip() or slug.replace("-", " ").title()

    tab_labels_by_num: dict[str, str] = {}
    ordered_tab_labels: list[str] = []
    for a in soup.select("a.alt-lyrics-title"):
        label = clean_text(a.get_text(" ", strip=True))
        if not label:
            continue
        ordered_tab_labels.append(label)
        num_attr = a.get("num")
        if num_attr is not None:
            tab_labels_by_num[str(num_attr).strip()] = label

    lyrics_sets: list[dict[str, Any]] = []
    lyrics_divs = soup.select("div.devotional-song-content div.lyrics-set")
    if not lyrics_divs:
        lyrics_divs = soup.select("div.lyrics-set")

    for idx, div in enumerate(lyrics_divs):
        line_els = div.select(".song-first-line, .song-line")
        if line_els:
            lines = [clean_text(el.get_text(" ", strip=True)) for el in line_els]
        else:
            raw_text = html_lib.unescape(div.get_text("\n", strip=True))
            lines = [clean_text(ln) for ln in raw_text.splitlines()]
        lines = [ln for ln in lines if ln]
        if not lines:
            continue
        label = (
            tab_labels_by_num.get(str(idx))
            or (ordered_tab_labels[idx] if idx < len(ordered_tab_labels) else "")
            or (_extract_meta_row_bs4(soup, "language-row") if idx == 0 else "")
            or f"Script {idx + 1}"
        )
        script = infer_script_kind(lines, label)
        lyrics_sets.append({"language": label, "script": script, "lines": lines})

    deity = (
        normalize_deity(_extract_meta_row_bs4(soup, "deity-row") or str(super_song.get("deity") or ""))
        or infer_deity(title)
    )
    language = _extract_meta_row_bs4(soup, "language-row") or str(super_song.get("language") or "").strip()
    beat = _extract_meta_row_bs4(soup, "beat-row") or str(super_song.get("beat") or "").strip()
    level = _extract_meta_row_bs4(soup, "level-row") or str(super_song.get("level") or "").strip()
    tempo = _extract_meta_row_bs4(soup, "tempo-row") or str(super_song.get("tempo") or "").strip()

    raga_el = soup.select_one(".raga-title")
    raga_name = clean_text(raga_el.get_text(" ", strip=True)) if raga_el else str(super_song.get("raga") or "").strip()
    arohanam = str(super_song.get("arohanam") or "").strip() or None
    avarohanam = str(super_song.get("avarohanam") or "").strip() or None
    western_c = str(super_song.get("westernInC") or "").strip() or None

    raga_panel = soup.select_one(".raga-notes-panel")
    if raga_panel:
        note_lines: list[str] = []
        for child in raga_panel.find_all("div", recursive=False):
            cls_list = child.get("class") or []
            txt = clean_text(child.get_text(" ", strip=True))
            if not txt or txt in ("Notes:", "In the Key of C:") or txt.startswith("*"):
                continue
            if "small-font" in cls_list and ("key of c" in txt.lower() or "notes:" in txt.lower()):
                continue
            note_lines.append(txt)
        if len(note_lines) >= 2 and not arohanam:
            arohanam = note_lines[0]
            avarohanam = note_lines[1]
        if len(note_lines) >= 4 and not western_c:
            western_c = f"{note_lines[2]} | {note_lines[3]}"

    gents_raw = ""
    ladies_raw = ""
    first_sargam = str(super_song.get("firstLineSargam") or "").strip() or None
    first_western = str(super_song.get("firstLineWesternInC") or "").strip() or None
    notes_range = str(super_song.get("notesRange") or "").strip() or None

    for prow in soup.select(".pitch-row"):
        cols = prow.find_all("div", recursive=False)
        if len(cols) < 2:
            continue
        key_text = clean_text(cols[0].get_text(" ", strip=True)).lower()
        val_col = cols[1]
        if "reference gents pitch" in key_text:
            gents_raw = clean_text(val_col.get_text(" ", strip=True))
        elif "reference ladies pitch" in key_text:
            ladies_raw = clean_text(val_col.get_text(" ", strip=True))
        elif "music notes for first line" in key_text:
            raw_val_html = str(val_col)
            parts = re.split(r"<div[^>]*>\s*In the Key of C:\s*</div>", raw_val_html, flags=re.I)
            s_text = clean_text(make_soup(parts[0]).get_text(" ", strip=True))
            if s_text:
                first_sargam = s_text
            if len(parts) > 1:
                w_soup = make_soup(parts[1])
                w_text = clean_text(w_soup.get_text(" ", strip=True)).replace("* Western notes are in the Key of C", "").strip()
                if w_text:
                    first_western = w_text
        elif "notes range" in key_text:
            nr = clean_text(val_col.get_text(" ", strip=True)).replace("* Western notes are in the Key of C", "").strip()
            if nr:
                notes_range = nr

    gents_pitch = parse_pitch_info_optional(gents_raw)
    ladies_pitch = parse_pitch_info_optional(ladies_raw)

    sheet_iframe = soup.select_one("iframe#sheet-music-viewer")
    sheet_url = _resolve_abs_url(sheet_iframe.get("src") if sheet_iframe else super_song.get("sheetMusicUrl"))

    meaning_el = soup.select_one(".devotional-song-meaning")
    meaning = clean_text(meaning_el.get_text(" ", strip=True)) if meaning_el else str(super_song.get("meaning") or "").strip()
    meaning_out = meaning or None

    glossary: list[dict[str, str]] = []
    term_els = soup.select(".devotional-song-glossary-term")
    desc_els = soup.select(".devotional-song-glossary-term-description")
    for t_el, d_el in zip(term_els, desc_els):
        term = clean_text(t_el.get_text(" ", strip=True)).rstrip(":")
        desc = clean_text(d_el.get_text(" ", strip=True))
        if term and desc:
            glossary.append({"term": term, "description": desc})

    recordings: list[dict[str, Any]] = []
    seen_audio_urls: set[str] = set()
    for audio_el in soup.select("audio source[src], a[href$='.mp3']"):
        raw_src = audio_el.get("src") or audio_el.get("href")
        abs_url = _resolve_abs_url(raw_src)
        if not abs_url or abs_url in seen_audio_urls:
            continue
        seen_audio_urls.add(abs_url)
        rec_digest = hashlib.sha1(abs_url.encode("utf-8")).hexdigest()[:12]
        fname = Path(urllib.parse.urlparse(abs_url).path).name or f"{slug}.mp3"
        recordings.append(
            {
                "id": f"sair_{rec_digest}",
                "label": f"Sai Rhythms Reference Audio ({fname})",
                "collection": "sairhythms_ref",
                "externalUrl": abs_url,
            }
        )

    seen_yt_ids: set[str] = set()
    for media_el in soup.select("iframe[src], a[href]"):
        raw_ref = media_el.get("src") or media_el.get("href")
        yt_id = extract_youtube_video_id(str(raw_ref) if raw_ref else None)
        if not yt_id or yt_id in seen_yt_ids:
            continue
        seen_yt_ids.add(yt_id)
        recordings.append(
            {
                "id": f"sair_yt_{yt_id}",
                "label": f"Sai Rhythms Reference Video ({title})",
                "collection": "sairhythms_ref",
                "externalUrl": f"https://www.youtube.com/watch?v={yt_id}",
                "youtubeVideoId": yt_id,
                "embeddable": True,
            }
        )

    first_line_notes = (
        {"sargam": first_sargam, "westernInC": first_western}
        if (first_sargam or first_western)
        else None
    )

    doc: dict[str, Any] = {
        "id": slug,
        "slug": slug,
        "title": title,
        "deity": deity,
        "language": language,
        "raga": {
            "name": raga_name,
            "arohanam": arohanam,
            "avarohanam": avarohanam,
            "westernInC": western_c,
        },
        "beat": beat,
        "tempo": tempo,
        "level": level or None,
        "gentsPitch": gents_pitch,
        "ladiesPitch": ladies_pitch,
        "gentsPitchRaw": gents_raw or None,
        "ladiesPitchRaw": ladies_raw or None,
        "firstLineNotes": first_line_notes,
        "notesRange": notes_range,
        "meaning": meaning_out,
        "lyricsSets": lyrics_sets,
        "glossary": glossary,
        "recordings": recordings,
        "sheetMusicUrl": sheet_url,
        "sourceUrl": f"{BASE_URL}/song/{slug}",
        "metadataSource": "sairhythms_verified",
        "lyricsMissing": len(lyrics_sets) == 0,
        "crawledAt": crawled_at or utc_now_iso(),
    }
    doc["missingFields"] = compute_missing_bhajan_fields(doc)
    doc["matchStatus"] = "verified"

    hash_payload = {k: v for k, v in doc.items() if k not in ("crawledAt", "updatedAt", "createdAt")}
    doc["contentHash"] = hashlib.sha256(
        json.dumps(hash_payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    return doc


def _looks_like_gender_pair(a: str, b: str) -> bool:
    """Reject contrastive Sanskrit/Hindi feminine/masculine inflection pairs."""
    wa = a.lower().strip()
    wb = b.lower().strip()
    if not wa or not wb or wa == wb:
        return False
    for pair in (
        ("a", "i"),
        ("a", "ee"),
        ("a", "aa"),
        ("aka", "aki"),
        ("ka", "ki"),
        ("an", "ini"),
    ):
        if (wa.endswith(pair[0]) and wb.endswith(pair[1]) and wa[: -len(pair[0])] == wb[: -len(pair[1])]) or (
            wb.endswith(pair[0]) and wa.endswith(pair[1]) and wb[: -len(pair[0])] == wa[: -len(pair[1])]
        ):
            return True
    return False


def load_phonetic_config() -> dict[str, Any]:
    """Load canonical phonetic rules from packages/shared/data/indic-phonetics.json."""
    spec_path = SHARED_DATA_DIR / "indic-phonetics.json"
    if spec_path.exists():
        return json.loads(spec_path.read_text(encoding="utf-8"))
    return {"thresholds": dict(phonetics.THRESHOLDS), "doNotMergePairs": []}


def extract_safe_glossary_variants(
    glossary: Iterable[Mapping[str, Any]],
    *,
    phonetic_config: Mapping[str, Any] | None = None,
    song_slug: str | None = None,
) -> list[dict[str, Any]]:
    """Extract only safe phonetic spelling variants from glossary `(var)` clauses.

    Requires `normalized_word_sim >= 0.78`, single tokens of length >= 3, rejects explicit
    gender/morphology tags `(f)` / `(m)`, rejects `doNotMergePairs`, and rejects contrastive
    gender inflection endings (e.g. `deva`/`devi`, `dayaka`/`dayaki`).
    """
    cfg = phonetic_config or load_phonetic_config()
    min_sim = float(cfg.get("thresholds", {}).get("glossaryVarMin", phonetics.THRESHOLDS["glossaryVarMin"]))
    blocked_pairs: set[tuple[str, str]] = set()
    for pair in cfg.get("doNotMergePairs", []):
        if isinstance(pair, list) and len(pair) == 2:
            pa = phonetics.canonicalize_phrase(str(pair[0]))
            pb = phonetics.canonicalize_phrase(str(pair[1]))
            if pa and pb:
                blocked_pairs.add(tuple(sorted((pa, pb))))

    seeds: list[dict[str, Any]] = []
    seen_pairs: set[tuple[str, str]] = set()

    for entry in glossary:
        term_raw = clean_text(str(entry.get("term") or "")).rstrip(":")
        desc_raw = clean_text(str(entry.get("description") or ""))
        if not term_raw or "(var)" not in desc_raw.lower():
            continue
        if len(term_raw.split()) != 1:
            continue
        head_clean = NON_WORD_VAR_CLEAN.sub("", term_raw.lower())
        if len(head_clean) < 3 or GENDER_OR_MORPH_TAGS.search(term_raw):
            continue

        var_split = re.split(r"\(var\)", desc_raw, maxsplit=1, flags=re.I)
        if len(var_split) < 2:
            continue
        raw_var_tail = var_split[1].split(";")[0]
        for cand_raw in raw_var_tail.split(","):
            cand_raw = cand_raw.strip()
            if not cand_raw:
                continue
            if GENDER_OR_MORPH_TAGS.search(cand_raw):
                continue
            cand_clean = PAREN_NOTE_PATTERN.sub("", cand_raw)
            cand_clean = NON_WORD_VAR_CLEAN.sub("", cand_clean.lower())
            if not cand_clean or len(cand_clean.split()) != 1 or len(cand_clean) < 3:
                continue
            if cand_clean == head_clean:
                continue
            if _looks_like_gender_pair(head_clean, cand_clean):
                continue

            canon_a = phonetics.canonicalize_sanskrit_word(head_clean)
            canon_b = phonetics.canonicalize_sanskrit_word(cand_clean)
            if not canon_a or not canon_b:
                continue
            blocked_key = tuple(sorted((canon_a, canon_b)))
            if blocked_key in blocked_pairs:
                continue

            sim = phonetics.normalized_word_sim(head_clean, cand_clean)
            if sim < min_sim:
                continue

            dedupe_key = tuple(sorted((head_clean, cand_clean)))
            if dedupe_key in seen_pairs:
                continue
            seen_pairs.add(dedupe_key)
            seeds.append(
                {
                    "term": head_clean,
                    "variant": cand_clean,
                    "canonicalTerm": canon_a,
                    "canonicalVariant": canon_b,
                    "similarity": round(sim, 4),
                    "source": "sairhythms_var",
                    **({"songSlug": song_slug} if song_slug else {}),
                }
            )
    return seeds


def merge_with_existing_doc(crawled_doc: dict[str, Any], existing_doc: Mapping[str, Any] | None) -> dict[str, Any]:
    """Merge a freshly crawled Sai Rhythms song with an existing Firestore Bhajan doc.

    When `existing_doc.get('bhajamiOverride') is True`, curated human overrides remain intact
    while new `sairhythms_ref` recordings and crawl bookkeeping (`sourceUrl`, `crawledAt`) update.
    """
    crawled_clean = {k: v for k, v in crawled_doc.items() if k != "contentHash"}
    if not existing_doc:
        now = crawled_clean.get("crawledAt") or utc_now_iso()
        crawled_clean.setdefault("createdAt", now)
        crawled_clean["updatedAt"] = now
        return crawled_clean

    if existing_doc.get("bhajamiOverride") is True:
        merged = dict(existing_doc)
        merged["bhajamiOverride"] = True
        merged["sourceUrl"] = crawled_clean.get("sourceUrl") or existing_doc.get("sourceUrl")
        merged["crawledAt"] = crawled_clean.get("crawledAt") or utc_now_iso()
        merged["updatedAt"] = utc_now_iso()

        existing_recs = list(existing_doc.get("recordings") or [])
        seen_rec_ids = {r.get("id") for r in existing_recs if isinstance(r, Mapping)}
        seen_urls = {r.get("externalUrl") for r in existing_recs if isinstance(r, Mapping) and r.get("externalUrl")}
        for rec in crawled_clean.get("recordings") or []:
            if rec.get("id") not in seen_rec_ids and rec.get("externalUrl") not in seen_urls:
                existing_recs.append(rec)
        merged["recordings"] = existing_recs
        merged["missingFields"] = compute_missing_bhajan_fields(merged)
        return merged

    merged = dict(crawled_clean)
    merged["createdAt"] = existing_doc.get("createdAt") or crawled_clean.get("crawledAt") or utc_now_iso()
    merged["updatedAt"] = utc_now_iso()

    # Preserve non-sairhythms community/local recordings and approved slug aliases.
    crawled_recs = list(crawled_clean.get("recordings") or [])
    seen_ids = {r.get("id") for r in crawled_recs if isinstance(r, Mapping)}
    for rec in existing_doc.get("recordings") or []:
        if not isinstance(rec, Mapping):
            continue
        if rec.get("collection") != "sairhythms_ref" and rec.get("id") not in seen_ids:
            crawled_recs.append(dict(rec))
    merged["recordings"] = crawled_recs
    if existing_doc.get("slugAliases"):
        merged["slugAliases"] = list(existing_doc["slugAliases"])
    if existing_doc.get("matchCandidates"):
        merged["matchCandidates"] = list(existing_doc["matchCandidates"])
    merged["missingFields"] = compute_missing_bhajan_fields(merged)
    return merged


class CrawlStateDB:
    """SQLite checkpoint store tracking slug fetch state, content hashes, and Firestore syncs."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS slugs (
                slug TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                etag TEXT,
                last_modified TEXT,
                html_sha256 TEXT,
                content_hash TEXT,
                status TEXT NOT NULL,
                fetched_at TEXT,
                firestore_synced_at TEXT,
                error TEXT
            );
            CREATE TABLE IF NOT EXISTS crawl_runs (
                run_id TEXT PRIMARY KEY,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                mode TEXT NOT NULL,
                fetched_count INTEGER DEFAULT 0,
                skipped_count INTEGER DEFAULT 0,
                parsed_count INTEGER DEFAULT 0,
                firestore_writes INTEGER DEFAULT 0,
                error_count INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS discovery_sources (
                source_path TEXT PRIMARY KEY,
                next_page INTEGER NOT NULL DEFAULT 0,
                max_page INTEGER,
                completed INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT
            );
            """
        )
        self.conn.commit()

    def seed_discovery_sources(self, sources: Iterable[str]) -> None:
        now = utc_now_iso()
        for src in sources:
            self.conn.execute(
                """
                INSERT OR IGNORE INTO discovery_sources (source_path, next_page, completed, updated_at)
                VALUES (?, 0, 0, ?)
                """,
                (src, now),
            )
        self.conn.commit()

    def get_next_discovery_source(self) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM discovery_sources WHERE completed = 0 ORDER BY rowid ASC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None

    def update_discovery_source(
        self,
        source_path: str,
        *,
        next_page: int,
        max_page: int | None,
        completed: bool,
    ) -> None:
        self.conn.execute(
            """
            UPDATE discovery_sources
            SET next_page = ?, max_page = ?, completed = ?, updated_at = ?
            WHERE source_path = ?
            """,
            (next_page, max_page, 1 if completed else 0, utc_now_iso(), source_path),
        )
        self.conn.commit()

    def register_discovered_slug(self, slug: str, url: str) -> bool:
        cur = self.conn.execute(
            """
            INSERT OR IGNORE INTO slugs (slug, url, status)
            VALUES (?, ?, 'discovered')
            """,
            (slug, url),
        )
        self.conn.commit()
        return cur.rowcount > 0

    def list_unsynced_slugs(self, limit: int = 0) -> list[str]:
        sql = (
            "SELECT slug FROM slugs "
            "WHERE status NOT IN ('synced', 'non_song') AND firestore_synced_at IS NULL "
            "ORDER BY rowid ASC"
        )
        if limit > 0:
            rows = self.conn.execute(f"{sql} LIMIT ?", (limit,)).fetchall()
        else:
            rows = self.conn.execute(sql).fetchall()
        return [str(r["slug"]) for r in rows]

    def get_slug(self, slug: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM slugs WHERE slug = ?", (slug,)).fetchone()
        return dict(row) if row else None

    def upsert_slug(
        self,
        *,
        slug: str,
        url: str,
        status: str,
        html_sha256: str | None = None,
        content_hash: str | None = None,
        etag: str | None = None,
        last_modified: str | None = None,
        fetched_at: str | None = None,
        firestore_synced_at: str | None = None,
        error: str | None = None,
    ) -> None:
        existing = self.get_slug(slug) or {}
        self.conn.execute(
            """
            INSERT INTO slugs (
                slug, url, etag, last_modified, html_sha256, content_hash,
                status, fetched_at, firestore_synced_at, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
                url = excluded.url,
                etag = COALESCE(excluded.etag, slugs.etag),
                last_modified = COALESCE(excluded.last_modified, slugs.last_modified),
                html_sha256 = COALESCE(excluded.html_sha256, slugs.html_sha256),
                content_hash = COALESCE(excluded.content_hash, slugs.content_hash),
                status = excluded.status,
                fetched_at = COALESCE(excluded.fetched_at, slugs.fetched_at),
                firestore_synced_at = COALESCE(excluded.firestore_synced_at, slugs.firestore_synced_at),
                error = excluded.error
            """,
            (
                slug,
                url,
                etag if etag is not None else existing.get("etag"),
                last_modified if last_modified is not None else existing.get("last_modified"),
                html_sha256 if html_sha256 is not None else existing.get("html_sha256"),
                content_hash if content_hash is not None else existing.get("content_hash"),
                status,
                fetched_at or existing.get("fetched_at"),
                firestore_synced_at or existing.get("firestore_synced_at"),
                error,
            ),
        )
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()


def read_cached_html(cache_dir: Path, slug: str) -> str | None:
    """Read HTML from `.html.gz` first, falling back to legacy plain `.html`."""
    gz_path = cache_dir / f"{slug}.html.gz"
    if gz_path.exists():
        with gzip.open(gz_path, "rt", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    plain_path = cache_dir / f"{slug}.html"
    if plain_path.exists():
        return plain_path.read_text(encoding="utf-8", errors="replace")
    return None


def write_cached_html(cache_dir: Path, slug: str, html: str) -> Path:
    """Persist fetched Sai Rhythms HTML compressed as `.html.gz`."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    gz_path = cache_dir / f"{slug}.html.gz"
    with gzip.open(gz_path, "wt", encoding="utf-8") as fh:
        fh.write(html)
    return gz_path


def enforce_crawl_delay(
    last_fetch_monotonic: float | None,
    delay_sec: float = MIN_CRAWL_DELAY_SEC,
    *,
    now_fn: Callable[[], float] = time.monotonic,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> float:
    """Block until at least `max(delay_sec, MIN_CRAWL_DELAY_SEC)` seconds have elapsed."""
    effective_delay = max(float(delay_sec), MIN_CRAWL_DELAY_SEC)
    now = now_fn()
    if last_fetch_monotonic is not None:
        remaining = effective_delay - (now - last_fetch_monotonic)
        if remaining > 0:
            sleep_fn(remaining)
            now = now_fn()
    return now


def extract_song_slugs_from_sitemap_xml(xml_text: str) -> tuple[list[str], list[str]]:
    """Return `(song_slugs, child_sitemap_urls)` from Sai Rhythms XML sitemap."""
    root = ET.fromstring(xml_text)
    child_sitemaps: list[str] = []
    song_slugs: list[str] = []
    for elem in root.iter():
        tag_name = elem.tag.split("}")[-1].lower()
        if tag_name == "loc" and elem.text:
            url = elem.text.strip()
            parts = [p for p in urllib.parse.urlparse(url).path.strip("/").split("/") if p]
            if len(parts) == 2 and parts[0] == "song":
                slug = parts[1]
                if slug not in ("tags", "sheet_music", "api"):
                    song_slugs.append(slug)
            elif url.endswith(".xml") or "sitemap" in url:
                child_sitemaps.append(url)
    return list(dict.fromkeys(song_slugs)), list(dict.fromkeys(child_sitemaps))


def _fetch_url_text(
    url: str,
    *,
    etag: str | None = None,
    last_modified: str | None = None,
    timeout_sec: float = 15.0,
) -> tuple[int, str | None, dict[str, str]]:
    headers = {"User-Agent": USER_AGENT}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return int(resp.status), body, resp_headers
    except urllib.error.HTTPError as err:
        if err.code == 304:
            return 304, None, {k.lower(): v for k, v in (err.headers.items() if err.headers else [])}
        raise


def extract_song_slugs_from_listing_html(html: str) -> tuple[list[str], int | None]:
    """Extract unique `/song/<slug>` entries and max pager page index from a listing page."""
    soup = make_soup(html)
    slugs: list[str] = []
    seen_slugs: set[str] = set()
    max_page: int | None = None

    for anchor in soup.find_all("a", href=True):
        href = str(anchor["href"]).strip()
        if not href:
            continue
        parsed = urllib.parse.urlparse(href)
        path_parts = [p for p in parsed.path.strip("/").split("/") if p]
        if len(path_parts) == 2 and path_parts[0] == "song":
            slug = path_parts[1]
            if (
                slug not in NON_SONG_SLUGS
                and re.match(r"^[a-z0-9][a-z0-9-]+$", slug)
                and slug not in seen_slugs
            ):
                seen_slugs.add(slug)
                slugs.append(slug)

        if parsed.query:
            qs = urllib.parse.parse_qs(parsed.query)
            if "page" in qs and qs["page"]:
                try:
                    page_num = int(qs["page"][0])
                    if max_page is None or page_num > max_page:
                        max_page = page_num
                except ValueError:
                    pass

    return slugs, max_page


def discover_slugs_incrementally(
    db: CrawlStateDB,
    *,
    needed_count: int,
    delay_sec: float = MIN_CRAWL_DELAY_SEC,
    last_fetch_ts: float | None = None,
    sources: Iterable[str] = DEFAULT_DISCOVERY_SOURCES,
    fetch_fn: Callable[..., tuple[int, str | None, dict[str, str]]] | None = None,
) -> tuple[list[str], float | None, int]:
    """Politely page through public Sai Rhythms directories until `needed_count` unsynced slugs exist."""
    fetcher = fetch_fn or _fetch_url_text
    db.seed_discovery_sources(sources)
    unsynced = db.list_unsynced_slugs(limit=needed_count)
    pages_fetched = 0

    while needed_count == 0 or len(unsynced) < needed_count:
        src = db.get_next_discovery_source()
        if src is None:
            break
        source_path = str(src["source_path"])
        next_page = int(src["next_page"] or 0)
        url = f"{BASE_URL}{source_path}" if next_page == 0 else f"{BASE_URL}{source_path}?page={next_page}"

        last_fetch_ts = enforce_crawl_delay(last_fetch_ts, delay_sec)
        try:
            status_code, body, _ = fetcher(url)
        except urllib.error.HTTPError as err:
            if err.code == 404:
                db.update_discovery_source(
                    source_path,
                    next_page=next_page + 1,
                    max_page=src.get("max_page"),
                    completed=True,
                )
                continue
            break
        except (urllib.error.URLError, TimeoutError, OSError):
            break

        pages_fetched += 1
        if status_code != 200 or not body:
            db.update_discovery_source(
                source_path,
                next_page=next_page + 1,
                max_page=src.get("max_page"),
                completed=True,
            )
            continue

        page_slugs, page_max = extract_song_slugs_from_listing_html(body)
        for slug in page_slugs:
            db.register_discovered_slug(slug, f"{BASE_URL}/song/{slug}")

        known_max_candidates = [m for m in (src.get("max_page"), page_max) if m is not None]
        resolved_max = max(known_max_candidates) if known_max_candidates else None
        advanced_page = next_page + 1
        completed = (len(page_slugs) == 0) or (resolved_max is None) or (advanced_page > resolved_max)
        db.update_discovery_source(
            source_path,
            next_page=advanced_page,
            max_page=resolved_max,
            completed=completed,
        )
        unsynced = db.list_unsynced_slugs(limit=needed_count)

    return unsynced, last_fetch_ts, pages_fetched


def discover_slugs_from_sitemap(
    *,
    sitemap_url: str = SITEMAP_URL,
    delay_sec: float = MIN_CRAWL_DELAY_SEC,
    max_sitemaps: int = 20,
) -> list[str]:
    """Fetch Sai Rhythms sitemap XML(s) politely and collect all song slugs."""
    queue = [sitemap_url]
    visited: set[str] = set()
    slugs: list[str] = []
    seen_slugs: set[str] = set()
    last_ts: float | None = None

    while queue and len(visited) < max_sitemaps:
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        last_ts = enforce_crawl_delay(last_ts, delay_sec)
        status, xml_body, _ = _fetch_url_text(current)
        if status != 200 or not xml_body:
            continue
        found_slugs, child_maps = extract_song_slugs_from_sitemap_xml(xml_body)
        for s in found_slugs:
            if s not in seen_slugs:
                seen_slugs.add(s)
                slugs.append(s)
        for cm in child_maps:
            if cm not in visited:
                queue.append(cm)
    return slugs


def discover_cached_slugs(cache_dir: Path) -> list[str]:
    """Discover already-cached `.html` / `.html.gz` song slugs sorted alphabetically."""
    if not cache_dir.exists():
        return []
    slugs: set[str] = set()
    for p in cache_dir.iterdir():
        if p.name.endswith(".html.gz"):
            slugs.add(p.name[: -len(".html.gz")])
        elif p.name.endswith(".html"):
            slugs.add(p.name[: -len(".html")])
    return sorted(slugs)


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


def write_glossary_var_seeds(seeds: list[dict[str, Any]], out_path: Path) -> dict[str, Any]:
    """Write conservative deduplicated glossary `(var)` variant seeds artifact."""
    deduped: dict[tuple[str, str], dict[str, Any]] = {}
    for seed in seeds:
        key = (seed["canonicalTerm"], seed["canonicalVariant"])
        prev = deduped.get(key)
        if prev is None or seed["similarity"] > prev["similarity"]:
            deduped[key] = seed

    sorted_seeds = sorted(
        deduped.values(),
        key=lambda item: (item["canonicalTerm"], item["canonicalVariant"]),
    )
    payload = {
        "generatedAt": utc_now_iso(),
        "source": "sairhythms_glossary_var",
        "minSimilarity": phonetics.THRESHOLDS["glossaryVarMin"],
        "count": len(sorted_seeds),
        "seeds": sorted_seeds,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return payload


def run_crawler(
    *,
    slugs: list[str] | None = None,
    reparse_cache: bool = False,
    delta_only: bool = False,
    refresh: bool = False,
    delay_sec: float = MIN_CRAWL_DELAY_SEC,
    batch_size: int = DEFAULT_BATCH_SIZE,
    max_songs_per_run: int = 0,
    max_firestore_writes: int = DEFAULT_MAX_FIRESTORE_WRITES,
    publish_firestore: bool = False,
    emit_var_seeds: bool = False,
    seeds_out: Path = DEFAULT_SEEDS_OUT,
    cache_dir: Path = DEFAULT_CACHE_DIR,
    state_db_path: Path = DEFAULT_STATE_DB,
    audit_log_path: Path = DEFAULT_AUDIT_LOG,
    parsed_out: Path | None = None,
) -> dict[str, Any]:
    """Execute one bounded crawl/reparse cycle with SQLite resume state."""
    effective_delay = max(float(delay_sec), MIN_CRAWL_DELAY_SEC)
    db = CrawlStateDB(state_db_path)
    phonetic_cfg = load_phonetic_config()
    last_fetch_ts: float | None = None
    discovery_pages_fetched = 0
    skipped_synced = 0

    target_slugs = list(slugs or [])
    if not target_slugs:
        if reparse_cache:
            target_slugs = discover_cached_slugs(cache_dir)
            if delta_only:
                unsynced: list[str] = []
                for s in target_slugs:
                    row = db.get_slug(s)
                    if row and (row.get("status") == "synced" or row.get("firestore_synced_at")):
                        skipped_synced += 1
                    else:
                        unsynced.append(s)
                target_slugs = unsynced
            if max_songs_per_run > 0:
                target_slugs = target_slugs[:max_songs_per_run]
        else:
            target_slugs, last_fetch_ts, discovery_pages_fetched = discover_slugs_incrementally(
                db,
                needed_count=max_songs_per_run,
                delay_sec=effective_delay,
                last_fetch_ts=last_fetch_ts,
            )
    else:
        if delta_only:
            unsynced = []
            for s in target_slugs:
                row = db.get_slug(s)
                if row and (row.get("status") == "synced" or row.get("firestore_synced_at")):
                    skipped_synced += 1
                else:
                    unsynced.append(s)
            target_slugs = unsynced
        if max_songs_per_run > 0:
            target_slugs = target_slugs[:max_songs_per_run]

    stats = {
        "mode": "reparse_cache" if reparse_cache else "network_crawl",
        "dryRun": not publish_firestore,
        "targetSlugs": len(target_slugs),
        "discoveryPagesFetched": discovery_pages_fetched,
        "fetchedCount": 0,
        "cacheHitCount": 0,
        "skippedUnchanged": skipped_synced,
        "parsedCount": 0,
        "nonSongSkipped": 0,
        "firestoreWrites": 0,
        "firestoreWriteCap": max_firestore_writes,
        "stoppedAtWriteCap": False,
        "errorCount": 0,
        "varSeedsCount": 0,
        "delayFloorSec": effective_delay,
    }

    parsed_docs: list[dict[str, Any]] = []
    all_var_seeds: list[dict[str, Any]] = []
    audit_log_path.parent.mkdir(parents=True, exist_ok=True)
    fs_client = _init_firestore_client() if publish_firestore else None

    def append_audit(event: dict[str, Any]) -> None:
        with audit_log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, ensure_ascii=False) + "\n")

    pending_fs_docs: list[dict[str, Any]] = []

    def flush_firestore_batch() -> None:
        nonlocal pending_fs_docs
        if not pending_fs_docs or fs_client is None:
            pending_fs_docs = []
            return
        remaining_budget = max_firestore_writes - stats["firestoreWrites"]
        if remaining_budget <= 0:
            stats["stoppedAtWriteCap"] = True
            pending_fs_docs = []
            return
        chunk = pending_fs_docs[:remaining_budget]
        col = fs_client.collection("bhajans")
        refs = [col.document(item["id"]) for item in chunk]
        existing_snaps = {snap.id: snap.to_dict() for snap in fs_client.get_all(refs) if snap.exists}
        batch = fs_client.batch()
        for doc in chunk:
            merged = merge_with_existing_doc(doc, existing_snaps.get(doc["id"]))
            batch.set(col.document(doc["id"]), merged)
        batch.commit()
        synced_at = utc_now_iso()
        for doc in chunk:
            db.upsert_slug(
                slug=doc["slug"],
                url=doc["sourceUrl"],
                status="synced",
                content_hash=doc.get("contentHash"),
                firestore_synced_at=synced_at,
            )
        stats["firestoreWrites"] += len(chunk)
        if stats["firestoreWrites"] >= max_firestore_writes and len(pending_fs_docs) > len(chunk):
            stats["stoppedAtWriteCap"] = True
        pending_fs_docs = []

    try:
        for slug in target_slugs:
            if publish_firestore and stats["firestoreWrites"] + len(pending_fs_docs) >= max_firestore_writes:
                flush_firestore_batch()
                stats["stoppedAtWriteCap"] = True
                break

            url = f"{BASE_URL}/song/{slug}"
            prev_row = db.get_slug(slug)
            html_text: str | None = None

            if reparse_cache:
                html_text = read_cached_html(cache_dir, slug)
                if html_text is not None:
                    stats["cacheHitCount"] += 1
                else:
                    stats["errorCount"] += 1
                    db.upsert_slug(slug=slug, url=url, status="missing_cache", error="Not in local .cache")
                    continue
            else:
                if not refresh:
                    html_text = read_cached_html(cache_dir, slug)
                    if html_text is not None:
                        stats["cacheHitCount"] += 1
                if html_text is None or refresh:
                    try:
                        last_fetch_ts = enforce_crawl_delay(last_fetch_ts, effective_delay)
                        status_code, fetched_body, resp_headers = _fetch_url_text(
                            url,
                            etag=prev_row.get("etag") if delta_only and prev_row else None,
                            last_modified=prev_row.get("last_modified") if delta_only and prev_row else None,
                        )
                        if status_code == 304:
                            stats["skippedUnchanged"] += 1
                            db.upsert_slug(slug=slug, url=url, status="unchanged_304", fetched_at=utc_now_iso())
                            continue
                        if status_code != 200 or not fetched_body:
                            stats["errorCount"] += 1
                            db.upsert_slug(slug=slug, url=url, status=f"http_{status_code}")
                            continue
                        html_text = fetched_body
                        write_cached_html(cache_dir, slug, html_text)
                        stats["fetchedCount"] += 1
                        db.upsert_slug(
                            slug=slug,
                            url=url,
                            status="fetched",
                            etag=resp_headers.get("etag"),
                            last_modified=resp_headers.get("last-modified"),
                            fetched_at=utc_now_iso(),
                        )
                    except (urllib.error.URLError, TimeoutError, OSError) as exc:
                        stats["errorCount"] += 1
                        db.upsert_slug(slug=slug, url=url, status="fetch_error", error=str(exc))
                        append_audit({"ts": utc_now_iso(), "slug": slug, "event": "fetch_error", "error": str(exc)})
                        continue

            html_sha = hashlib.sha256(html_text.encode("utf-8")).hexdigest()
            parsed = parse_sairhythms_html(slug, html_text)
            if parsed is None:
                stats["nonSongSkipped"] += 1
                db.upsert_slug(slug=slug, url=url, status="non_song", html_sha256=html_sha)
                continue

            if delta_only and prev_row and prev_row.get("content_hash") == parsed["contentHash"] and prev_row.get("firestore_synced_at"):
                stats["skippedUnchanged"] += 1
                if emit_var_seeds:
                    all_var_seeds.extend(extract_safe_glossary_variants(parsed["glossary"], phonetic_config=phonetic_cfg, song_slug=slug))
                continue

            db.upsert_slug(
                slug=slug,
                url=url,
                status="parsed",
                html_sha256=html_sha,
                content_hash=parsed["contentHash"],
            )
            stats["parsedCount"] += 1
            parsed_docs.append({k: v for k, v in parsed.items() if k != "contentHash"})

            if emit_var_seeds:
                all_var_seeds.extend(extract_safe_glossary_variants(parsed["glossary"], phonetic_config=phonetic_cfg, song_slug=slug))

            if publish_firestore:
                pending_fs_docs.append(parsed)
                if len(pending_fs_docs) >= batch_size:
                    flush_firestore_batch()
            append_audit(
                {
                    "ts": utc_now_iso(),
                    "slug": slug,
                    "event": "parsed",
                    "scripts": len(parsed["lyricsSets"]),
                    "glossary": len(parsed["glossary"]),
                    "missingFields": parsed["missingFields"],
                }
            )

        if publish_firestore:
            flush_firestore_batch()

        if emit_var_seeds:
            seed_payload = write_glossary_var_seeds(all_var_seeds, seeds_out)
            stats["varSeedsCount"] = seed_payload["count"]

        if parsed_out is not None:
            parsed_out.parent.mkdir(parents=True, exist_ok=True)
            parsed_out.write_text(
                json.dumps({"generatedAt": utc_now_iso(), "count": len(parsed_docs), "bhajans": parsed_docs}, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
    finally:
        db.close()

    return stats


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Resumable Sai Rhythms 28-language crawler & glossary seed extractor")
    parser.add_argument("--slugs", type=str, default="", help="Optional comma-separated Sai Rhythms slugs")
    parser.add_argument("--reparse-cache", action="store_true", help="Reparse cached HTML files without network requests")
    parser.add_argument("--delta-only", action="store_true", help="Skip songs whose ETag/contentHash did not change")
    parser.add_argument("--refresh", action="store_true", help="Ignore HTML cache and re-fetch with Crawl-delay >= 10.2s")
    parser.add_argument("--delay-sec", type=float, default=MIN_CRAWL_DELAY_SEC, help="Seconds between HTTP requests (floor 10.2)")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="Firestore batch size")
    parser.add_argument("--max-songs-per-run", type=int, default=0, help="Optional cap on songs processed per run (0 = all)")
    parser.add_argument("--max-firestore-writes", type=int, default=DEFAULT_MAX_FIRESTORE_WRITES, help="Hard Firestore write cap")
    parser.add_argument("--dry-run", action="store_true", help="Skip Firestore writes (also default unless --publish-firestore)")
    parser.add_argument("--publish-firestore", action="store_true", help="Write parsed bhajans to Cloud Firestore")
    parser.add_argument("--emit-var-seeds", action="store_true", help="Write conservative glossary (var) seeds JSON")
    parser.add_argument("--seeds-out", type=Path, default=DEFAULT_SEEDS_OUT, help="Path to write glossary-variant-seeds.json")
    parser.add_argument("--parsed-out", type=Path, default=None, help="Optional JSON file for parsed Bhajan records")
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR, help="HTML cache directory")
    parser.add_argument("--state-db", type=Path, default=DEFAULT_STATE_DB, help="SQLite checkpoint path")
    parser.add_argument("--audit-log", type=Path, default=DEFAULT_AUDIT_LOG, help="JSONL audit log path")
    return parser


def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()
    slug_list = [s.strip() for s in args.slugs.split(",") if s.strip()]
    publish_firestore = bool(args.publish_firestore and not args.dry_run)
    summary = run_crawler(
        slugs=slug_list or None,
        reparse_cache=args.reparse_cache,
        delta_only=args.delta_only,
        refresh=args.refresh,
        delay_sec=args.delay_sec,
        batch_size=args.batch_size,
        max_songs_per_run=args.max_songs_per_run,
        max_firestore_writes=args.max_firestore_writes,
        publish_firestore=publish_firestore,
        emit_var_seeds=args.emit_var_seeds,
        seeds_out=args.seeds_out,
        cache_dir=args.cache_dir,
        state_db_path=args.state_db,
        audit_log_path=args.audit_log,
        parsed_out=args.parsed_out,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
