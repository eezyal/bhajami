#!/usr/bin/env python3
"""Offline unit tests for YouTube Data API v3 classification, lyrics parsing, and two-pass matching."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import sync_youtube as yt  # noqa: E402

FIXTURE_PATH = SCRIPT_DIR / "fixtures" / "youtube_samples.json"
FIXTURE_DATA = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


class YouTubeClassifierAndTwoPassTests(unittest.TestCase):
    def setUp(self) -> None:
        self.candidates = [
            {
                "id": "sundara-sundara-vinayaka",
                "title": "Sundara Sundara Vinayaka",
                "lyricsLines": [
                    "Sundara Sundara Vinayaka",
                    "Shubha Mangala Dayaka Vinayaka",
                ],
            },
            {
                "id": "aao-aao-nandalala",
                "title": "Aao Aao Nandalala",
                "lyricsLines": [
                    "Aao Aao Nandalala",
                    "Sundara Mukha Gopaala",
                ],
            },
            {
                "id": "arunachala-shiva",
                "title": "Arunachala Shiva",
                "lyricsLines": [
                    "Arunachala Shiva",
                    "Om Namah Shivaya",
                ],
            },
        ]

    def test_parse_iso8601_duration(self) -> None:
        self.assertEqual(yt.parse_iso8601_duration("PT4M15S"), 255)
        self.assertEqual(yt.parse_iso8601_duration("PT1H2M3S"), 3723)
        self.assertEqual(yt.parse_iso8601_duration("PT45S"), 45)
        self.assertEqual(yt.parse_iso8601_duration(""), 0)

    def test_extract_mandir_lyrics_strips_schedule_urls_and_hashtags(self) -> None:
        mandir_video = FIXTURE_DATA["videos"][1]
        lines = yt.extract_mandir_lyrics(mandir_video["rawDescription"])
        self.assertEqual(lines, ["Aao Aao Nandalala", "Sundara Mukha Gopaala"])

    def test_classify_youtube_videos_across_all_variants(self) -> None:
        v_single, _, _, v_vol_explicit, _, v_ambiguous, v_vol_implicit = FIXTURE_DATA["videos"]

        c_single = yt.classify_youtube_video(v_single["rawTitle"], v_single["rawDescription"], v_single["durationSec"])
        self.assertEqual(c_single["classification"], "single")
        self.assertEqual(c_single["cleanedTitle"], "Sundara Sundara Vinayaka")

        c_vol = yt.classify_youtube_video(
            v_vol_explicit["rawTitle"], v_vol_explicit["rawDescription"], v_vol_explicit["durationSec"]
        )
        self.assertEqual(c_vol["classification"], "volume")
        # Intro (0:00), Alap (0:15), and Outro (8:10) excluded, but Sundara stops at Outro (490)
        self.assertEqual(
            c_vol["chapters"],
            [
                {"title": "Sundara Sundara Vinayaka", "startSec": 45, "endSec": 270},
                {"title": "Aao Aao Nandalala", "startSec": 270, "endSec": 490},
            ],
        )

        c_amb = yt.classify_youtube_video(
            v_ambiguous["rawTitle"], v_ambiguous["rawDescription"], v_ambiguous["durationSec"]
        )
        self.assertEqual(c_amb["classification"], "ambiguous_long")

        c_imp = yt.classify_youtube_video(
            v_vol_implicit["rawTitle"], v_vol_implicit["rawDescription"], v_vol_implicit["durationSec"]
        )
        self.assertEqual(c_imp["classification"], "volume")

    def test_two_pass_ingestion_and_bhajami_override_preservation(self) -> None:
        existing_bhajans = {
            "sundara-sundara-vinayaka": {
                "id": "sundara-sundara-vinayaka",
                "slug": "sundara-sundara-vinayaka",
                "title": "Sundara Sundara Vinayaka",
                "deity": "Ganesha",
                "raga": {"name": "Bowli"},
                "beat": "8 Beat",
                "tempo": "Medium",
                "meaning": "Curated meaning stays intact.",
                "lyricsSets": [
                    {
                        "language": "Roman",
                        "script": "roman",
                        "lines": ["Sundara Sundara Vinayaka", "Curated override verse"],
                    }
                ],
                "recordings": [],
                "bhajamiOverride": True,
            },
            "aao-aao-nandalala": {
                "id": "aao-aao-nandalala",
                "slug": "aao-aao-nandalala",
                "title": "Aao Aao Nandalala",
                "recordings": [],
            },
        }

        res = yt.process_youtube_videos(
            FIXTURE_DATA["videos"],
            self.candidates,
            existing_bhajans=existing_bhajans,
            source_key="youtube_sss_bhajans",
            now_iso="2026-11-24T17:30:00Z",
        )

        # Pass 1 single + Pass 2 chapters from embeddable volume attach onto sundara-sundara-vinayaka without overwriting override
        sundara = res["updatedBhajans"]["sundara-sundara-vinayaka"]
        self.assertEqual(sundara["meaning"], "Curated meaning stays intact.")
        self.assertEqual(sundara["lyricsSets"][0]["lines"][1], "Curated override verse")
        sundara_rec_ids = {r["id"] for r in sundara["recordings"]}
        self.assertIn("yt_vidSingleMatch1", sundara_rec_ids)
        self.assertIn("yt_vidVolumeEmbed4_t45", sundara_rec_ids)
        self.assertIn("yt_vidImplicitVolume7_t30", sundara_rec_ids)
        # Non-embeddable volume must NOT attach Pass 2 chapter recordings
        self.assertNotIn("yt_vidVolumeNoEmbed5_t10", sundara_rec_ids)

        # Verify chapter startSec/endSec boundary metadata
        chap_rec = next(r for r in sundara["recordings"] if r["id"] == "yt_vidVolumeEmbed4_t45")
        self.assertEqual(chap_rec["collection"], "youtube_volume_chapter")
        self.assertEqual(chap_rec["startSec"], 45)
        self.assertEqual(chap_rec["endSec"], 270)
        self.assertTrue(chap_rec["embeddable"])

        # Unmatched single creates lyric-less stub with zero synthetic placeholders
        unmatched = res["createdBhajans"]["yt_vidUnmatchedSingle3"]
        self.assertTrue(unmatched["lyricsMissing"])
        self.assertEqual(unmatched["matchStatus"], "unmatched")
        self.assertIsNone(unmatched["gentsPitch"])
        self.assertIsNone(unmatched["meaning"])
        self.assertIn("lyrics", unmatched["missingFields"])

        # > 390s unchaptered single is ambiguous_long -> queued to needs_verification
        amb = res["createdBhajans"]["yt_vidAmbiguousLong6"]
        self.assertEqual(amb["matchStatus"], "needs_verification")
        self.assertEqual(res["youtubeVideos"]["vidAmbiguousLong6"]["classification"], "ambiguous_long")

        # IngestionRun timestamp conforms to strict UTC ISO-8601 format
        self.assertRegex(res["ingestionRun"]["startedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


if __name__ == "__main__":
    unittest.main()
