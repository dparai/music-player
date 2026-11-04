"""Run: python3 -m unittest discover -s server/automix/tests"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import lrclib  # noqa: E402


def hit(duration, synced=None, plain=None, instrumental=False):
    return {"duration": duration, "syncedLyrics": synced, "plainLyrics": plain, "instrumental": instrumental}


class PickBest(unittest.TestCase):
    def test_prefers_synced_over_plain(self):
        b = lrclib.pick_best([hit(200, plain="p"), hit(201, synced="[00:01.00] s")], 200)
        self.assertEqual(b["syncedLyrics"], "[00:01.00] s")

    def test_rejects_wrong_length_and_instrumental(self):
        self.assertIsNone(lrclib.pick_best([hit(230, synced="x"), hit(200, synced="y", instrumental=True)], 200))

    def test_closest_length_wins_among_synced(self):
        b = lrclib.pick_best([hit(203, synced="far"), hit(200.5, synced="near")], 200)
        self.assertEqual(b["syncedLyrics"], "near")

    def test_unknown_duration_accepts_any_length(self):
        self.assertIsNotNone(lrclib.pick_best([hit(500, synced="x")], 0))


class Lookup(unittest.TestCase):
    def test_ok_from_search_when_exact_has_no_match(self):
        calls = []

        def fake(path, params, timeout):
            calls.append(path)
            return None if path == "get" else [hit(200, synced="[00:01.00] hi")]

        with mock.patch.object(lrclib, "_fetch", fake):
            status, res = lrclib.lookup("a", "t", "al", 200, waits=(0,))
        self.assertEqual((status, res["synced"], calls), ("ok", True, ["get", "search"]))

    def test_none_when_no_candidate(self):
        with mock.patch.object(lrclib, "_fetch", lambda *a, **k: []):
            self.assertEqual(lrclib.lookup("a", "t", "al", 200, waits=(0,)), ("none", None))

    def test_unavailable_after_all_attempts_fail(self):
        def boom(*a, **k):
            raise lrclib.Unavailable("HTTP 502")

        with mock.patch.object(lrclib, "_fetch", boom), mock.patch.object(lrclib.time, "sleep"):
            self.assertEqual(lrclib.lookup("a", "t", "al", 200, waits=(0, 1, 2)), ("unavailable", None))

    def test_retry_succeeds_after_a_failure(self):
        state = {"n": 0}

        def flaky(path, params, timeout):
            state["n"] += 1
            if state["n"] == 1:
                raise lrclib.Unavailable("HTTP 503")
            return None if path == "get" else [hit(200, synced="x")]

        with mock.patch.object(lrclib, "_fetch", flaky), mock.patch.object(lrclib.time, "sleep"):
            self.assertEqual(lrclib.lookup("a", "t", "al", 200, waits=(0, 1))[0], "ok")


if __name__ == "__main__":
    unittest.main()
