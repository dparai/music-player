"""Synced (time-stamped) lyrics from LRCLIB, for finding the chorus.

lrclib.net is free and needs no key. Only the file name (artist and title)
and the duration are sent. Set AUTOMIX_LYRICS=0 to turn this off; the hook
detector then works from the audio alone.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ENABLED = os.environ.get("AUTOMIX_LYRICS", "1") != "0"
API = "https://lrclib.net/api/search"
UA = "Brook-AutoMix/1.0 (self-hosted music player)"
TIMEOUT = 15


def _query(path: str) -> str:
    """'AP Dhillon - With You (Official).flac' -> 'AP Dhillon With You'."""
    stem = Path(path).stem
    stem = re.sub(r"\((?:official|lyric|audio|video|visuali[sz]er|hd|hq)[^)]*\)|\[[^\]]*\]", " ", stem, flags=re.I)
    stem = re.sub(r"\b(feat|ft)\.?\b", " ", stem, flags=re.I)
    return re.sub(r"[_\-–]+", " ", stem).strip()


def get_synced_lyrics(path: str, duration: float) -> str | None:
    """LRC text for the best match within 4 s of `duration`, '' if none, None on network error."""
    if not ENABLED:
        return ""
    url = API + "?" + urllib.parse.urlencode({"q": _query(path)})
    results = None
    # The free API answers 503 under load and occasionally drops a connection:
    # back off and retry a few times before leaving it for the next scan.
    for wait in (0, 2, 6, 15):
        time.sleep(wait)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                results = json.load(r)
            break
        except Exception:
            continue
    if results is None:
        return None  # try again next scan
    best = None
    for item in results if isinstance(results, list) else []:
        synced = item.get("syncedLyrics")
        d = item.get("duration")
        if not synced or not isinstance(d, (int, float)) or abs(d - duration) > 4:
            continue
        if best is None or abs(d - duration) < abs(best["duration"] - duration):
            best = item
    return best["syncedLyrics"] if best else ""
