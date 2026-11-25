#!/usr/bin/env python3
"""Unit tests for rule-compliant SSS Media Centre (Bhajan A Day) extraction & fool-proof matching."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

import sync_sssmediacentre as sssmc  # noqa: E402


def _make_sample_rsc_html(item_payload: dict) -> str:
    payload_str = json.dumps({"item": item_payload}, ensure_ascii=False)
    js_string_literal = json.dumps(payload_str, ensure_ascii=False)
    return (
        "<!DOCTYPE html><html><body>"
        f"<script>self.__next_f.push([1,{js_string_literal}])</script>"
        "</body></html>"
    )


class SssMediaCentreSyncTests(unittest.TestCase):
    def test_robots_guard_blocks_disallowed_paths_and_allows_listen(self) -> None:
        self.assertTrue(
            sssmc.is_url_allowed_by_robots(
                "https://www.sssmediacentre.org/listen/manasa-bhajare-guru-charanam-dustara-5f6d81e29e4c999cabb098c9"
            )
        )
        self.assertFalse(sssmc.is_url_allowed_by_robots("https://www.sssmediacentre.org/api/audio"))
        self.assertFalse(sssmc.is_url_allowed_by_robots("https://www.sssmediacentre.org/payload/foo"))
        self.assertFalse(sssmc.is_url_allowed_by_robots("https://www.sssmediacentre.org/admin/login"))
        self.assertFalse(sssmc.is_url_allowed_by_robots("https://evil.example.com/listen/foo"))

    def test_parse_sssmc_pitch_prefers_leading_western_note(self) -> None:
        male = sssmc.parse_sssmc_pitch("A - 3 M")
        self.assertIsNotNone(male)
        assert male is not None
        self.assertEqual(male["raw"], "A - 3 M")
        self.assertEqual(male["western"], "A")
        self.assertEqual(male["semitoneFromC"], 9)

        female = sssmc.parse_sssmc_pitch("G - 5 P")
        self.assertIsNotNone(female)
        assert female is not None
        self.assertEqual(female["raw"], "G - 5 P")
        self.assertEqual(female["western"], "G")
        self.assertEqual(female["semitoneFromC"], 7)

        sharp = sssmc.parse_sssmc_pitch("F# - 4.5 P")
        self.assertIsNotNone(sharp)
        assert sharp is not None
        self.assertEqual(sharp["semitoneFromC"], 6)

        flat = sssmc.parse_sssmc_pitch("Bb - 6.5 P")
        self.assertIsNotNone(flat)
        assert flat is not None
        self.assertEqual(flat["semitoneFromC"], 10)

        pancham_fallback = sssmc.parse_sssmc_pitch("5 Pancham / G")
        self.assertIsNotNone(pancham_fallback)
        assert pancham_fallback is not None
        self.assertEqual(pancham_fallback["semitoneFromC"], 7)
        self.assertIsNone(sssmc.parse_sssmc_pitch(""))

    def test_parse_sssmc_listen_html_extracts_encoded_mp3_and_metadata(self) -> None:
        deep_categories = [{"id": f"cat{i}", "meta": {"order": i}} for i in range(30)]
        item = {
            "id": "5f6d81e29e4c999cabb098c9",
            "slug": "manasa-bhajare-guru-charanam-dustara-5f6d81e29e4c999cabb098c9",
            "categories": deep_categories,
            "content": "Manasa Bhajare Guru Charanam Dustara",
            "audioUrl": "https://content.sssmediacentre.org/audio/Audio_96/03_Manasa Bhajare Guru charanam.mp3",
            "lyrics": "Manasa Bhajare Guru Charanam Dustara Bhava Sagara Taranam\nGuru Maharaj Guru Jai Jai\nSainatha Sadguru Jai Jai",
            "customMetaData": {
                "deity": "Guru",
                "raga": "Shivaranjani",
                "tala": "8 beat",
                "tempo": "Fast",
                "sruthi_male": "A - 3 M",
                "sruthi_female": "G - 5 P",
                "meaning": "O mind! Meditate on the Lotus Feet of the Lord.",
                "DurationSpan": "00:04:02",
                "album_artiste": "Students",
                "file_name": "03_Manasa Bhajare Guru charanam.mp3",
            },
        }
        html = _make_sample_rsc_html(item)
        url = "https://www.sssmediacentre.org/listen/manasa-bhajare-guru-charanam-dustara-5f6d81e29e4c999cabb098c9"
        parsed = sssmc.parse_sssmc_listen_html(html, url)
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(
            parsed["audioUrl"],
            "https://content.sssmediacentre.org/audio/Audio_96/03_Manasa%20Bhajare%20Guru%20charanam.mp3",
        )
        self.assertEqual(parsed["durationSec"], 242)
        self.assertEqual(parsed["ragaName"], "Shivaranjani")
        self.assertEqual(parsed["beat"], "8 Beat")
        self.assertEqual(parsed["tempo"], "Fast")
        self.assertEqual(parsed["gentsPitch"]["semitoneFromC"], 9)
        self.assertEqual(parsed["ladiesPitch"]["semitoneFromC"], 7)
        self.assertEqual(len(parsed["lyricLines"]), 3)

        # Slug without 24-hex suffix gets a distinct deterministic hash objectId (never colliding with sidebar nav IDs)
        nav_prefix = json.dumps({"nav": {"id": "d4e5f6a7b8c9d0e1f2a3b4c5"}})
        item_plain_slug = dict(item, id="d4e5f6a7b8c9d0e1f2a3b4c5", slug="narayana-govinda-hare")
        parsed_plain = sssmc.parse_sssmc_listen_html(
            _make_sample_rsc_html({"prefix": nav_prefix, "item": item_plain_slug}),
            "https://www.sssmediacentre.org/listen/narayana-govinda-hare",
        )
        self.assertIsNotNone(parsed_plain)
        assert parsed_plain is not None
        self.assertNotEqual(parsed_plain["objectId"], "d4e5f6a7b8c9d0e1f2a3b4c5")
        self.assertNotEqual(parsed_plain["objectId"], parsed["objectId"])

    def test_foolproof_matching_across_prefixes_suffixes_phonetics_and_vetoes(self) -> None:
        catalog = [
            {
                "id": "yt_manasa",
                "slug": "yt-manasa",
                "title": "03 - Manasa Bhajare Guru Charanam | Radio Sai Bhajans",
                "lyricsSets": [
                    {
                        "language": "Roman",
                        "script": "roman",
                        "lines": [
                            "Manasa Bhajare Guru Charanam Dustara Bhava Sagara Taranam",
                            "Guru Maharaj Guru Jai Jai Sainatha Sadguru Jai Jai",
                        ],
                    }
                ],
                "recordings": [{"id": "yt_abc", "youtubeVideoId": "abc", "durationSec": 244}],
                "metadataSource": "youtube_sss_bhajans",
            },
            {
                "id": "yt_sheetala_instr",
                "slug": "sheetala-charanam-instrumental",
                "title": "01 - Sheetala Charanam Instrumental | Sri Sathya Sai Bhajans",
                "lyricsSets": [],
                "recordings": [{"id": "yt_ins", "youtubeVideoId": "ins1"}],
                "metadataSource": "youtube_sss_bhajans",
            },
            {
                "id": "govinda-a",
                "slug": "govinda-a",
                "title": "Govinda Gopala Hey Nandalala",
                "lyricsSets": [
                    {
                        "language": "Roman",
                        "script": "roman",
                        "lines": [
                            "Govinda Gopala Hey Nandalala",
                            "Radha Madhava Gopala",
                            "Murali Manohara Nandalala",
                        ],
                    }
                ],
                "recordings": [{"id": "yt_ga", "youtubeVideoId": "ga1"}],
                "metadataSource": "youtube_sss_bhajans",
            },
            {
                "id": "yt_shanmukha",
                "slug": "yt-shanmukha",
                "title": "160 - Maanasa Bhajarey Guru Charan | Sathya Sai Bhajans",
                "lyricsSets": [],
                "recordings": [{"id": "yt_sh1", "youtubeVideoId": "sh1", "durationSec": 240}],
                "metadataSource": "youtube_sss_bhajans",
            },
        ]

        # 1. Lyrics-confirmed match strips prefix/suffix & beats duplicate shorter title match
        parsed_manasa = {
            "objectId": "5f6d81e29e4c999cabb098c9",
            "slug": "manasa-bhajare-guru-charanam-dustara-5f6d81e29e4c999cabb098c9",
            "cleanSlug": "manasa-bhajare-guru-charanam-dustara",
            "title": "Manasa Bhajare Guru Charanam Dustara",
            "audioUrl": "https://content.sssmediacentre.org/audio/manasa.mp3",
            "durationSec": 242,
            "lyricLines": [
                "Manasa Bhajare Guru Charanam Dustara Bhava Sagara Taranam",
                "Guru Maharaj Guru Jai Jai Sainatha Sadguru Jai Jai",
            ],
        }
        m1 = sssmc.match_sssmc_to_catalog(parsed_manasa, catalog)
        self.assertEqual(m1["status"], "matched")
        self.assertEqual(m1["targetId"], "yt_manasa")
        self.assertEqual(m1["method"], "sssmc_lyrics_confirmed")

        # 2. Phonetic + duration match (even when YouTube has no lyrics, different transliteration & prefix/suffix)
        parsed_no_lyrics_match = {
            "objectId": "aaaaaaaaaaaa111111111111",
            "slug": "manasa-bhajare-guru-charan-aaaaaaaaaaaa111111111111",
            "cleanSlug": "manasa-bhajare-guru-charan",
            "title": "Manasa Bhajare Guru Charan",
            "audioUrl": "https://content.sssmediacentre.org/audio/manasa2.mp3",
            "durationSec": 241,
            "lyricLines": [],
        }
        m2 = sssmc.match_sssmc_to_catalog(parsed_no_lyrics_match, [catalog[3]])
        self.assertEqual(m2["status"], "matched")
        self.assertEqual(m2["targetId"], "yt_shanmukha")

        # 3. Instrumental vs Vocal hard veto -> creates new bhajan instead of merging vocal into instrumental
        parsed_sheetala = {
            "objectId": "bbbbbbbbbbbb222222222222",
            "slug": "sheetala-charanam-bbbbbbbbbbbb222222222222",
            "cleanSlug": "sheetala-charanam",
            "title": "Sheetala Charanam",
            "audioUrl": "https://content.sssmediacentre.org/audio/sheetala.mp3",
            "durationSec": 210,
            "lyricLines": ["Sheetala Charanam Komala Charanam"],
        }
        m3 = sssmc.match_sssmc_to_catalog(parsed_sheetala, catalog)
        self.assertEqual(m3["status"], "new_bhajan")

        # 4. Similar refrain vetoed when verse bodies disagree -> routed to Admin Queue (needs_verification), never auto-merged
        parsed_govinda_different = {
            "objectId": "cccccccccccc333333333333",
            "slug": "govinda-gopala-hey-nandalala-cccccccccccc333333333333",
            "cleanSlug": "govinda-gopala-hey-nandalala-alt",
            "title": "Govinda Gopala Hey Nandalala",
            "audioUrl": "https://content.sssmediacentre.org/audio/govinda-alt.mp3",
            "durationSec": 195,
            "lyricLines": [
                "Govinda Gopala Hey Nandalala",
                "Brindavana Sanchari Shyama Gopala",
                "Meera Ke Prabhu Giridhara Bala",
            ],
        }
        m4 = sssmc.match_sssmc_to_catalog(parsed_govinda_different, catalog)
        self.assertEqual(m4["status"], "needs_verification")
        self.assertEqual(m4["method"], "sssmc_lyrics_conflict_review")
        self.assertTrue(str(m4["candidates"][0]["reason"]).startswith("lyrics_conflict"))

        # 5. Strictly verified full-lyrics duplicate docs (e.g. Sai Rhythms + YouTube) BOTH get matched via additionalTargetIds
        dup_catalog = [
            {
                "id": "gajanana-hey-gajanana",
                "slug": "gajanana-hey-gajanana",
                "title": "Gajanana Hey Gajanana",
                "lyricsSets": [
                    {
                        "language": "Roman",
                        "script": "roman",
                        "lines": [
                            "Gajanana Hey Gajanana",
                            "Gouri Tanaya Gajanana",
                            "Parvati Nandana Hey Shubhanana",
                            "Mooshika Vahana Gajanana",
                        ],
                    }
                ],
                "recordings": [{"id": "sair_1", "collection": "sairhythms_ref", "externalUrl": "https://sairhythms.org/gaj.mp3"}],
                "metadataSource": "sairhythms_verified",
            },
            {
                "id": "yt_gajanana",
                "slug": "yt-gajanana",
                "title": "Gajanana Hey Gajanana",
                "lyricsSets": [
                    {
                        "language": "Roman",
                        "script": "roman",
                        "lines": [
                            "Gajanana Hey Gajanana",
                            "Gouri Tanaya Gajanana",
                            "Parvati Nandana Hey Shubhanana",
                            "Mooshika Vahana Gajanana",
                        ],
                    }
                ],
                "recordings": [{"id": "yt_gaj", "youtubeVideoId": "gaj123"}],
                "metadataSource": "youtube_sss_bhajans",
            },
        ]
        parsed_gajanana = {
            "objectId": "dddddddddddd444444444444",
            "slug": "gajanana-hey-gajanana-dddddddddddd444444444444",
            "cleanSlug": "gajanana-hey-gajanana",
            "title": "Gajanana Hey Gajanana",
            "audioUrl": "https://content.sssmediacentre.org/audio/gajanana.mp3",
            "lyricLines": [
                "Gajanana Hey Gajanana",
                "Gouri Tanaya Gajanana Parvati Nandana Hey Shubhanana",
                "Mooshika Vahana Gajanana",
            ],
        }
        m5 = sssmc.match_sssmc_to_catalog(parsed_gajanana, dup_catalog)
        self.assertEqual(m5["status"], "matched")
        self.assertEqual(m5["targetId"], "gajanana-hey-gajanana")
        self.assertEqual(m5.get("additionalTargetIds"), ["yt_gajanana"])

        # 6. Title-only duplicate docs WITHOUT lyrics remain ambiguous -> Admin Queue (needs_verification)
        title_only_dups = [
            {**dup_catalog[0], "lyricsSets": []},
            {**dup_catalog[1], "lyricsSets": []},
        ]
        m6 = sssmc.match_sssmc_to_catalog(parsed_gajanana, title_only_dups)
        self.assertEqual(m6["status"], "needs_verification")
        self.assertEqual(m6["method"], "sssmc_ambiguous_candidate")

    def test_merge_precedence_respects_overrides_and_enriches_youtube_stubs(self) -> None:
        parsed = {
            "objectId": "5f6d81e29e4c999cabb098c9",
            "slug": "manasa-bhajare-guru-charanam-dustara-5f6d81e29e4c999cabb098c9",
            "cleanSlug": "manasa-bhajare-guru-charanam-dustara",
            "title": "Manasa Bhajare Guru Charanam Dustara",
            "sourceUrl": "https://www.sssmediacentre.org/listen/manasa-bhajare-guru-charanam-dustara-5f6d81e29e4c999cabb098c9",
            "audioUrl": "https://content.sssmediacentre.org/audio/manasa.mp3",
            "durationSec": 242,
            "deity": "Guru",
            "ragaName": "Shivaranjani",
            "beat": "8 Beat",
            "tala": "8 beat",
            "tempo": "Fast",
            "gentsPitchRaw": "A - 3 M",
            "ladiesPitchRaw": "G - 5 P",
            "gentsPitch": {"raw": "A - 3 M", "pancham": "6 Pancham", "western": "A", "semitoneFromC": 9},
            "ladiesPitch": {"raw": "G - 5 P", "pancham": "5 Pancham", "western": "G", "semitoneFromC": 7},
            "meaning": "Meditate on the Guru.",
            "albumArtiste": "Students",
            "lyricLines": ["Manasa Bhajare Guru Charanam", "Guru Maharaj Guru Jai Jai"],
            "lyricsSets": [{"language": "Roman", "script": "roman", "lines": ["Manasa Bhajare Guru Charanam", "Guru Maharaj Guru Jai Jai"]}],
        }
        match_info = {"score": 0.99, "method": "sssmc_lyrics_confirmed"}

        # A. bhajamiOverride: True -> only appends recording, touches zero metadata
        override_doc = {
            "id": "bhajan-1",
            "title": "Admin Title",
            "raga": {"name": "Custom Raga"},
            "bhajamiOverride": True,
            "recordings": [{"id": "yt_1", "youtubeVideoId": "abc"}],
        }
        override_patch = sssmc.build_sssmc_merge_patch(override_doc, parsed, match_info, file_size_bytes=2918403)
        self.assertNotIn("raga", override_patch)
        self.assertEqual(len(override_patch["recordings"]), 2)
        self.assertEqual(override_patch["recordings"][0]["collection"], "sssmediacentre_bhajan_a_day")
        self.assertEqual(override_patch["recordings"][1]["id"], "yt_1")

        # Prepends SSSMC ahead of existing Sai Rhythms MP3 on shared Sai Rhythms doc
        sr_doc = {
            "id": "sr_1",
            "title": "Manasa Bhajare Guru Charanam",
            "metadataSource": "sairhythms_verified",
            "raga": {"name": "Shivaranjani"},
            "recordings": [{"id": "sair_old", "collection": "sairhythms_ref", "externalUrl": "https://sairhythms.org/m.mp3"}],
        }
        sr_patch = sssmc.build_sssmc_merge_patch(sr_doc, parsed, match_info, file_size_bytes=2918403)
        self.assertEqual(sr_patch["recordings"][0]["collection"], "sssmediacentre_bhajan_a_day")
        self.assertEqual(sr_patch["recordings"][1]["collection"], "sairhythms_ref")

        # B. YouTube stub missing raga/pitch/lyrics -> gets enriched cleanly + keeps YouTube recording
        yt_stub = {
            "id": "yt_stub",
            "title": "Manasa Bhajare Guru Charanam",
            "metadataSource": "youtube_sss_bhajans",
            "raga": None,
            "beat": "",
            "lyricsSets": [],
            "lyricsMissing": True,
            "recordings": [{"id": "yt_2", "youtubeVideoId": "xyz"}],
        }
        yt_patch = sssmc.build_sssmc_merge_patch(yt_stub, parsed, match_info, file_size_bytes=2918403)
        self.assertEqual(yt_patch["raga"]["name"], "Shivaranjani")
        self.assertEqual(yt_patch["gentsPitch"]["semitoneFromC"], 9)
        self.assertEqual(yt_patch["ladiesPitch"]["semitoneFromC"], 7)
        self.assertFalse(yt_patch["lyricsMissing"])
        self.assertEqual(len(yt_patch["recordings"]), 2)


if __name__ == "__main__":
    unittest.main()
