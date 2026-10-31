"""Lyrics from LRCLIB, shared by the /automix/lyrics endpoint and fetch_lrc.py.

lrclib.net is free and needs no key. Only title, artist, album and duration
are sent. Set AUTOMIX_LYRICS=0 to turn lookups off.

(Named lrclib.py, not lyrics.py: the dj-hook-mix branch has its own lyrics.py
for the hook detector, and the two must not collide when merged.)
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

ENABLED = os.environ.get("AUTOMIX_LYRICS", "1") != "0"
API = "https://lrclib.net/api"
UA = "Brook-AutoMix/1.0 (self-hosted music player)"
DURATION_SLACK = 4.0  # seconds a match may differ from the file


class Unavailable(Exception):
    """LRCLIB could not be asked (down, overloaded, no network)."""


def pick_best(hits: list, duration: float, slack: float = DURATION_SLACK) -> dict | None:
    """The hit to use: has lyrics, not instrumental, within `slack` s of `duration`.
    Synced lyrics beat plain ones; then the closest length wins."""
    ok = []
    for h in hits or []:
        if not isinstance(h, dict) or h.get("instrumental"):
            continue
        if not (h.get("syncedLyrics") or h.get("plainLyrics")):
            continue
        d = h.get("duration")
        if duration and isinstance(d, (int, float)) and abs(d - duration) > slack:
            continue
        ok.append(h)
    if not ok:
        return None
    ok.sort(key=lambda h: (not h.get("syncedLyrics"), abs((h.get("duration") or duration or 0) - (duration or 0))))
    return ok[0]


def as_result(hit: dict) -> dict:
    synced = bool(hit.get("syncedLyrics"))
    return {"lrc": hit["syncedLyrics"] if synced else hit["plainLyrics"], "synced": synced}


def _fetch(path: str, params: dict, timeout: float):
    """Parsed JSON, None when LRCLIB has no match, Unavailable when it can't answer."""
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code < 500 and e.code != 429:
            return None  # 404 and other client errors: no match for this query
        raise Unavailable(f"HTTP {e.code}") from e
    except Exception as e:  # timeouts, DNS, TLS, bad JSON
        raise Unavailable(str(e)) from e


def lookup(artist: str, title: str, album: str, duration: float,
           *, waits: tuple[float, ...] = (0, 2), timeout: float = 6) -> tuple[str, dict | None]:
    """('ok', {'lrc', 'synced'}) | ('none', None) | ('unavailable', None).

    The free API answers 502/503 under load, so each wait in `waits` is one
    more attempt after that many seconds."""
    if not ENABLED or not title:
        return "none", None
    for wait in waits:
        if wait:
            time.sleep(wait)
        try:
            exact = _fetch("get", {
                "track_name": title, "artist_name": artist, "album_name": album,
                "duration": str(round(duration)),
            }, timeout) if duration else None
            best = pick_best([exact] if isinstance(exact, dict) else [], duration)
            if best:
                return "ok", as_result(best)
            hits = _fetch("search", {"track_name": title, "artist_name": artist}, timeout)
            best = pick_best(hits if isinstance(hits, list) else [], duration)
            return ("ok", as_result(best)) if best else ("none", None)
        except Unavailable:
            continue
    return "unavailable", None
