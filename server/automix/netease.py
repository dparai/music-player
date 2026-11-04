"""Backup lyrics source, used only when LRCLIB has nothing or is down.

Uses NetEase Cloud Music's public web endpoints (no key). This is an
unofficial API, so treat it as best effort: any failure is just "no answer".
Only title, artist and duration are sent.
"""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request

API = "https://music.163.com/api"
UA = "Mozilla/5.0 (X11; Linux x86_64) Brook-AutoMix/1.0"
DURATION_SLACK = 5.0
_TS = re.compile(r"\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]")
# NetEase puts credit lines ("作词 : …") at the top as if they were lyrics.
_CREDIT = re.compile(r"^(?:\[[^\]]*\])*\s*(?:作词|作曲|编曲|制作人?|词|曲|混音|母带|监制|录音|和声|吉他|贝斯|鼓|弦乐|策划|出品|发行|OP|SP|Lyrics?|Composer|Arranger|Producer)\s*[:：]", re.I)


def clean(text: str) -> str:
    return "\n".join(l for l in text.splitlines() if not _CREDIT.match(l.strip())).strip()


def _norm(s: str) -> str:
    s = re.sub(r"[\(\[].*?[\)\]]", " ", s or "")  # "(Radio Edit)", "[Remastered]"
    return re.sub(r"[^\w]+", " ", s.lower()).strip()


def pick_song(songs: list, title: str, artist: str, duration: float) -> dict | None:
    """The search hit whose title, artist and length all agree with the file."""
    t, a = _norm(title), _norm(artist)
    best, best_gap = None, None
    for s in songs or []:
        if not isinstance(s, dict):
            continue
        st = _norm(s.get("name", ""))
        if not st or not t or not (st == t or st in t or t in st):
            continue
        names = [_norm(x.get("name", "")) for x in s.get("artists") or [] if isinstance(x, dict)]
        if a and not any(n and (n in a or a in n) for n in names):
            continue
        ms = s.get("duration")
        gap = abs(ms / 1000 - duration) if duration and isinstance(ms, (int, float)) else 0
        if duration and gap > DURATION_SLACK:
            continue
        if best is None or gap < best_gap:
            best, best_gap = s, gap
    return best


def _get(path: str, params: dict, timeout: float):
    req = urllib.request.Request(f"{API}/{path}?{urllib.parse.urlencode(params)}", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def lookup(artist: str, title: str, duration: float, *, timeout: float = 6) -> dict | None:
    """{'lrc', 'synced'} or None. Never raises."""
    try:
        res = _get("search/get", {"s": f"{title} {artist}".strip(), "type": 1, "limit": 10}, timeout)
        song = pick_song((res.get("result") or {}).get("songs"), title, artist, duration)
        if not song:
            return None
        data = _get("song/lyric", {"id": song["id"], "lv": 1}, timeout)
        text = clean((data.get("lrc") or {}).get("lyric") or "")
        if not text or data.get("nolyric") or data.get("uncollected"):
            return None
        return {"lrc": text, "synced": bool(_TS.search(text))}
    except Exception:
        return None
