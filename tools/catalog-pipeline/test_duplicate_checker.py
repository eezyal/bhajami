from __future__ import annotations

import sys
from pathlib import Path
import unittest

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import check_duplicates as dc  # noqa: E402
import phonetics  # noqa: E402


def _make_doc(
    doc_id: str,
    title: str,
    *,
    metadata_source: str = "sairhythms_verified",
    lines: list[str] | None = None,
    recordings: list[dict] | None = None,
    slug_aliases: list[str] | None = None,
    bhajami_override: bool = False,
) -> dict:
    return {
        "id": doc_id,
        "slug": doc_id,
        "title": title,
        "metadataSource": metadata_source,
        "bhajamiOverride": bhajami_override,
        "lyricsSets": (
            [{"language": "Roman", "script": "roman", "lines": lines}] if lines else []
        ),
        "recordings": recordings or [],
        "slugAliases": slug_aliases or [],
    }


class DuplicateCheckerTests(unittest.TestCase):
    def test_edit_proximity_and_phonetic_near_duplicate_caught(self) -> None:
        prox, dist = dc.edit_proximity("sundara vinayaka", "sundara vinaayaka")
        self.assertGreater(prox, 0.85)
        self.assertEqual(dist, 1)

        docs = [
            _make_doc(
                "shiva-shambho-mahadeva",
                "Shiva Shambho Mahadeva",
                metadata_source="sairhythms_verified",
                lines=[
                    "Shiva Shambho Mahadeva",
                    "Gangaadhara Hara Gauri Shiva",
                    "Nandi Vahana Naaga Bhooshana",
                ],
                recordings=[{"id": "rec_sr_1", "collection": "sairhythms_ref"}],
            ),
            _make_doc(
                "yt_siva_sambo",
                "Siva Sambo Mahadeva | Prasanthi Mandir Live",
                metadata_source="youtube_sss_bhajans",
                lines=[],
                recordings=[{"id": "yt_1", "collection": "youtube_sss_bhajans", "youtubeVideoId": "yt1"}],
            ),
        ]

        report = dc.scan_catalog_duplicates(docs, min_score=0.78)
        self.assertEqual(report["flaggedPairs"], 1)
        pair = report["pairs"][0]
        self.assertEqual(pair["targetId"], "shiva-shambho-mahadeva")
        self.assertEqual(pair["sourceId"], "yt_siva_sambo")
        self.assertGreaterEqual(pair["score"], 0.78)

    def test_full_lyrics_veto_prevents_merging_distinct_bhajans_sharing_opening_line(self) -> None:
        docs = [
            _make_doc(
                "subrahmanyam-one",
                "Subrahmanyam Subrahmanyam",
                lines=[
                    "Subrahmanyam Subrahmanyam",
                    "Shanmukhanatha Subrahmanyam",
                    "Shiva Shiva Shiva Shiva Subrahmanyam",
                    "Hara Hara Hara Hara Subrahmanyam",
                ],
            ),
            _make_doc(
                "subrahmanyam-two",
                "Subrahmanyam Subrahmanyam",
                metadata_source="sssmediacentre_verified",
                lines=[
                    "Subrahmanyam Subrahmanyam",
                    "Valli Manohara Subrahmanyam",
                    "Mayoora Vahana Subrahmanyam",
                    "Palani Andava Subrahmanyam",
                ],
            ),
        ]

        report = dc.scan_catalog_duplicates(docs, min_score=0.78)
        self.assertEqual(report["flaggedPairs"], 0)
        self.assertGreaterEqual(report["vetoedDifferentLyrics"], 1)

    def test_lyrics_confirmed_cross_title_duplicate_is_caught(self) -> None:
        shared_lines = [
            "Manasa Bhajare Guru Charanam",
            "Dusthara Bhava Sagara Tharanam",
            "Guru Maharaj Guru Jai Jai",
            "Sai Natha Sadguru Jai Jai",
        ]
        docs = [
            _make_doc(
                "manasa-bhajare-guru-charanam",
                "Manasa Bhajare Guru Charanam",
                metadata_source="sairhythms_verified",
                lines=shared_lines,
            ),
            _make_doc(
                "yt_guru_maharaj",
                "Manasa Bhajarey Guru Charanam Sai Baba",
                metadata_source="youtube_prasanthi_mandir_live",
                lines=shared_lines,
                recordings=[{"id": "yt_g1", "youtubeVideoId": "g1"}],
            ),
        ]

        report = dc.scan_catalog_duplicates(docs, min_score=0.78)
        self.assertEqual(report["flaggedPairs"], 1)
        self.assertEqual(report["pairs"][0]["targetId"], "manasa-bhajare-guru-charanam")
        self.assertEqual(report["pairs"][0]["sourceId"], "yt_guru_maharaj")

    def test_respects_do_not_merge_pairs_and_slug_aliases_and_instrumental_veto(self) -> None:
        docs = [
            _make_doc("song-a", "Govinda Krishna Jai", metadata_source="sairhythms_verified"),
            _make_doc("song-b", "Govinda Krishna Jai", metadata_source="youtube_sss_bhajans"),
            _make_doc(
                "song-c",
                "Govinda Krishna Jai",
                metadata_source="youtube_sss_bhajans",
                slug_aliases=["song-a"],
            ),
            _make_doc(
                "song-instr",
                "Govinda Krishna Jai (Veena Instrumental)",
                metadata_source="youtube_sss_bhajans",
            ),
        ]
        dnm = [phonetics.make_do_not_merge_key("song-a", "song-b")]

        report = dc.scan_catalog_duplicates(docs, do_not_merge_pairs=dnm, min_score=0.78)
        # song-a vs song-b blocked by doNotMergePairs; song-c aliased to song-a; song-instr vetoed vs vocals.
        # Only song-b vs song-c (two vocal YouTube stubs) remains unblocked.
        flagged_pairs = {(p["targetId"], p["sourceId"]) for p in report["pairs"]}
        self.assertNotIn(("song-a", "song-b"), flagged_pairs)
        self.assertNotIn(("song-a", "song-c"), flagged_pairs)
        self.assertFalse(any("song-instr" in pair for pair in flagged_pairs))
        self.assertGreaterEqual(report["skippedDoNotMerge"], 1)
        self.assertGreaterEqual(report["skippedAliased"], 1)


if __name__ == "__main__":
    unittest.main()
