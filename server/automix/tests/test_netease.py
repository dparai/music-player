import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import lrclib  # noqa: E402
import netease  # noqa: E402


def song(name, artist, secs, sid=1):
    return {"id": sid, "name": name, "artists": [{"name": artist}], "duration": secs * 1000}


class PickSong(unittest.TestCase):
    def test_matches_title_artist_and_length(self):
        s = netease.pick_song([song("Around the World", "Daft Punk", 238)], "Around the World (Radio Edit)", "Daft Punk", 241)
        self.assertIsNotNone(s)

    def test_rejects_wrong_artist_or_length(self):
        self.assertIsNone(netease.pick_song([song("Khayaal", "Someone Else", 162)], "Khayaal", "Talwiinder", 162))
        self.assertIsNone(netease.pick_song([song("Khayaal", "Talwiinder", 300)], "Khayaal", "Talwiinder", 162))

    def test_closest_length_wins(self):
        s = netease.pick_song([song("X", "A", 200, 1), song("X", "A", 201, 2)], "X", "A", 201)
        self.assertEqual(s["id"], 2)


class Clean(unittest.TestCase):
    def test_drops_credit_lines_only(self):
        raw = "\n".join([
            "[00:00.00] 作词 : A",
            "[00:01.00] 作曲 : B",
            "[00:18.19]Main Tera Hoya",
            "[00:20.00]Lyrics of love",
        ])
        self.assertEqual(netease.clean(raw), "[00:18.19]Main Tera Hoya\n[00:20.00]Lyrics of love")


class Fallback(unittest.TestCase):
    def test_backup_used_when_lrclib_down(self):
        with mock.patch.object(lrclib, "lookup", return_value=("unavailable", None)), \
             mock.patch.object(netease, "lookup", return_value={"lrc": "[00:01.00] hi", "synced": True}):
            self.assertEqual(lrclib.lookup_any("a", "t", "al", 200)[0], "ok")

    def test_backup_miss_keeps_lrclib_status(self):
        with mock.patch.object(lrclib, "lookup", return_value=("unavailable", None)), \
             mock.patch.object(netease, "lookup", return_value=None):
            self.assertEqual(lrclib.lookup_any("a", "t", "al", 200), ("unavailable", None))

    def test_lrclib_hit_skips_backup(self):
        with mock.patch.object(lrclib, "lookup", return_value=("ok", {"lrc": "x", "synced": False})), \
             mock.patch.object(netease, "lookup", side_effect=AssertionError("should not run")):
            self.assertEqual(lrclib.lookup_any("a", "t", "al", 200)[0], "ok")


if __name__ == "__main__":
    unittest.main()
