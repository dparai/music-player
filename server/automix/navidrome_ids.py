"""Map AutoMix file paths to Navidrome song IDs.

The PWA matched songs to analysis by guessing filenames from title/artist,
which misses track-number prefixes, "feat." credits and punctuation. Navidrome
already knows the path of every song it serves, so read its database and give
each AutoMix row the exact `navidrome_id` the PWA receives as `song.id`.

The automix service user needs read access to navidrome.db and its -wal/-shm
files (e.g. add it to the navidrome group, `chmod g+r` the three files).
"""

from __future__ import annotations

import os
import sqlite3

NAVIDROME_DB = "/var/lib/navidrome/navidrome.db"
MUSIC_DIR = "/srv/music"


def navidrome_ids(db_path: str = NAVIDROME_DB, music_dir: str = MUSIC_DIR) -> dict[str, str]:
    """{absolute file path: navidrome song id}. Empty dict if the DB can't be read."""
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return {}
    try:
        try:
            # Navidrome >= 0.55 stores paths relative to a library root.
            rows = con.execute(
                "SELECT m.id, m.path, l.path FROM media_file m LEFT JOIN library l ON l.id = m.library_id"
            ).fetchall()
        except sqlite3.OperationalError:
            rows = [(i, p, None) for i, p in con.execute("SELECT id, path FROM media_file")]
    except sqlite3.Error:
        return {}
    finally:
        con.close()

    out: dict[str, str] = {}
    for song_id, path, root in rows:
        if not os.path.isabs(path):
            path = os.path.join(root or music_dir, path)
        out[os.path.normpath(path)] = song_id
    return out
