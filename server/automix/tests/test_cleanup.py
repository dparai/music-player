import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cleanup import prune_lyrics_cache  # noqa: E402


class PruneLyricsCache(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute(
            "CREATE TABLE lyrics_cache (key TEXT PRIMARY KEY, status TEXT, lrc TEXT, synced INTEGER, "
            "fetched REAL, title TEXT, dur REAL)")
        rows = [
            ("keep", "Song A", 200),          # song still there
            ("keep_close", "song a", 201.4),  # case and a 1.4 s duration difference
            ("gone", "Song B", 180),          # song deleted
            ("other_recording", "Song A", 260),  # same title, different length: not a match
            ("legacy", None, None),           # saved before titles were recorded
        ]
        self.db.executemany("INSERT INTO lyrics_cache VALUES (?, 'ok', 'x', 1, 0, ?, ?)", rows)

    def keys(self):
        return sorted(r[0] for r in self.db.execute("SELECT key FROM lyrics_cache"))

    def test_keeps_only_rows_a_current_song_matches(self):
        removed = prune_lyrics_cache(self.db, [("Song A", 200.2), ("Song C", 100)])
        self.assertEqual(removed, 3)
        self.assertEqual(self.keys(), ["keep", "keep_close"])

    def test_no_songs_means_every_row_is_stale(self):
        # Callers skip pruning when Navidrome is unreadable, so this never runs on a read error.
        self.assertEqual(prune_lyrics_cache(self.db, []), 5)


if __name__ == "__main__":
    unittest.main()
