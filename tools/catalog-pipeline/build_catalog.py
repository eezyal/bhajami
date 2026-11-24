from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import html as html_lib
import json
import os
from pathlib import Path
import re
import time
from typing import Any
import urllib.error
import urllib.request

ROOT_DIR = Path(__file__).resolve().parents[2]
CACHE_DIR = Path(__file__).resolve().parent / ".cache"
OUT_CATALOG = ROOT_DIR / "packages" / "shared" / "data" / "catalog.json"

LOCAL_ARCHIVES = [
    ("sssmediacentre_bhajan_a_day", "SSS Media Centre — A Bhajan A Day", Path("/Users/chax/Downloads/BhajanDownloader")),
    ("ravi_mp3", "RaviMp3 — Mandir Archive", Path("/Users/chax/Downloads/RaviMp3")),
]

DEFAULT_PILOT_SLUGS = [
    "sundara-sundara-vinayaka",
    "aao-aao-nandalala",
    "adi-narayana-sai-narayana",
    "arunachala-shiva",
    "guru-deva-guru-govinda",
    "hey-shyama-sundara-hey-sai",
    "gajanana-hey-gajanana",
    "sarva-dharma-priya-deva",
    "shiva-shiva-shivaya-namah-om",
    "asathoma-sath-gamaya",
]

