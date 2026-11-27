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

    def test_candidate_index_shortlists_fast_across_1000_entries(self) -> None:
        import time

        many_candidates = [
            {"id": f"filler-{i}", "title": f"Filler Bhajan Number {i}", "lyricsLines": []}
            for i in range(1000)
        ]
        many_candidates.append(
            {"id": "panduranga-vitthala", "title": "Panduranga Vitthala", "lyricsLines": []}
        )

        start = time.monotonic()
        idx = yt._CandidateIndex(many_candidates)
        shortlisted = idx.shortlist("Panduranga Vittala")
        elapsed = time.monotonic() - start

        self.assertLess(elapsed, 0.5)
        self.assertLessEqual(len(shortlisted), 30)
        self.assertTrue(any(c["id"] == "panduranga-vitthala" for c in shortlisted))

    def test_stub_title_and_metadata_source_resolution(self) -> None:
        import index_builder

        stub = {
            "id": "allah-eshwar-ek-hi-nam",
            "recordings": [
                {
                    "id": "yt_nwTjUoNC54M",
                    "label": "Prasanthi Mandir Live: Allah Eshwar Ek Hi Nam",
                    "collection": "youtube_prasanthi_mandir_live",
                    "youtubeVideoId": "nwTjUoNC54M",
                }
            ],
            "updatedAt": "2026-11-25T01:57:41Z",
        }
        entry = index_builder.project_bhajan_to_index_entry(stub)
        self.assertEqual(entry["title"], "Allah Eshwar Ek Hi Nam")
        self.assertEqual(entry["metadataSource"], "youtube_prasanthi_mandir_live")
        self.assertEqual(entry["recordingCount"], 1)
        self.assertGreater(len(entry["phoneticTokens"]), 0)

        legacy_yt = index_builder._hydrate_firestore_bhajan_doc(
            "012qw0EPVRnPDXiUWepc",
            {
                "title": "160 - Shankara Shankara Sada Shiva | Radio Sai Bhajans",
                "youtubeId": "abc123XYZ",
            },
        )
        legacy_entry = index_builder.project_bhajan_to_index_entry(legacy_yt)
        self.assertEqual(legacy_entry["id"], "012qw0EPVRnPDXiUWepc")
        self.assertEqual(legacy_entry["slug"], "012qw0EPVRnPDXiUWepc")
        self.assertEqual(legacy_entry["recordingCount"], 1)
        self.assertEqual(legacy_entry["metadataSource"], "youtube_channel")
        stats = index_builder.compute_catalog_stats([stub, legacy_yt])
        self.assertEqual(stats["youtubeVideosCount"], 2)
        self.assertEqual(stats["verifiedSaiRhythmsCount"], 0)

    def test_matched_missing_candidate_creates_titled_doc(self) -> None:
        res = yt.process_youtube_videos(
            FIXTURE_DATA["videos"],
            self.candidates,
            existing_bhajans={},
            source_key="youtube_sss_bhajans",
            now_iso="2026-11-25T08:00:00Z",
        )
        matched = res["updatedBhajans"]["sundara-sundara-vinayaka"]
        self.assertEqual(matched["title"], "Sundara Sundara Vinayaka")
        self.assertEqual(matched["slug"], "sundara-sundara-vinayaka")
        self.assertEqual(matched["metadataSource"], "youtube_sss_bhajans")

    def test_clean_youtube_display_title_and_legacy_doc_normalization(self) -> None:
        import index_builder
        import normalize_legacy_youtube_docs as norm

        self.assertEqual(
            yt.clean_youtube_display_title("01 - Hari Bhajan Bina Sukh Shanti Nahin | Sri Sathya Sai Bhajans"),
            "Hari Bhajan Bina Sukh Shanti Nahin",
        )
        self.assertEqual(
            yt.clean_youtube_display_title("160 - Shankara Shankara Sada Shiva | Radio Sai Bhajans"),
            "Shankara Shankara Sada Shiva",
        )
        self.assertEqual(
            yt.clean_youtube_display_title("1022 - Shaila Gireeshwara Uma Maheshwara | Baba Sings | In His Divine Voice | Sri Sathya Sai Bhajans"),
            "Shaila Gireeshwara Uma Maheshwara",
        )
        self.assertEqual(
            yt.clean_youtube_display_title("Kurai Ondrum Illai | Devotional Song | Mystik Vibes | Sai Kulwant Hall"),
            "Kurai Ondrum Illai",
        )

        legacy_raw = {
            "title": "160 - Shankara Shankara Sada Shiva | Radio Sai Bhajans",
            "youtubeId": "ter5U3IX-Zw",
            "lyrics": "Shankara Shankara Sada Shiva\nSada Shiva Hey Samba Shiva",
            "source": "youtube",
            "deity": "Shiva",
        }
        migrated = norm.normalize_bhajan_doc("VoS2fSSmJ8FPBaoJgE7j", legacy_raw, now_iso="2026-11-25T15:55:00Z")
        self.assertIsNotNone(migrated)
        assert migrated is not None
        self.assertEqual(migrated["id"], "VoS2fSSmJ8FPBaoJgE7j")
        self.assertEqual(migrated["slug"], "VoS2fSSmJ8FPBaoJgE7j")
        self.assertEqual(migrated["title"], "Shankara Shankara Sada Shiva")
        self.assertEqual(migrated["metadataSource"], "youtube_sss_bhajans")
        self.assertFalse(migrated["lyricsMissing"])
        self.assertEqual(len(migrated["lyricsSets"][0]["lines"]), 2)
        self.assertEqual(migrated["recordings"][0]["youtubeVideoId"], "ter5U3IX-Zw")
        self.assertTrue(migrated["recordings"][0]["embeddable"])
        self.assertIsNone(norm.normalize_bhajan_doc("VoS2fSSmJ8FPBaoJgE7j", migrated, now_iso="2026-11-25T15:56:00Z"))

        override_doc = {**legacy_raw, "bhajamiOverride": True}
        self.assertIsNone(norm.normalize_bhajan_doc("VoS2fSSmJ8FPBaoJgE7j", override_doc, now_iso="2026-11-25T15:56:00Z"))

        projected = index_builder.project_bhajan_to_index_entry(
            index_builder._hydrate_firestore_bhajan_doc("VoS2fSSmJ8FPBaoJgE7j", legacy_raw)
        )
        self.assertEqual(projected["title"], "Shankara Shankara Sada Shiva")
        self.assertFalse(projected["lyricsMissing"])

    def test_strip_prasanthi_mandir_schedule_and_channel_footers(self) -> None:
        import normalize_legacy_youtube_docs as norm

        description = "\n".join(
            [
                "Prasanthi Mandir Live: Sathya Swaroopini Ma",
                "Lyrics -",
                "Sathya Swaroopini Ma Sai Prema Swaroopini Ma",
                "Ananda Roopini Ma Sai Atma Swaroopini Ma",
                "Regular Prasanthi Mandir Schedule (IST)",
                "Morning",
                "Veda Chanting: 8:00 am to  9:00 am",
                "Bhajans: 9:00 am – 9:30 am",
                "Mangala Arati & Sai Gayatri",
                "Evening",
                "Veda Chanting: 4:30 pm – 5:15 pm",
                "Bhajans: 5:15 pm – 6:00 pm",
                "Mangala Arati & Sai Gayatri",
            ]
        )
        self.assertEqual(
            yt.extract_mandir_lyrics(description),
            [
                "Sathya Swaroopini Ma Sai Prema Swaroopini Ma",
                "Ananda Roopini Ma Sai Atma Swaroopini Ma",
            ],
        )

        # Preserve authentic lyric lines containing ordinary words like Morning/Evening
        mixed_lines = [
            "Morning and evening sing the Lord's name",
            "Jaya Guru Omkara Jaya Jaya Sadguru Omkara",
            "For feedback or any queries, please write to us at listener@sssmediacentre.org",
            "Our Digital Footprint :",
            "Website - https://www.sssmediacentre.org",
        ]
        self.assertEqual(
            yt.strip_youtube_lyrics_footer(mixed_lines),
            [
                "Morning and evening sing the Lord's name",
                "Jaya Guru Omkara Jaya Jaya Sadguru Omkara",
            ],
        )

        dirty_doc = {
            "id": "yt_-AbRphrr8AM",
            "slug": "yt_-AbRphrr8AM",
            "title": "Sathya Swaroopini Ma Sai Prema Swaroopini Ma",
            "metadataSource": "youtube_prasanthi_mandir_live",
            "lyricsSets": [
                {
                    "language": "Roman",
                    "script": "roman",
                    "lines": [
                        "Sathya Swaroopini Ma Sai Prema Swaroopini Ma",
                        "Ananda Roopini Ma Sai Atma Swaroopini Ma",
                        "Regular Prasanthi Mandir Schedule (IST)",
                        "Morning",
                        "Veda Chanting: 8:00 am to  9:00 am",
                        "Bhajans: 9:00 am – 9:30 am",
                    ],
                }
            ],
            "recordings": [
                {
                    "id": "yt_-AbRphrr8AM",
                    "label": "Prasanthi Mandir Live: Sathya Swaroopini Ma Sai Prema Swaroopini Ma",
                    "collection": "youtube_prasanthi_mandir_live",
                    "youtubeVideoId": "-AbRphrr8AM",
                    "embeddable": True,
                }
            ],
            "missingFields": ["meaning", "deity", "raga", "tempo"],
        }
        cleaned = norm.normalize_bhajan_doc("yt_-AbRphrr8AM", dirty_doc, now_iso="2026-11-26T16:45:00Z")
        self.assertIsNotNone(cleaned)
        assert cleaned is not None
        self.assertEqual(
            cleaned["lyricsSets"][0]["lines"],
            [
                "Sathya Swaroopini Ma Sai Prema Swaroopini Ma",
                "Ananda Roopini Ma Sai Atma Swaroopini Ma",
            ],
        )
        self.assertFalse(cleaned["lyricsMissing"])
        self.assertIsNone(norm.normalize_bhajan_doc("yt_-AbRphrr8AM", cleaned, now_iso="2026-11-26T16:46:00Z"))

        override_dirty = {**dirty_doc, "bhajamiOverride": True}
        self.assertIsNone(norm.normalize_bhajan_doc("yt_-AbRphrr8AM", override_dirty, now_iso="2026-11-26T16:46:00Z"))

    def test_special_track_classification_title_extraction_and_homonymous_guard(self) -> None:
        import classify_special_tracks as cst
        import index_builder

        self.assertEqual(
            yt.classify_track_type("Karaoke | SAMA - 01 | Sri Guru Paduka Stotram | Guru Purnima Special"),
            "karaoke",
        )
        self.assertEqual(
            yt.clean_youtube_display_title("Karaoke | SAMA - 01 | Sri Guru Paduka Stotram | Guru Purnima Special"),
            "Sri Guru Paduka Stotram (Karaoke)",
        )
        self.assertEqual(
            yt.clean_youtube_display_title("Karaoke | SAMA - 04 | Why Fear When I Am Here | 94th Birthday Special"),
            "Why Fear When I Am Here (Karaoke)",
        )
        self.assertEqual(
            yt.clean_youtube_display_title("SAMA - 02 | Sri Krishnashtakam | Sri Krishna Janmashtami Special"),
            "Sri Krishnashtakam (SAMA - 02)",
        )
        self.assertEqual(
            yt.clean_youtube_display_title("702 - Pranamami Sri Durge | Soothing Instrumental | Sri Sathya Sai Bhajans"),
            "Pranamami Sri Durge (Instrumental)",
        )
        self.assertEqual(
            yt.clean_youtube_display_title("1617 - Must Hear Soothing Krishna Bhajan | Yadunandana Yashoda Bala Fusion | Sri Sathya Sai Bhajans"),
            "Yadunandana Yashoda Bala Fusion",
        )
        self.assertEqual(
            yt.classify_track_type("1710 - Manasa Bhajare Guru Charanam Sai Charanam Pranamamyaham Unplugged | Ladies Day Special"),
            "bhajan",
        )

        # Lyrics heading without dash/colon should still extract cleanly
        desc_no_dash = "\n".join(
            [
                "Lyrics",
                "Gajavadana Gananatha Natha",
                "Gowri Vara Tanaya Gunaalaya",
                "Subscribe to Sri Sathya Sai Bhajans",
            ]
        )
        self.assertEqual(
            yt.extract_mandir_lyrics(desc_no_dash),
            ["Gajavadana Gananatha Natha", "Gowri Vara Tanaya Gunaalaya"],
        )

        # Karaoke/instrumental videos never merge into vocal bhajans, and homonymous no-lyrics videos route to doubt
        cands = [
            *self.candidates,
            {"id": "rama-rama-a", "title": "Rama Rama Rama Sita", "lyricsLines": ["Rama Rama Rama Sita", "Verse A"]},
            {"id": "rama-rama-b", "title": "Rama Rama Rama Sita", "lyricsLines": ["Rama Rama Rama Sita", "Verse B"]},
        ]
        res = yt.process_youtube_videos(
            [
                {
                    "videoId": "karVid1",
                    "rawTitle": "Karaoke | SAMA - 03 | Sri Ganashtakam | Ganesh Chaturthi Special",
                    "rawDescription": "",
                    "durationSec": 210,
                    "publishedAt": "2026-11-26T00:00:00Z",
                },
                {
                    "videoId": "veenaVid1",
                    "rawTitle": "Aao Aao Nandalala | Instrumental Veena Devi Bhajans | Nadasudha #2",
                    "rawDescription": "",
                    "durationSec": 200,
                    "publishedAt": "2026-11-26T00:00:00Z",
                },
                {
                    "videoId": "homNoLyrics1",
                    "rawTitle": "Rama Rama Rama Sita | Sri Sathya Sai Bhajans",
                    "rawDescription": "",
                    "durationSec": 180,
                    "publishedAt": "2026-11-26T00:00:00Z",
                },
            ],
            cands,
            now_iso="2026-11-27T00:00:00Z",
        )
        kar_doc = res["createdBhajans"]["yt_karVid1"]
        self.assertEqual(kar_doc["trackType"], "karaoke")
        self.assertEqual(kar_doc["title"], "Sri Ganashtakam (Karaoke)")
        self.assertFalse(kar_doc["lyricsMissing"])
        self.assertEqual(kar_doc["matchStatus"], "verified")

        veena_doc = res["createdBhajans"]["yt_veenaVid1"]
        self.assertEqual(veena_doc["trackType"], "instrumental")
        self.assertEqual(veena_doc["title"], "Aao Aao Nandalala (Instrumental)")
        self.assertFalse(veena_doc["lyricsMissing"])
        self.assertEqual(veena_doc["matchStatus"], "verified")

        # Vocal homonymous video without lyrics must NOT auto-merge blindly into rama-rama-a
        hom_doc = res["createdBhajans"]["yt_homNoLyrics1"]
        self.assertEqual(hom_doc["matchStatus"], "needs_verification")
        self.assertEqual(len(hom_doc["matchCandidates"]), 2)

        # Backfill helper extracts real Karaoke title + clears missing_lyrics + stats exclude special tracks
        classified = cst.classify_catalog_special_tracks(
            [
                {
                    "id": "k_old",
                    "slug": "k-old",
                    "title": "Karaoke",
                    "lyricsMissing": True,
                    "matchStatus": "needs_verification",
                    "matchCandidates": [{"targetBhajanId": "other"}],
                    "recordings": [{"id": "yt_ceVC", "youtubeVideoId": "ceVCslIOaoM", "label": "SSS Bhajans: Karaoke"}],
                }
            ],
            youtube_meta_by_vid={
                "ceVCslIOaoM": {
                    "rawTitle": "Karaoke | SAMA - 03 | Sri Ganashtakam| Ganesh Chaturthi Special",
                    "rawDescription": "",
                }
            },
            now_iso="2026-11-27T00:00:00Z",
        )
        self.assertEqual(classified["counts"]["karaoke"], 1)
        self.assertEqual(classified["patches"]["k_old"]["title"], "Sri Ganashtakam (Karaoke)")
        self.assertEqual(classified["patches"]["k_old"]["trackType"], "karaoke")
        self.assertFalse(classified["patches"]["k_old"]["lyricsMissing"])
        self.assertEqual(classified["patches"]["k_old"]["matchCandidates"], [])

        stats = index_builder.compute_catalog_stats(
            [
                kar_doc,
                veena_doc,
                {"id": "real_missing", "title": "Real Vocal Bhajan", "lyricsMissing": True, "recordings": []},
            ]
        )
        self.assertEqual(stats["missingLyricsCount"], 1)


if __name__ == "__main__":
    unittest.main()
