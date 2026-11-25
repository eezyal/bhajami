#!/usr/bin/env python3
"""Offline unit tests for Sai Rhythms crawler, glossary seed filtering, index sharding, and build_catalog cleanups."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import build_catalog  # noqa: E402
import crawl_sairhythms as crawler  # noqa: E402
import index_builder  # noqa: E402

FIXTURE_HTML = (SCRIPT_DIR / "fixtures" / "sairhythms_sample.html").read_text(encoding="utf-8")


class SaiRhythmsParserTests(unittest.TestCase):
    def test_parses_14_scripts_and_metadata_without_site_h1_leak(self) -> None:
        doc = crawler.parse_sairhythms_html("sundara-sundara-vinayaka", FIXTURE_HTML, crawled_at="2026-11-24T17:00:00Z")
        self.assertIsNotNone(doc)
        assert doc is not None

        self.assertEqual(doc["title"], "Sundara Sundara Vinayaka")
        self.assertEqual(doc["deity"], "Ganesha")
        self.assertEqual(doc["raga"]["name"], "Bowli")
        self.assertEqual(doc["raga"]["arohanam"], "S R1 G2 P D1 S")
        self.assertEqual(doc["raga"]["avarohanam"], "S N2 D1 P G2 R1 S")
        self.assertEqual(doc["gentsPitch"]["pancham"], "5.5 Pancham")
        self.assertEqual(doc["gentsPitch"]["semitoneFromC"], 8)
        self.assertEqual(doc["ladiesPitch"]["pancham"], "6 Pancham")
        self.assertEqual(doc["ladiesPitch"]["semitoneFromC"], 9)
        self.assertEqual(len(doc["recordings"]), 2)
        self.assertIn("https://sairhythms.sathyasai.org/sites/default/files/pages/pdfjs/web/viewer.html", doc["sheetMusicUrl"])
        self.assertFalse(doc["lyricsMissing"])

        scripts = [item["script"] for item in doc["lyricsSets"]]
        self.assertEqual(
            scripts,
            [
                "roman",
                "devanagari",
                "telugu",
                "tamil",
                "kannada",
                "malayalam",
                "bengali",
                "gujarati",
                "odia",
                "gurmukhi",
                "arabic",
                "cyrillic",
                "cjk",
                "other",
            ],
        )

    def test_extract_safe_glossary_variants_blocks_gender_and_minimal_pairs(self) -> None:
        doc = crawler.parse_sairhythms_html("sundara-sundara-vinayaka", FIXTURE_HTML)
        assert doc is not None
        seeds = crawler.extract_safe_glossary_variants(doc["glossary"], song_slug=doc["slug"])
        pairs = {(s["term"], s["variant"]) for s in seeds}

        self.assertIn(("ganesha", "ganesh"), pairs)
        self.assertIn(("dayaka", "dayakam"), pairs)
        self.assertNotIn(("dayaka", "dayaki"), pairs)
        self.assertNotIn(("shiva", "shakti"), pairs)
        self.assertNotIn(("deva", "devi"), pairs)
        for seed in seeds:
            self.assertGreaterEqual(seed["similarity"], 0.78)

    def test_merge_preserves_bhajami_override_fields(self) -> None:
        crawled = crawler.parse_sairhythms_html("sundara-sundara-vinayaka", FIXTURE_HTML, crawled_at="2026-11-24T17:00:00Z")
        assert crawled is not None
        existing = {
            "id": "sundara-sundara-vinayaka",
            "slug": "sundara-sundara-vinayaka",
            "title": "Sundara Sundara Vinayaka (Curated Override)",
            "deity": "Ganesha",
            "language": "Sanskrit / Hindi",
            "raga": {"name": "Bahudari"},
            "beat": "8 Beat / Adi",
            "tempo": "Fast",
            "meaning": "Human curator edited meaning.",
            "gentsPitch": {"raw": "3 Pancham / E", "pancham": "3 Pancham", "western": "E", "semitoneFromC": 4},
            "ladiesPitch": {"raw": "6 Pancham / A", "pancham": "6 Pancham", "western": "A", "semitoneFromC": 9},
            "lyricsSets": [{"language": "Roman", "script": "roman", "lines": ["Custom curated verse"]}],
            "glossary": [],
            "recordings": [{"id": "yt_abc123", "label": "YouTube Audio", "collection": "youtube_channel"}],
            "metadataSource": "bhajami_curated",
            "bhajamiOverride": True,
        }
        merged = crawler.merge_with_existing_doc(crawled, existing)
        self.assertTrue(merged["bhajamiOverride"])
        self.assertEqual(merged["title"], "Sundara Sundara Vinayaka (Curated Override)")
        self.assertEqual(merged["raga"]["name"], "Bahudari")
        self.assertEqual(merged["meaning"], "Human curator edited meaning.")
        self.assertEqual(merged["lyricsSets"][0]["lines"], ["Custom curated verse"])
        # Appends Sai Rhythms reference recordings without dropping existing curated YouTube audio
        rec_ids = {r["id"] for r in merged["recordings"]}
        self.assertIn("yt_abc123", rec_ids)
        self.assertEqual(len(rec_ids), 3)

    def test_missing_fields_honors_empty_lyrics_and_omits_fake_placeholders(self) -> None:
        minimal_html = """
        <html class="node-type-devotional-song">
        <head><title>Silent Song | Sai Rhythms</title></head>
        <body class="node-type-devotional-song">
          <h2 class="page-header">Silent Song</h2>
          <div class="devotional-song-content"></div>
        </body></html>
        """
        doc = crawler.parse_sairhythms_html("silent-song", minimal_html)
        assert doc is not None
        self.assertTrue(doc["lyricsMissing"])
        self.assertEqual(doc["lyricsSets"], [])
        self.assertIsNone(doc["gentsPitch"])
        self.assertIsNone(doc["ladiesPitch"])
        self.assertIsNone(doc["meaning"])
        self.assertIn("lyrics", doc["missingFields"])
        self.assertIn("gentsPitch", doc["missingFields"])
        self.assertIn("raga", doc["missingFields"])

    def test_sqlite_checkpoint_gzip_cache_and_delta_skip(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            cache_dir = tmp / ".cache"
            state_db = tmp / "state.sqlite3"
            audit_log = tmp / "audit.jsonl"
            seeds_out = tmp / "seeds.json"

            gz_path = crawler.write_cached_html(cache_dir, "sundara-sundara-vinayaka", FIXTURE_HTML)
            self.assertTrue(gz_path.exists())
            self.assertIn("Sundara Sundara Vinayaka", crawler.read_cached_html(cache_dir, "sundara-sundara-vinayaka") or "")

            first_summary = crawler.run_crawler(
                slugs=["sundara-sundara-vinayaka"],
                reparse_cache=True,
                delta_only=True,
                emit_var_seeds=True,
                seeds_out=seeds_out,
                cache_dir=cache_dir,
                state_db_path=state_db,
                audit_log_path=audit_log,
            )
            self.assertEqual(first_summary["parsedCount"], 1)
            self.assertTrue(seeds_out.exists())

            # Mark firestore_synced_at and verify --delta-only skips unchanged contentHash
            db = crawler.CrawlStateDB(state_db)
            db.upsert_slug(
                slug="sundara-sundara-vinayaka",
                url="https://sairhythms.sathyasai.org/song/sundara-sundara-vinayaka",
                status="synced",
                firestore_synced_at="2026-11-24T17:01:00Z",
            )
            db.close()

            second_summary = crawler.run_crawler(
                slugs=["sundara-sundara-vinayaka"],
                reparse_cache=True,
                delta_only=True,
                cache_dir=cache_dir,
                state_db_path=state_db,
                audit_log_path=audit_log,
            )
            self.assertEqual(second_summary["skippedUnchanged"], 1)
            self.assertEqual(second_summary["parsedCount"], 0)

    def test_enforce_crawl_delay_honors_minimum_floor(self) -> None:
        sleeps: list[float] = []
        times = iter([100.0, 102.0])
        crawler.enforce_crawl_delay(
            99.0,
            delay_sec=1.0,  # caller passes too-fast value, must clamp to MIN_CRAWL_DELAY_SEC = 10.2
            now_fn=lambda: next(times),
            sleep_fn=sleeps.append,
        )
        self.assertEqual(len(sleeps), 1)
        self.assertAlmostEqual(sleeps[0], 9.2, places=3)

    def test_extract_sitemap_slugs(self) -> None:
        xml_text = """<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://sairhythms.sathyasai.org/song/aao-aao-nandalala</loc></url>
          <url><loc>https://sairhythms.sathyasai.org/song/arunachala-shiva</loc></url>
          <url><loc>https://sairhythms.sathyasai.org/song/tags/ganesha</loc></url>
          <url><loc>https://sairhythms.sathyasai.org/sitemap-2.xml</loc></url>
        </urlset>"""
        slugs, children = crawler.extract_song_slugs_from_sitemap_xml(xml_text)
        self.assertEqual(slugs, ["aao-aao-nandalala", "arunachala-shiva"])
        self.assertEqual(children, ["https://sairhythms.sathyasai.org/sitemap-2.xml"])

    def test_extract_listing_html_and_incremental_discovery_advances(self) -> None:
        page0_html = """
        <html><body>
          <a href="/song/glossary">Glossary</a>
          <a href="/song/tags/prayers">Prayers</a>
          <a href="/song/aao-aao-nandalala">Aao Aao Nandalala</a>
          <a href="/song/arunachala-shiva">Arunachala Shiva</a>
          <a href="/song/tags/sheet-music?page=1">Next</a>
          <a href="/song/tags/sheet-music?page=2">Last</a>
        </body></html>
        """
        page1_html = """
        <html><body>
          <a href="/song/gajanana-hey-gajanana">Gajanana Hey Gajanana</a>
          <a href="/song/guru-deva-guru-govinda">Guru Deva Guru Govinda</a>
          <a href="/song/tags/sheet-music?page=2">Last</a>
        </body></html>
        """
        slugs0, max_p = crawler.extract_song_slugs_from_listing_html(page0_html)
        self.assertEqual(slugs0, ["aao-aao-nandalala", "arunachala-shiva"])
        self.assertEqual(max_p, 2)

        def fake_fetch(url: str):
            if url.endswith("/song/tags/sheet-music"):
                return 200, page0_html, {}
            if url.endswith("/song/tags/sheet-music?page=1"):
                return 200, page1_html, {}
            raise crawler.urllib.error.HTTPError(url, 404, "Not Found", {}, None)  # type: ignore[arg-type]

        with tempfile.TemporaryDirectory() as tmpdir:
            db = crawler.CrawlStateDB(Path(tmpdir) / "state.sqlite3")
            with mock.patch.object(crawler, "enforce_crawl_delay", return_value=1.0):
                batch1, _, fetched1 = crawler.discover_slugs_incrementally(
                    db,
                    needed_count=2,
                    sources=("/song/tags/missing", "/song/tags/sheet-music"),
                    fetch_fn=fake_fetch,
                )
                self.assertEqual(fetched1, 1)
                self.assertEqual(batch1, ["aao-aao-nandalala", "arunachala-shiva"])

                # Simulate Run 1 syncing those 2 songs
                for s in batch1:
                    db.upsert_slug(
                        slug=s,
                        url=f"https://sairhythms.sathyasai.org/song/{s}",
                        status="synced",
                        firestore_synced_at="2026-11-24T18:45:00Z",
                    )

                batch2, _, fetched2 = crawler.discover_slugs_incrementally(
                    db,
                    needed_count=2,
                    sources=("/song/tags/missing", "/song/tags/sheet-music"),
                    fetch_fn=fake_fetch,
                )
                self.assertEqual(fetched2, 1)
                self.assertEqual(batch2, ["gajanana-hey-gajanana", "guru-deva-guru-govinda"])
            db.close()

    def test_delta_only_filters_synced_slugs_before_max_songs_per_run_cap(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            cache_dir = tmp / ".cache"
            state_db = tmp / "state.sqlite3"
            audit_log = tmp / "audit.jsonl"

            crawler.write_cached_html(cache_dir, "song-one-synced", FIXTURE_HTML)
            crawler.write_cached_html(cache_dir, "song-two-unsynced", FIXTURE_HTML)

            db = crawler.CrawlStateDB(state_db)
            db.upsert_slug(
                slug="song-one-synced",
                url="https://sairhythms.sathyasai.org/song/song-one-synced",
                status="synced",
                firestore_synced_at="2026-11-24T18:45:00Z",
            )
            db.close()

            parsed_out = tmp / "parsed.json"
            summary = crawler.run_crawler(
                slugs=["song-one-synced", "song-two-unsynced"],
                reparse_cache=True,
                delta_only=True,
                max_songs_per_run=1,
                cache_dir=cache_dir,
                state_db_path=state_db,
                audit_log_path=audit_log,
                parsed_out=parsed_out,
            )
            self.assertEqual(summary["skippedUnchanged"], 1)
            self.assertEqual(summary["targetSlugs"], 1)
            self.assertEqual(summary["parsedCount"], 1)
            parsed_data = json.loads(parsed_out.read_text(encoding="utf-8"))
            self.assertEqual([b["slug"] for b in parsed_data["bhajans"]], ["song-two-unsynced"])


class IndexBuilderAndCleanupTests(unittest.TestCase):
    def test_pack_index_shards_stays_strictly_under_350kb_with_600_entries(self) -> None:
        bhajans = [
            {
                "id": f"bhajan-{i:04d}",
                "slug": f"bhajan-{i:04d}",
                "title": f"Om Sri Sai Bhajan {i:04d} Namah",
                "deity": "Sai",
                "language": "Sanskrit / Hindi",
                "raga": {"name": "Mohanam"},
                "beat": "8 Beat / Keherwa",
                "tempo": "Medium",
                "gentsPitch": {"raw": "2 Pancham / D", "pancham": "2 Pancham", "western": "D", "semitoneFromC": 2},
                "lyricsSets": [
                    {
                        "language": "Roman",
                        "script": "roman",
                        "lines": [
                            f"Om Sri Sai Bhajan {i:04d} Namah " + ("Jai " * 25),
                            "Prashanthi Nilayam Sai Ram " + ("Hari " * 20),
                        ],
                    }
                ],
                "recordings": [{"id": f"rec_{i}", "collection": "sairhythms_ref", "label": "Ref"}],
                "metadataSource": "sairhythms_verified",
            }
            for i in range(600)
        ]
        entries = [index_builder.project_bhajan_to_index_entry(b) for b in bhajans]
        shards = index_builder.pack_index_shards(entries, version=7)
        self.assertGreaterEqual(len(shards), 1)
        total_count = 0
        for shard in shards:
            byte_len = len(json.dumps(shard, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            self.assertLess(byte_len, 350_000)
            total_count += shard["count"]
        self.assertEqual(total_count, 600)

        stats = index_builder.compute_catalog_stats(bhajans)
        meta = index_builder.build_catalog_meta(
            version=7,
            entries=entries,
            shards=shards,
            stats=stats,
            updated_at="2026-11-24T17:15:00Z",
        )
        self.assertEqual(meta["totalBhajans"], 600)
        self.assertEqual(len(meta["shardIds"]), len(shards))
        self.assertRegex(meta["updatedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

    def test_build_catalog_cleanups_and_local_archive_gate(self) -> None:
        # 1. Typo fixed: vitthala instead of vittahla
        krishna_kws = dict(build_catalog.DEITY_KEYWORDS)["Krishna"]
        self.assertIn("vitthala", krishna_kws)
        self.assertNotIn("vittahla", krishna_kws)

        # 2. Boundary-aware Pancham parsing handles decimals cleanly
        pitch = build_catalog.parse_pitch_info_optional("5.5 Pancham / G# / Ab")
        assert pitch is not None
        self.assertEqual(pitch["pancham"], "5.5 Pancham")
        self.assertEqual(pitch["semitoneFromC"], 8)
        self.assertIsNone(build_catalog.parse_pitch_info_optional(""))

        # 3. Local archive scan is disabled by default unless LOCAL_ARCHIVE_ENABLED=true or flag passed
        with mock.patch.dict("os.environ", {"LOCAL_ARCHIVE_ENABLED": ""}):
            with mock.patch.object(build_catalog, "scan_local_archives") as scan_mock:
                with mock.patch.object(build_catalog, "fetch_sairhythms_html", return_value=None):
                    payload = build_catalog.build_catalog(["nonexistent-slug"])
                    scan_mock.assert_not_called()
                    self.assertEqual(payload["stats"]["totalLocalRecordings"], 0)


if __name__ == "__main__":
    unittest.main()