CHROMATIC_STEPS = [
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

DEITY_KEYWORDS = [
    ("Ganesha", ("ganesha", "gajanana", "vinayaka", "ganapathi", "ganapathe", "vighna", "lambodara", "mooshika")),
    ("Guru", ("guru", "datta", "dattatreya", "sadguru")),
    ("Devi", ("devi", "amba", "bhavani", "durga", "lakshmi", "saraswathi", "saraswati", "matha", "maa", "janani", "jagadeeshwari", "kalavati", "shankari", "eshwaramba", "annapurne")),
    ("Shiva", ("shiva", "shankara", "shambho", "shamboo", "mahadeva", "nataraja", "mahesha", "gangadhara", "arunachala", "linga", "pashupati", "bhootanatha")),
    ("Rama", ("rama", "raghu", "sita", "janaki", "ayodhya", "kausalya", "dasharatha", "kodanda", "raghava")),
    ("Hanuman", ("hanuman", "anjaneya", "maruti", "ramadootha", "rama dootha")),
    ("Krishna", ("krishna", "govinda", "gopala", "gopal", "madhava", "mukunda", "muralidhara", "murali", "nandalala", "nand ke", "radha", "radhey", "vittala", "vittahla", "panduranga", "narayana", "hari", "keshava", "giridhari", "giridhar", "kanhaiya", "shyam", "shyama", "keshav")),
    ("Sarva Dharma", ("allah", "maula", "jesus", "christ", "buddha", "sarva dharma", "zoroaster", "nanak")),
    ("Sai", ("sai", "parthi", "prasanthi", "prashanthi", "shirdi", "bhagawan", "baba", "sathya")),
]


def strip_tags(fragment: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html_lib.unescape(text).replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def clean_title_from_filename(stem: str) -> str:
    title = stem.strip()
    title = re.sub(r"^Listen\s*-\s*", "", title, flags=re.I)
    title = re.sub(r"\s*-\s*A Bhajan A Day.*$", "", title, flags=re.I)
    title = re.sub(
        r"^(Prashanthi Mandir Devotional Song|Devotional Song|Sai Bhajan)\s*[-–]?\s*",
        "",
        title,
        flags=re.I,
    )
    title = re.sub(r"(-\d+|\s*\(\d+\))$", "", title).strip()
    title = re.sub(r"\s+", " ", title)
    return title


def slugify(text: str) -> str:
    s = text.lower()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"[\s_-]+", "-", s).strip("-")
    return s or "untitled-bhajan"


def normalize_tokens(title: str) -> tuple[str, ...]:
    cleaned = re.sub(r"[^a-z0-9\s]", " ", title.lower())
    return tuple(tok for tok in cleaned.split() if tok)


def infer_deity(title: str) -> str:
    low = title.lower()
    for deity, keys in DEITY_KEYWORDS:
        if any(k in low for k in keys):
            return deity
    return "Sai"


def parse_pitch_info(raw: str, fallback_semitone: int) -> dict[str, Any]:
    cleaned = raw.strip()
    low = cleaned.lower()
    for semitone, pancham, western in CHROMATIC_STEPS:
        if pancham.lower() in low:
            return {
                "raw": cleaned or f"{pancham} / {western}",
                "pancham": pancham,
                "western": western,
                "semitoneFromC": semitone,
            }
        w_tokens = [w.strip().lower() for w in western.split("/")]
        for wt in w_tokens:
            if re.search(rf"(^|[^a-z#]){re.escape(wt)}([^a-z#]|$)", low):
                return {
                    "raw": cleaned or f"{pancham} / {western}",
                    "pancham": pancham,
                    "western": western,
                    "semitoneFromC": semitone,
                }
    semitone, pancham, western = CHROMATIC_STEPS[fallback_semitone % 12]
    return {
        "raw": cleaned or f"{pancham} / {western}",
        "pancham": pancham,
        "western": western,
        "semitoneFromC": semitone,
    }


def make_recording_id(prefix: str, key: str) -> str:
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def scan_local_archives() -> tuple[list[dict[str, Any]], dict[str, int]]:
    items: list[dict[str, Any]] = []
    counts = {"bhajanDownloaderCount": 0, "raviMp3Count": 0, "totalLocalRecordings": 0}

    for collection_id, collection_label, root in LOCAL_ARCHIVES:
        if not root.exists():
            continue
        for dirpath, _, filenames in os.walk(root):
            for fname in sorted(filenames):
                if not fname.lower().endswith(".mp3"):
                    continue
                full_path = Path(dirpath) / fname
                title = clean_title_from_filename(full_path.stem)
                if not title:
                    continue
                rec_id = make_recording_id(collection_id[:4], str(full_path))
                items.append(
                    {
                        "title": title,
                        "tokens": normalize_tokens(title),
                        "slug": slugify(title),
                        "recording": {
                            "id": rec_id,
                            "label": f"{collection_label}: {full_path.name}",
                            "collection": collection_id,
                            "localPath": str(full_path),
                            "fileSizeBytes": full_path.stat().st_size,
                        },
                    }
                )
                counts["totalLocalRecordings"] += 1
                if collection_id == "sssmediacentre_bhajan_a_day":
                    counts["bhajanDownloaderCount"] += 1
                else:
                    counts["raviMp3Count"] += 1
    return items, counts


def fetch_sairhythms_html(slug: str, refresh: bool = False) -> str | None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{slug}.html"
    if cache_file.exists() and not refresh:
        return cache_file.read_text(encoding="utf-8", errors="ignore")

    url = f"https://sairhythms.sathyasai.org/song/{slug}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "bhaJami-CatalogBuilder/0.1 (respectful educational Sai bhajan studio)"},
    )
    try:
        time.sleep(1.0)
        with urllib.request.urlopen(req, timeout=8) as resp:
            if resp.status != 200:
                return None
            html = resp.read().decode("utf-8", errors="ignore")
            cache_file.write_text(html, encoding="utf-8")
            return html
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def parse_meta_row(html: str, row_class: str, label_prefix: str | None = None) -> str:
    pattern = (
        rf"<div[^>]*class=['\"][^'\"]*\b{re.escape(row_class)}\b[^'\"]*['\"][^>]*>"
        rf"(.*?)</div>\s*</div>"
    )
    matches = re.findall(pattern, html, flags=re.S | re.I)
    for m in matches:
        inner_divs = re.findall(r"<div[^>]*>(.*?)</div>", m, flags=re.S | re.I)
        if len(inner_divs) >= 2:
            k = strip_tags(inner_divs[0])
            v = strip_tags(inner_divs[1])
            if label_prefix is None or label_prefix.lower() in k.lower():
                return v
    return ""


