from __future__ import annotations

import json
import unittest
from pathlib import Path

from phonetics import (
    canonicalize_sanskrit_word_detailed,
    compute_lyrics_overlap,
    compute_title_similarity,
    evaluate_match_candidate,
    normalized_word_sim,
    sanitize_title,
)

PARITY_EPSILON = 1e-9
GOLDEN_PATH = (
    Path(__file__).resolve().parents[2] / "packages/shared/tests/phonetic-golden.json"
)
with GOLDEN_PATH.open("r", encoding="utf-8") as _f:
    GOLDEN = json.load(_f)


class TestPhoneticsGoldenParity(unittest.TestCase):
    def test_minimum_golden_vector_count(self) -> None:
        total = (
            len(GOLDEN["wordCanonical"])
            + len(GOLDEN["sanitize"])
            + len(GOLDEN["wordPair"])
            + len(GOLDEN["titleSimilarity"])
            + len(GOLDEN["lyricsOverlap"])
            + len(GOLDEN["evaluateMatch"])
        )
        self.assertGreaterEqual(total, 100)

    def test_word_canonicalization(self) -> None:
        for v in GOLDEN["wordCanonical"]:
            actual = canonicalize_sanskrit_word_detailed(v["input"])
            self.assertEqual(actual.canonical, v["expectedCanonical"], v["input"])
            self.assertEqual(actual.schwa_folded, v["expectedSchwaFolded"], v["input"])

    def test_sanitize_title(self) -> None:
        for v in GOLDEN["sanitize"]:
            self.assertEqual(sanitize_title(v["raw"]), v["expected"], v["raw"])

    def test_word_pair_similarity(self) -> None:
        for v in GOLDEN["wordPair"]:
            score = normalized_word_sim(v["a"], v["b"])
            if "minScore" in v:
                self.assertGreaterEqual(score, v["minScore"], f"{v['a']} ~ {v['b']}")
            if "maxScore" in v:
                self.assertLessEqual(score, v["maxScore"], f"{v['a']} ~ {v['b']}")
            if "expectedScore" in v:
                self.assertLessEqual(
                    abs(score - v["expectedScore"]),
                    PARITY_EPSILON,
                    f"{v['a']} ~ {v['b']}: expected {v['expectedScore']}, got {score}",
                )

    def test_title_similarity(self) -> None:
        for v in GOLDEN["titleSimilarity"]:
            score = compute_title_similarity(v["a"], v["b"])
            if "minScore" in v:
                self.assertGreaterEqual(score, v["minScore"], f"{v['a']} vs {v['b']}")
            if "maxScore" in v:
                self.assertLessEqual(score, v["maxScore"], f"{v['a']} vs {v['b']}")
            if "expectedScore" in v:
                self.assertLessEqual(
                    abs(score - v["expectedScore"]),
                    PARITY_EPSILON,
                    f"{v['a']} vs {v['b']}: expected {v['expectedScore']}, got {score}",
                )

    def test_lyrics_overlap(self) -> None:
        for v in GOLDEN["lyricsOverlap"]:
            score = compute_lyrics_overlap(v["linesA"], v["linesB"])
            if "minScore" in v:
                self.assertGreaterEqual(score, v["minScore"])
            if "maxScore" in v:
                self.assertLessEqual(score, v["maxScore"])
            if "expectedScore" in v:
                self.assertLessEqual(
                    abs(score - v["expectedScore"]),
                    PARITY_EPSILON,
                    f"expected {v['expectedScore']}, got {score}",
                )

    def test_evaluate_match_candidate(self) -> None:
        for v in GOLDEN["evaluateMatch"]:
            result = evaluate_match_candidate(
                v["queryTitle"],
                v["candidates"],
                query_lyrics=v.get("queryLyrics"),
                query_id=v.get("queryId"),
                entity_aliases=v.get("entityAliases"),
                do_not_merge_pairs=v.get("doNotMergePairs"),
            )
            self.assertEqual(result["matchStatus"], v["expectedStatus"], v["name"])
            self.assertEqual(result["bestTargetId"], v["expectedBestTargetId"], v["name"])
            if "expectedReason" in v:
                self.assertEqual(result["reason"], v["expectedReason"], v["name"])
            if "expectedScore" in v:
                self.assertLessEqual(
                    abs(float(result["bestScore"]) - v["expectedScore"]),
                    PARITY_EPSILON,
                    f"{v['name']} expected {v['expectedScore']}, got {result['bestScore']}",
                )


if __name__ == "__main__":
    unittest.main()
