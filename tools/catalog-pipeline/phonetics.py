from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Sequence

_SPEC_PATH = Path(__file__).resolve().parents[2] / "packages/shared/data/indic-phonetics.json"
with _SPEC_PATH.open("r", encoding="utf-8") as _f:
    _SPEC = json.load(_f)

THRESHOLDS: dict[str, float] = _SPEC["thresholds"]
SCHWA_FOLD_PENALTY: float = float(_SPEC["schwaFoldPenalty"])
_DIACRITIC_MAP: dict[str, str] = _SPEC["diacriticMap"]
_IDF_WEIGHTS: dict[str, float] = _SPEC["idfWeights"]
_TOKEN_ALIASES: dict[str, str] = _SPEC.get("tokenAliases", {})
_NASAL_EXCEPTIONS: set[str] = set(_SPEC["nasalStemExceptions"])
_DEFAULT_EDIT: float = float(_SPEC["substitutionCosts"]["defaultEdit"])
_LYRICS_WEIGHTS: dict[str, float] = _SPEC["lyricsWeights"]

_LEADING_NUM_RE = re.compile(_SPEC["sanitizer"]["leadingNumberRegex"])
_PIPE_SUFFIX_RES = [
    re.compile(pat, re.IGNORECASE) for pat in _SPEC["sanitizer"]["pipeSuffixRegexes"]
]
_HASHTAG_RE = re.compile(_SPEC["sanitizer"]["hashtagRegex"])
_BRACKETED_TAG_RE = re.compile(_SPEC["sanitizer"]["bracketedTagRegex"], re.IGNORECASE)
_TRAILING_TAG_RE = re.compile(_SPEC["sanitizer"]["trailingTagRegex"], re.IGNORECASE)
_REPETITION_RE = re.compile(_SPEC["repetitionRegex"], re.IGNORECASE)
_PUNCTUATION_RE = re.compile(_SPEC["punctuationRegex"])
_VOWEL_CONSONANT_RES = [
    (re.compile(pat), repl) for pat, repl in _SPEC["vowelAndConsonantRules"]
]
_COLLAPSE_CONSONANT_RE = re.compile(_SPEC["collapseDoubledConsonantsRegex"])

_INTERIOR_VOWEL_COSTS: dict[tuple[str, str], float] = {}
for _a, _b, _c in _SPEC["substitutionCosts"]["interiorVowelPairs"]:
    _INTERIOR_VOWEL_COSTS[(_a, _b)] = float(_c)
    _INTERIOR_VOWEL_COSTS[(_b, _a)] = float(_c)

_SINGLE_CHAR_COSTS: dict[tuple[str, str], float] = {}
for _a, _b, _c in _SPEC["substitutionCosts"]["singleCharPairs"]:
    _SINGLE_CHAR_COSTS[(_a, _b)] = float(_c)
    _SINGLE_CHAR_COSTS[(_b, _a)] = float(_c)

_DIGRAPH_TRANSITIONS: list[tuple[str, str, float]] = []
for _a, _b, _c in _SPEC["substitutionCosts"]["digraphPairs"]:
    _DIGRAPH_TRANSITIONS.append((str(_a), str(_b), float(_c)))
    _DIGRAPH_TRANSITIONS.append((str(_b), str(_a), float(_c)))


@dataclass(frozen=True)
class CanonicalWordResult:
    canonical: str
    schwa_folded: bool


def sanitize_title(raw_title: str) -> str:
    s = unicodedata.normalize("NFKC", str(raw_title or "")).strip()
    s = _HASHTAG_RE.sub(" ", s)
    for regex in _PIPE_SUFFIX_RES:
        s = regex.sub(" ", s)
    s = _BRACKETED_TAG_RE.sub(" ", s)
    s = _LEADING_NUM_RE.sub("", s)
    prev = None
    while prev != s:
        prev = s
        s = _TRAILING_TAG_RE.sub("", s).strip()
    return re.sub(r"\s+", " ", s).strip()