def parse_pitch_rows(html: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in re.finditer(
        r"<div[^>]*class=['\"][^'\"]*\bpitch-row\b[^'\"]*['\"][^>]*>"
        r"\s*<div[^>]*>(.*?)</div>\s*<div[^>]*>(.*?)(?:</div>\s*</div>|(?=<div[^>]*class=['\"][^'\"]*\b(?:pitch-row|sheet-music-row)\b))",
        html,
        flags=re.S | re.I,
    ):
        key = strip_tags(m.group(1)).lower()
        val_html = m.group(2)
        if "reference gents pitch" in key:
            out["gents"] = strip_tags(val_html)
        elif "reference ladies pitch" in key:
            out["ladies"] = strip_tags(val_html)
        elif "music notes for first line" in key:
            parts = val_html.split("<div class='small-font'>In the Key of C:</div>")
            out["first_sargam"] = strip_tags(parts[0])
            if len(parts) > 1:
                out["first_western"] = strip_tags(parts[1]).replace("* Western notes are in the Key of C", "").strip()
        elif "notes range" in key:
            out["notes_range"] = strip_tags(val_html).replace("* Western notes are in the Key of C", "").strip()
    return out


def parse_sairhythms_song(slug: str, html: str) -> dict[str, Any] | None:
    if "node-type-devotional-song" not in html:
        return None

    title_m = re.search(r"<h1[^>]*class=['\"][^'\"]*page-header[^'\"]*['\"][^>]*>(.*?)</h1>", html, flags=re.S | re.I)
    if not title_m:
        title_m = re.search(r"<title>(.*?)\s*\|\s*Sai Rhythms</title>", html, flags=re.S | re.I)
    title = strip_tags(title_m.group(1)) if title_m else slug.replace("-", " ").title()

    # Language labels for alt-lyrics tabs
    lang_labels = [
        strip_tags(m)
        for m in re.findall(r"<a[^>]*class=['\"][^'\"]*alt-lyrics-title[^'\"]*['\"][^>]*>(.*?)</a>", html, flags=re.S | re.I)
    ]

    lyrics_sets: list[dict[str, Any]] = []
    content_m = re.search(r"<div class=\"devotional-song-content\">(.*?)<!-- \.devotional-song-content -->", html, flags=re.S)
    if content_m:
        blocks = content_m.group(1).split("<div class='lyrics-set'")
        for idx, blk in enumerate(blocks[1:]):
            first_m = re.findall(r"<div class='song-first-line'>(.*?)</div>", blk, flags=re.S)
            rest_m = re.findall(r"<div class='song-line'>(.*?)</div>", blk, flags=re.S)
            lines = [strip_tags(x) for x in (first_m + rest_m) if strip_tags(x)]
            if not lines:
                continue
            label = lang_labels[idx] if idx < len(lang_labels) else f"Script {idx + 1}"
            joined = " ".join(lines)
            if any("\u0900" <= ch <= "\u097f" for ch in joined):
                script = "devanagari"
            elif any("\u0c00" <= ch <= "\u0c7f" for ch in joined):
                script = "telugu"
            elif any(ord(ch) > 127 and ch not in "āīūṛṅñṭḍṇśṣḥ’‘“”—–" for ch in joined):
                script = "other"
            else:
                script = "roman"
            lyrics_sets.append({"language": label, "script": script, "lines": lines})

    meaning_m = re.search(
        r"<div class='devotional-song-meaning[^']*'>(.*?)</div>",
        html,
        flags=re.S | re.I,
    )
    meaning = strip_tags(meaning_m.group(1)) if meaning_m else ""

    audio_m = re.search(r"<audio[^>]*>.*?<source[^>]*src=['\"]([^'\"]+)['\"]", html, flags=re.S | re.I)
    audio_url = None
    if audio_m:
        src = audio_m.group(1).strip()
        audio_url = src if src.startswith("http") else f"https://sairhythms.sathyasai.org{src}"

    deity = parse_meta_row(html, "deity-row") or infer_deity(title)
    language = parse_meta_row(html, "language-row") or "Sanskrit / Hindi"
    beat = parse_meta_row(html, "beat-row") or "8 Beat / Keherwa"
    level = parse_meta_row(html, "level-row") or ""
    tempo = parse_meta_row(html, "tempo-row") or "Medium"

    raga_name = ""
    arohanam = ""
    avarohanam = ""
    western_c = ""
    raga_title_m = re.search(r"<div class='raga-title'>(.*?)</div>", html, flags=re.S | re.I)
    if raga_title_m:
        raga_name = strip_tags(raga_title_m.group(1))
    raga_panel_m = re.search(r"raga-notes-panel[^>]*>(.*?)</div>\s*</div>\s*</div>", html, flags=re.S | re.I)
    if raga_panel_m:
        divs = [strip_tags(d) for d in re.findall(r"<div[^>]*>(.*?)</div>", raga_panel_m.group(1), flags=re.S | re.I)]
        divs = [d for d in divs if d and d not in ("Notes:", "In the Key of C:")]
        if len(divs) >= 2:
            arohanam = re.sub(r"\s+", " ", divs[0])
            avarohanam = re.sub(r"\s+", " ", divs[1])
        if len(divs) >= 4:
            w_asc = re.sub(r"\s+", " ", divs[2])
            w_desc = re.sub(r"\s+", " ", divs[3])
            western_c = f"{w_asc} | {w_desc}"

    pitches = parse_pitch_rows(html)

    sheet_m = re.search(r"<iframe[^>]*id=['\"]sheet-music-viewer['\"][^>]*src=['\"]([^'\"]+)['\"]", html, flags=re.S | re.I)
    sheet_url = None
    if sheet_m:
        s_src = html_lib.unescape(sheet_m.group(1).strip())
        sheet_url = s_src if s_src.startswith("http") else f"https://sairhythms.sathyasai.org{s_src}"

    glossary: list[dict[str, str]] = []
    for gm in re.finditer(
        r"devotional-song-glossary-term[^>]*>\s*<a[^>]*>(.*?)</a>\s*</div>\s*"
        r"<div class='devotional-song-glossary-term-description[^>]*>(.*?)</div>",
        html,
        flags=re.S | re.I,
    ):
        term = strip_tags(gm.group(1)).rstrip(":")
        desc = strip_tags(gm.group(2))
        if term and desc:
            glossary.append({"term": term, "description": desc})

    recordings: list[dict[str, Any]] = []
    if audio_url:
        recordings.append(
            {
                "id": make_recording_id("sair", audio_url),
                "label": f"Sai Rhythms Reference Audio ({slug}.mp3)",
                "collection": "sairhythms_ref",
                "externalUrl": audio_url,
            }
        )

    return {
        "id": slug,
        "slug": slug,
        "title": title,
        "deity": deity,
        "language": language,
        "raga": {
            "name": raga_name or "Traditional",
            "arohanam": arohanam or None,
            "avarohanam": avarohanam or None,
            "westernInC": western_c or None,
        },
        "beat": beat,
        "tempo": tempo,
        "level": level or None,
        "gentsPitch": parse_pitch_info(pitches.get("gents", "2 Pancham / D"), 2),
        "ladiesPitch": parse_pitch_info(pitches.get("ladies", "6 Pancham / A"), 9),
        "firstLineNotes": (
            {"sargam": pitches.get("first_sargam"), "westernInC": pitches.get("first_western")}
            if pitches.get("first_sargam") or pitches.get("first_western")
            else None
        ),
        "notesRange": pitches.get("notes_range") or None,
        "meaning": meaning or None,
        "lyricsSets": lyrics_sets
        or [
            {
                "language": "Sanskrit / Hindi",
                "script": "roman",
                "lines": [title],
            }
        ],
        "glossary": glossary,
        "recordings": recordings,
        "sheetMusicUrl": sheet_url,
        "sourceUrl": f"https://sairhythms.sathyasai.org/song/{slug}",
        "metadataSource": "sairhythms_verified",
    }


def match_local_to_bhajan(local_tokens: tuple[str, ...], candidate_tokens_list: list[tuple[int, tuple[str, ...]]]) -> int | None:
    best_idx = None
    best_score = 0
    for idx, ctoks in candidate_tokens_list:
        if not ctoks or not local_tokens:
            continue
        if local_tokens == ctoks:
            return idx
        shorter, longer = (local_tokens, ctoks) if len(local_tokens) <= len(ctoks) else (ctoks, local_tokens)
        if len(shorter) >= 3 and longer[: len(shorter)] == shorter:
            score = len(shorter) * 10
            if score > best_score:
                best_score = score
                best_idx = idx
    return best_idx


def build_catalog(slugs: list[str], refresh: bool = False) -> dict[str, Any]:
    local_items, counts = scan_local_archives()
    verified_bhajans: list[dict[str, Any]] = []

    for slug in slugs:
        html = fetch_sairhythms_html(slug, refresh=refresh)
        if not html:
            continue
        parsed = parse_sairhythms_song(slug, html)
        if parsed:
            verified_bhajans.append(parsed)

    verified_tokens = [(idx, normalize_tokens(b["title"])) for idx, b in enumerate(verified_bhajans)]
    local_groups: list[dict[str, Any]] = []
    local_tokens: list[tuple[int, tuple[str, ...]]] = []

    for item in local_items:
        v_match = match_local_to_bhajan(item["tokens"], verified_tokens)
        if v_match is not None:
            # Prefer local recordings at front of recordings list
            verified_bhajans[v_match]["recordings"].insert(0, item["recording"])
            continue

        l_match = match_local_to_bhajan(item["tokens"], local_tokens)
        if l_match is not None:
            local_groups[l_match]["recordings"].append(item["recording"])
            # Keep shorter cleaner canonical title if shorter >= 3 words
            if len(item["title"]) < len(local_groups[l_match]["title"]) and len(item["tokens"]) >= 3:
                local_groups[l_match]["title"] = item["title"]
            continue

        slug = item["slug"]
        # Ensure unique ID if slug collides
        existing_ids = {b["id"] for b in verified_bhajans} | {b["id"] for b in local_groups}
        if slug in existing_ids:
            slug = f"{slug}-{item['recording']['id'][-4:]}"

        idx = len(local_groups)
        title = item["title"]
        local_groups.append(
            {
                "id": slug,
                "slug": slug,
                "title": title,
                "deity": infer_deity(title),
                "language": "Sanskrit / Hindi",
                "raga": {"name": "Pending Sai Rhythms Sync"},
                "beat": "8 Beat / Keherwa (Est.)",
                "tempo": "Medium",
                "meaning": "Synced from local SSS Media Centre / RaviMp3 archive. Click 'Suggest Lyrics Correction' to enrich lyrics & notation.",
                "gentsPitch": parse_pitch_info("2 Pancham / D", 2),
                "ladiesPitch": parse_pitch_info("6 Pancham / A", 9),
                "lyricsSets": [
                    {
                        "language": "Roman (Title Seed)",
                        "script": "roman",
                        "lines": [
                            title,
                            "(Full verses awaiting Sai Rhythms sync or community submission)",
                        ],
                    }
                ],
                "glossary": [],
                "recordings": [item["recording"]],
                "metadataSource": "local_inferred",
            }
        )
        local_tokens.append((idx, item["tokens"]))

    local_groups.sort(key=lambda b: (-len(b["recordings"]), b["title"].lower()))
    all_bhajans = verified_bhajans + local_groups

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "stats": {
            "totalBhajans": len(all_bhajans),
            "verifiedSaiRhythmsCount": len(verified_bhajans),
            "totalLocalRecordings": counts["totalLocalRecordings"],
            "bhajanDownloaderCount": counts["bhajanDownloaderCount"],
            "raviMp3Count": counts["raviMp3Count"],
        },
        "bhajans": all_bhajans,
    }
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Build unified bhaJami catalog from local MP3s + Sai Rhythms")
    parser.add_argument("--slugs", type=str, default=",".join(DEFAULT_PILOT_SLUGS), help="Comma-separated Sai Rhythms slugs")
    parser.add_argument("--refresh", action="store_true", help="Ignore HTML disk cache and re-fetch")
    args = parser.parse_args()

    slugs = [s.strip() for s in args.slugs.split(",") if s.strip()]
    payload = build_catalog(slugs, refresh=args.refresh)
    OUT_CATALOG.parent.mkdir(parents=True, exist_ok=True)
    OUT_CATALOG.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(payload["stats"], indent=2))


if __name__ == "__main__":
    main()
