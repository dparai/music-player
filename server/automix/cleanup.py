"""Remove data that belongs to songs that are gone."""

from __future__ import annotations

import sqlite3


def prune_lyrics_cache(conn: sqlite3.Connection, songs: list[tuple[str, float]]) -> int:
    """Delete lyrics_cache rows that no current song matches. Returns the number deleted.

    The cache key is a hash of artist, title, album and duration, so it cannot be
    traced back to a file. Each row also records the title and duration it was
    fetched for; it is kept only while a song with that title and a duration within
    2 s exists. `songs`: (title, duration in s) of every song whose file is still on
    disk. Rows saved before titles were recorded (title IS NULL) cannot be matched
    and go too: they are fetched again if the lyrics are opened.
    """
    known: dict[str, list[float]] = {}
    for title, duration in songs:
        known.setdefault((title or "").strip().lower(), []).append(float(duration or 0))
    stale = []
    for key, title, dur in conn.execute("SELECT key, title, dur FROM lyrics_cache").fetchall():
        durations = known.get((title or "").strip().lower(), ())
        if title is None or not any(abs(d - (dur or 0)) <= 2 for d in durations):
            stale.append((key,))
    conn.executemany("DELETE FROM lyrics_cache WHERE key = ?", stale)
    return len(stale)