def _fold_diacritics_and_punct(text: str) -> str:
    lower = unicodedata.normalize("NFKC", text).lower()
    mapped = "".join(_DIACRITIC_MAP.get(ch, ch) for ch in lower)
    cleaned = _PUNCTUATION_RE.sub(" ", mapped)
    return re.sub(r"\s+", " ", cleaned).strip()


def canonicalize_sanskrit_word_detailed(raw_word: str) -> CanonicalWordResult:
    w = re.sub(r"\s+", "", _fold_diacritics_and_punct(raw_word))
    if not w:
        return CanonicalWordResult(canonical="", schwa_folded=False)

    for regex, repl in _VOWEL_CONSONANT_RES:
        w = regex.sub(repl, w)
    w = _COLLAPSE_CONSONANT_RE.sub(r"\1", w)

    if w in _TOKEN_ALIASES:
        w = _TOKEN_ALIASES[w]

    if w.endswith("a") and len(w) > 2:
        stem = w[:-1]
        if stem in _NASAL_EXCEPTIONS:
            return CanonicalWordResult(canonical=stem, schwa_folded=True)

    return CanonicalWordResult(canonical=w, schwa_folded=False)


def canonicalize_sanskrit_word(raw_word: str) -> str:
    return canonicalize_sanskrit_word_detailed(raw_word).canonical


def canonicalize_phrase(raw_text: str) -> str:
    cleaned = _fold_diacritics_and_punct(sanitize_title(raw_text))
    if not cleaned:
        return ""
    tokens = [canonicalize_sanskrit_word(tok) for tok in cleaned.split()]
    return " ".join(tok for tok in tokens if tok)


def _tokenize_phrase_detailed(raw_text: str) -> list[CanonicalWordResult]:
    cleaned = _fold_diacritics_and_punct(sanitize_title(raw_text))
    if not cleaned:
        return []
    out: list[CanonicalWordResult] = []
    for tok in cleaned.split():
        res = canonicalize_sanskrit_word_detailed(tok)
        if res.canonical:
            out.append(res)
    return out


def _weighted_word_distance(res_a: CanonicalWordResult, res_b: CanonicalWordResult) -> float:
    a = res_a.canonical
    b = res_b.canonical
    m = len(a)
    n = len(b)
    if m == 0 and n == 0:
        return 0.0

    dp = [[math.inf] * (n + 1) for _ in range(m + 1)]
    dp[0][0] = 0.0

    for i in range(m + 1):
        for j in range(n + 1):
            cur = dp[i][j]
            if i < m and cur + _DEFAULT_EDIT < dp[i + 1][j]:
                dp[i + 1][j] = cur + _DEFAULT_EDIT
            if j < n and cur + _DEFAULT_EDIT < dp[i][j + 1]:
                dp[i][j + 1] = cur + _DEFAULT_EDIT
            if i < m and j < n:
                ca = a[i]
                cb = b[j]
                if ca == cb:
                    sub_cost = 0.0
                elif i < m - 1 and j < n - 1 and (ca, cb) in _INTERIOR_VOWEL_COSTS:
                    sub_cost = _INTERIOR_VOWEL_COSTS[(ca, cb)]
                elif (ca, cb) in _SINGLE_CHAR_COSTS:
                    sub_cost = _SINGLE_CHAR_COSTS[(ca, cb)]
                else:
                    sub_cost = _DEFAULT_EDIT
                if cur + sub_cost < dp[i + 1][j + 1]:
                    dp[i + 1][j + 1] = cur + sub_cost

            for f_str, t_str, t_cost in _DIGRAPH_TRANSITIONS:
                lf = len(f_str)
                lt = len(t_str)
                if (
                    i + lf <= m
                    and j + lt <= n
                    and a[i : i + lf] == f_str
                    and b[j : j + lt] == t_str
                    and cur + t_cost < dp[i + lf][j + lt]
                ):
                    dp[i + lf][j + lt] = cur + t_cost

    dist = dp[m][n]
    if res_a.schwa_folded != res_b.schwa_folded:
        dist += SCHWA_FOLD_PENALTY
    return dist


