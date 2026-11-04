#!/usr/bin/env python3
"""Save synced lyrics next to your songs as .lrc files, from LRCLIB.

Navidrome serves a sidecar `Song.lrc` (same name as `Song.flac`) as that
song's lyrics, and the Brook app asks Navidrome first, so these files make
lyrics instant and independent of LRCLIB being up when you press the button.

    python3 fetch_lrc.py              # dry run: shows what it would do
    python3 fetch_lrc.py --write      # writes the .lrc files
    python3 fetch_lrc.py --write --limit 50

Title, artist, album and length come from Navidrome's database. Songs that
already have a .lrc are skipped, and songs LRCLIB has nothing for are
remembered for 30 days (--retry-misses to ask again). It stops by itself when
LRCLIB stops answering, so just run it again later. Only synced lyrics are
saved; plain ones are skipped. rclone copy (sync-music.sh) never deletes
these extra files.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lrclib import lookup  # noqa: E402
from navidrome_ids import MUSIC_DIR, NAVIDROME_DB  # noqa: E402

MISS_FILE = Path("/opt/automix/lrc-misses.json")
MISS_TTL = 30 * 86400
STOP_AFTER_DOWN = 3  # consecutive "unavailable" answers before giving up for now
PAUSE = 0.4          # seconds between songs, to be polite to a free service


def navidrome_songs(db_path: str, music_dir: str) -> list[dict]:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    try:
        try:
            rows = con.execute(
                "SELECT m.path, m.title, m.artist, m.album, m.duration, l.path"
                " FROM media_file m LEFT JOIN library l ON l.id = m.library_id"
            ).fetchall()
        except sqlite3.OperationalError:
            rows = [(*r, None) for r in con.execute("SELECT path, title, artist, album, duration FROM media_file")]
    finally:
        con.close()
    songs = []
    for path, title, artist, album, duration, root in rows:
        if not os.path.isabs(path):
            path = os.path.join(root or music_dir, path)
        songs.append({"path": os.path.normpath(path), "title": title or "", "artist": artist or "",
                      "album": album or "", "duration": float(duration or 0)})
    return songs


def sidecar(path: str) -> str:
    return os.path.splitext(path)[0] + ".lrc"


def load_misses(file: Path) -> dict[str, float]:
    try:
        return json.loads(file.read_text())
    except (OSError, ValueError):
        return {}


def save_misses(file: Path, misses: dict[str, float]) -> None:
    try:
        file.write_text(json.dumps(misses))
    except OSError as e:
        print(f"could not save {file}: {e}", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true", help="write files (default: dry run)")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many songs asked about")
    ap.add_argument("--retry-misses", action="store_true", help="ask again about songs with no match")
    ap.add_argument("--db", default=NAVIDROME_DB)
    ap.add_argument("--music-dir", default=MUSIC_DIR)
    ap.add_argument("--misses", type=Path, default=MISS_FILE)
    args = ap.parse_args()

    songs = navidrome_songs(args.db, args.music_dir)
    misses = {} if args.retry_misses else load_misses(args.misses)
    now = time.time()
    todo = [s for s in songs
            if s["title"] and not os.path.exists(sidecar(s["path"]))
            and now - misses.get(s["path"], 0) > MISS_TTL]
    print(f"{len(songs)} songs, {len(songs) - len(todo)} skipped (have .lrc, or no match lately), {len(todo)} to ask about")
    if args.limit:
        todo = todo[: args.limit]

    found = plain = none = down = asked = 0
    for s in todo:
        asked += 1
        status, res = lookup(s["artist"], s["title"], s["album"], s["duration"], waits=(0, 3, 10))
        label = f'{s["artist"]} - {s["title"]}'
        if status == "unavailable":
            down += 1
            print(f"  ? {label}: LRCLIB not answering")
            if down >= STOP_AFTER_DOWN:
                print("LRCLIB looks down. Stopping; run again later.")
                break
            continue
        down = 0
        if status == "none":
            none += 1
            misses[s["path"]] = now
            print(f"  - {label}: no match")
        elif not res["synced"]:
            plain += 1
            misses[s["path"]] = now
            print(f"  - {label}: only plain lyrics (skipped)")
        else:
            found += 1
            print(f'  {"+" if args.write else "~"} {label}')
            if args.write:
                tmp = sidecar(s["path"]) + ".tmp"
                Path(tmp).write_text(res["lrc"], encoding="utf-8")
                os.replace(tmp, sidecar(s["path"]))
        time.sleep(PAUSE)

    if args.write:
        save_misses(args.misses, misses)
    verb = "wrote" if args.write else "would write"
    print(f"asked {asked}: {verb} {found}, plain only {plain}, no match {none}")
    if not args.write and found:
        print("Dry run. Add --write to save them.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