def _normalized_word_sim_from_results(
    res_a: CanonicalWordResult, res_b: CanonicalWordResult
) -> float:
    if not res_a.canonical and not res_b.canonical:
        return 1.0
    max_len = max(len(res_a.canonical), len(res_b.canonical), 1)
    dist = _weighted_word_distance(res_a, res_b)
    return max(0.0, 1.0 - dist / max_len)


def normalized_word_sim(word_a: str, word_b: str) -> float:
    return _normalized_word_sim_from_results(
        canonicalize_sanskrit_word_detailed(word_a),
        canonicalize_sanskrit_word_detailed(word_b),
    )


def _get_idf_weight(canonical_token: str) -> float:
    return float(_IDF_WEIGHTS.get(canonical_token, 1.0))


def compute_title_similarity(title_a: str, title_b: str) -> float:
    toks_a = _tokenize_phrase_detailed(title_a)
    toks_b = _tokenize_phrase_detailed(title_b)
    if not toks_a and not toks_b:
        return 1.0
    if not toks_a or not toks_b:
        return 0.0

    pairs: list[tuple[float, float, int, int]] = []
    for i, ta in enumerate(toks_a):
        for j, tb in enumerate(toks_b):
            sim = _normalized_word_sim_from_results(ta, tb)
            weight = max(_get_idf_weight(ta.canonical), _get_idf_weight(tb.canonical))
            pairs.append((sim, weight, i, j))

    pairs.sort(key=lambda item: (-item[0], -item[1], item[2], item[3]))

    used_a: set[int] = set()
    used_b: set[int] = set()
    matched_weighted_sum = 0.0
    total_weight_sum = 0.0

    for sim, weight, i, j in pairs:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        matched_weighted_sum += weight * sim
        total_weight_sum += weight

    for i, ta in enumerate(toks_a):
        if i not in used_a:
            total_weight_sum += _get_idf_weight(ta.canonical)
    for j, tb in enumerate(toks_b):
        if j not in used_b:
            total_weight_sum += _get_idf_weight(tb.canonical)

    return matched_weighted_sum / total_weight_sum if total_weight_sum > 0 else 0.0


def _jaccard_similarity(set_a: set[str], set_b: set[str]) -> float:
    if not set_a and not set_b:
        return 1.0
    if not set_a or not set_b:
        return 0.0
    inter = len(set_a & set_b)
    union = len(set_a | set_b)
    return inter / union if union > 0 else 0.0


def _build_char_4grams(text: str) -> set[str]:
    compact = re.sub(r"\s+", " ", text).strip()
    if not compact:
        return set()
    if len(compact) < 4:
        return {compact}
    return {compact[i : i + 4] for i in range(len(compact) - 3)}


def _line_set_jaccard_phonetic(norm_a: Sequence[str], norm_b: Sequence[str]) -> float:
    uniq_a = sorted(set(norm_a))
    uniq_b = sorted(set(norm_b))
    if not uniq_a and not uniq_b:
        return 1.0
    if not uniq_a or not uniq_b:
        return 0.0

    set_b = set(uniq_b)
    rem_a: list[str] = []
    matched_b: set[str] = set()
    matches = 0

    for la in uniq_a:
        if la in set_b and la not in matched_b:
            matched_b.add(la)
            matches += 1
        else:
            rem_a.append(la)
    rem_b = [lb for lb in uniq_b if lb not in matched_b]

    fuzzy_pairs: list[tuple[float, str, str, int, int]] = []
    for ia, la in enumerate(rem_a):
        for ib, lb in enumerate(rem_b):
            sim = compute_title_similarity(la, lb)
            if sim >= THRESHOLDS["autoMerge"]:
                fuzzy_pairs.append(
                    (sim, min(la, lb), max(la, lb), ia, ib)
                )

    fuzzy_pairs.sort(key=lambda item: (-item[0], item[1], item[2]))
    used_a: set[int] = set()
    used_b: set[int] = set()
    for _, _, _, ia, ib in fuzzy_pairs:
        if ia in used_a or ib in used_b:
            continue
        used_a.add(ia)
        used_b.add(ib)
        matches += 1

    union = len(uniq_a) + len(uniq_b) - matches
    return matches / union if union > 0 else 0.0


def compute_lyrics_overlap(lines_a: Sequence[str], lines_b: Sequence[str]) -> float:
    def _clean(lines: Sequence[str]) -> list[str]:
        out: list[str] = []
        for line in lines:
            c = canonicalize_phrase(_REPETITION_RE.sub(" ", line))
            if c:
                out.append(c)
        return out

    norm_a = _clean(lines_a)
    norm_b = _clean(lines_b)
    if not norm_a or not norm_b:
        return 0.0

    line_jaccard = _line_set_jaccard_phonetic(norm_a, norm_b)
    gram_jaccard = _jaccard_similarity(
        _build_char_4grams(" ".join(norm_a)),
        _build_char_4grams(" ".join(norm_b)),
    )
    return (
        float(_LYRICS_WEIGHTS["lineJaccard"]) * line_jaccard
        + float(_LYRICS_WEIGHTS["char4gramJaccard"]) * gram_jaccard
    )


def make_do_not_merge_key(entity_a: str, entity_b: str) -> str:
    a = str(entity_a or "").strip()
    b = str(entity_b or "").strip()
    return f"{a}__{b}" if a <= b else f"{b}__{a}"


def evaluate_match_candidate(
    query_title: str,
    candidates: Sequence[Mapping[str, object]],
    *,
    query_lyrics: Sequence[str] | None = None,
    query_id: str | None = None,
    entity_aliases: Mapping[str, str] | None = None,
    do_not_merge_pairs: Iterable[str] | None = None,
) -> dict[str, object]:
    sanitized = sanitize_title(query_title)
    canonical = canonicalize_phrase(sanitized)
    blocked_set = set(do_not_merge_pairs or ())

    def _is_blocked(target_id: str) -> bool:
        if query_id and make_do_not_merge_key(query_id, target_id) in blocked_set:
            return True
        if canonical and make_do_not_merge_key(canonical, target_id) in blocked_set:
            return True
        return False

    if canonical and entity_aliases and canonical in entity_aliases:
        alias_target = entity_aliases[canonical]
        if not _is_blocked(alias_target):
            target_rec = next((c for c in candidates if c.get("id") == alias_target), None)
            target_title = str(target_rec.get("title", alias_target)) if target_rec else alias_target
            return {
                "sanitizedTitle": sanitized,
                "canonicalPhrase": canonical,
                "matchStatus": "verified",
                "bestTargetId": alias_target,
                "bestScore": 1.0,
                "reason": "entity_alias",
                "matchCandidates": [
                    {
                        "targetBhajanId": alias_target,
                        "targetTitle": target_title,
                        "score": 1.0,
                        "reason": "entity_alias",
                    }
                ],
            }

    non_empty_query_lyrics = [str(l).strip() for l in (query_lyrics or []) if str(l).strip()]
    scored: list[dict[str, object]] = []

    for cand in candidates:
        cand_id = str(cand.get("id", ""))
        cand_title = str(cand.get("title", ""))
        if _is_blocked(cand_id):
            continue

        title_sim = compute_title_similarity(sanitized, cand_title)
        raw_cand_lyrics = cand.get("lyricsLines") or ()
        non_empty_cand_lyrics = [
            str(l).strip() for l in raw_cand_lyrics if str(l).strip()  # type: ignore[union-attr]
        ]

        lyrics_overlap: float | None = None
        effective_score = title_sim
        reason = "title_similarity"

        if len(non_empty_query_lyrics) >= 2 and len(non_empty_cand_lyrics) >= 2:
            lyrics_overlap = compute_lyrics_overlap(non_empty_query_lyrics, non_empty_cand_lyrics)
            if lyrics_overlap >= THRESHOLDS["lyricsOverlapMin"]:
                effective_score = max(title_sim, lyrics_overlap)
                reason = "lyrics_confirmed"
            else:
                reason = (
                    "lyrics_mismatch"
                    if title_sim >= THRESHOLDS["autoMerge"]
                    else "lyrics_low_overlap"
                )

        entry: dict[str, object] = {
            "targetBhajanId": cand_id,
            "targetTitle": cand_title,
            "score": effective_score,
            "reason": reason,
        }
        if lyrics_overlap is not None:
            entry["lyricsOverlap"] = lyrics_overlap
        scored.append(entry)

    scored.sort(key=lambda item: (-float(item["score"]), str(item["targetBhajanId"])))

    if not scored:
        return {
            "sanitizedTitle": sanitized,
            "canonicalPhrase": canonical,
            "matchStatus": "unmatched",
            "bestTargetId": None,
            "bestScore": 0.0,
            "reason": "do_not_merge_excluded" if candidates else "no_candidates",
            "matchCandidates": [],
        }

    best = scored[0]
    best_score = float(best["score"])
    best_id = str(best["targetBhajanId"])
    top_candidates = [
        c for idx, c in enumerate(scored) if idx == 0 or float(c["score"]) >= THRESHOLDS["reviewMin"]
    ][:5]

    if best["reason"] == "lyrics_confirmed" and best_score >= THRESHOLDS["reviewMin"]:
        competing = any(
            str(c["targetBhajanId"]) != best_id
            and c["reason"] == "lyrics_confirmed"
            and float(c["score"]) >= THRESHOLDS["autoMerge"]
            and best_score >= THRESHOLDS["autoMerge"]
            for c in scored[1:]
        )
        if competing:
            return {
                "sanitizedTitle": sanitized,
                "canonicalPhrase": canonical,
                "matchStatus": "needs_verification",
                "bestTargetId": best_id,
                "bestScore": best_score,
                "reason": "ambiguous_title",
                "matchCandidates": top_candidates,
            }
        return {
            "sanitizedTitle": sanitized,
            "canonicalPhrase": canonical,
            "matchStatus": "verified",
            "bestTargetId": best_id,
            "bestScore": best_score,
            "reason": "lyrics_confirmed",
            "matchCandidates": top_candidates,
        }

    if best["reason"] == "lyrics_mismatch":
        return {
            "sanitizedTitle": sanitized,
            "canonicalPhrase": canonical,
            "matchStatus": "needs_verification",
            "bestTargetId": best_id,
            "bestScore": best_score,
            "reason": "lyrics_mismatch",
            "matchCandidates": top_candidates,
        }

    if best_score >= THRESHOLDS["autoMerge"]:
        duplicate_high = any(
            str(c["targetBhajanId"]) != best_id and float(c["score"]) >= THRESHOLDS["autoMerge"]
            for c in scored[1:]
        )
        if duplicate_high:
            return {
                "sanitizedTitle": sanitized,
                "canonicalPhrase": canonical,
                "matchStatus": "needs_verification",
                "bestTargetId": best_id,
                "bestScore": best_score,
                "reason": "ambiguous_title",
                "matchCandidates": top_candidates,
            }
        return {
            "sanitizedTitle": sanitized,
            "canonicalPhrase": canonical,
            "matchStatus": "verified",
            "bestTargetId": best_id,
            "bestScore": best_score,
            "reason": "high_confidence_title",
            "matchCandidates": top_candidates,
        }

    if best_score >= THRESHOLDS["reviewMin"]:
        return {
            "sanitizedTitle": sanitized,
            "canonicalPhrase": canonical,
            "matchStatus": "needs_verification",
            "bestTargetId": best_id,
            "bestScore": best_score,
            "reason": "lyrics_mismatch" if best["reason"] == "lyrics_low_overlap" else "doubt_band",
            "matchCandidates": top_candidates,
        }

    return {
        "sanitizedTitle": sanitized,
        "canonicalPhrase": canonical,
        "matchStatus": "unmatched",
        "bestTargetId": None,
        "bestScore": best_score,
        "reason": "below_threshold",
        "matchCandidates": [],
    }
