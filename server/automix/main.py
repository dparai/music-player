"""AutoMix DJ Server — Phase 1: Analysis + API (analysis v2)"""

import hashlib
import json
import os
import sqlite3
import sys
import threading
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analysis_v2 import ANALYSIS_VERSION, MAX_DEMUCS_ATTEMPTS, analyze_track as analyze_v2, demucs_available  # noqa: E402
from auth import require_user  # noqa: E402
from navidrome_ids import navidrome_ids  # noqa: E402

# --- Config ---
MUSIC_DIR = Path("/srv/music")
CLIPS_DIR = Path("/var/brook-clips")
DB_PATH = Path("/opt/automix/automix.db")
SUPPORTED_EXTENSIONS = {".flac", ".mp3", ".m4a", ".opus", ".ogg", ".wav"}

app = FastAPI(title="AutoMix DJ Server")

# --- Database ---
_db_lock = threading.Lock()

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    with _db_lock:
        conn = get_db()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS tracks (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                filename TEXT NOT NULL,
                bpm REAL,
                beats TEXT,
                downbeats TEXT,
                confidence REAL,
                mix_in_point REAL,
                mix_out_point REAL,
                duration REAL,
                analyzed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS transitions (
                id TEXT PRIMARY KEY,
                from_track TEXT NOT NULL,
                to_track TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                clip_path TEXT,
                play_plan TEXT,
                created_at TEXT,
                last_used TEXT,
                FOREIGN KEY (from_track) REFERENCES tracks(id),
                FOREIGN KEY (to_track) REFERENCES tracks(id)
            );
        """)
        # v2 columns. grid_source IS NULL marks rows from v1 analysis, which
        # the scanner re-analyses in the background (old data stays served
        # until each track's new row lands).
        have = {r["name"] for r in conn.execute("PRAGMA table_info(tracks)")}
        # analysis_version < ANALYSIS_VERSION (or NULL) is re-analysed the same way.
        for col, typ in [("key", "TEXT"), ("lufs", "REAL"), ("navidrome_id", "TEXT"), ("grid_source", "TEXT"),
                         ("intro_end", "REAL"), ("outro_end", "REAL"), ("bar_energy", "TEXT"),
                         ("bar_bass", "TEXT"), ("bar_vocal", "TEXT"), ("analysis_version", "INTEGER"),
                         ("vocal_source", "TEXT"), ("vocal_attempts", "INTEGER"), ("vocal_error", "TEXT"),
                         ("file_sig", "TEXT")]:
            if col not in have:
                conn.execute(f"ALTER TABLE tracks ADD COLUMN {col} {typ}")
        conn.execute("CREATE INDEX IF NOT EXISTS tracks_navidrome_id ON tracks(navidrome_id)")
        conn.commit()
        conn.close()

# --- Analysis ---
def make_track_id(filepath: str) -> str:
    return hashlib.md5(filepath.encode()).hexdigest()

_scan_lock = threading.Lock()

def link_navidrome_ids(conn: sqlite3.Connection) -> None:
    """Give every row the Navidrome song id for its file (cheap; runs each scan)."""
    ids = navidrome_ids(music_dir=str(MUSIC_DIR))
    for path, song_id in ids.items():
        conn.execute("UPDATE tracks SET navidrome_id = ? WHERE path = ?", (song_id, path))
    conn.commit()

# Set by /rescan (or a second startup scan) while a scan is running: the
# running scan picks up new files before its next track instead of the request
# being dropped. A full re-analysis takes hours (Demucs), and a song synced
# from Drive meanwhile used to wait for the next sync, two days later.
_rescan_requested = threading.Event()
LINK_EVERY = 900  # s: re-link Navidrome IDs during long scans (Navidrome indexes every 15 min)

def scan_and_analyze():
    # Startup and /rescan can both start a scan; never run two at once.
    if not _scan_lock.acquire(blocking=False):
        _rescan_requested.set()
        print("Scan already running: new files will be picked up next.", flush=True)
        return
    try:
        _scan()
    finally:
        _scan_lock.release()

def _list_audio() -> set[str]:
    return {str(f) for f in MUSIC_DIR.rglob("*") if f.is_file() and f.suffix.lower() in SUPPORTED_EXTENSIONS}

def file_sig(path: str) -> str | None:
    """Size and modification time: changes when Drive sync replaces the file."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return f"{st.st_size}:{st.st_mtime_ns}"

def _prune_and_link(on_disk: set[str]) -> tuple[set[str], set[str]]:
    """Drop rows for deleted files, refresh Navidrome IDs. Returns (done, known) paths.

    A row counts as done when it has the current analysis version, its file
    is unchanged (same size and mtime: a re-uploaded song in Drive gets a
    fresh analysis), and its vocals came from Demucs, or Demucs has had its
    MAX_DEMUCS_ATTEMPTS tries (then the backup result stays).
    """
    with _db_lock:
        conn = get_db()
        gone = [row["path"] for row in conn.execute("SELECT path FROM tracks") if row["path"] not in on_disk]
        for path in gone:
            conn.execute("DELETE FROM transitions WHERE from_track = ? OR to_track = ?", (make_track_id(path),) * 2)
            conn.execute("DELETE FROM tracks WHERE path = ?", (path,))
        conn.commit()
        link_navidrome_ids(conn)
        can_retry = demucs_available()
        done = set()
        for row in conn.execute(
                "SELECT path, vocal_source, vocal_attempts, file_sig FROM tracks WHERE analysis_version >= ?",
                (ANALYSIS_VERSION,)):
            sig = file_sig(row["path"])
            if row["file_sig"] is None and sig:
                # Rows from before file signatures: take the file as unchanged.
                conn.execute("UPDATE tracks SET file_sig = ? WHERE path = ?", (sig, row["path"]))
            elif sig and row["file_sig"] != sig:
                continue  # replaced in Drive: analyse again from scratch
            retry = (can_retry and row["vocal_source"] not in ("demucs", "none")
                     and (row["vocal_attempts"] or 0) < MAX_DEMUCS_ATTEMPTS)
            if not retry:
                done.add(row["path"])
        conn.commit()
        known = {row["path"] for row in conn.execute("SELECT path FROM tracks")}
        conn.close()
    if gone:
        print(f"Removed {len(gone)} deleted tracks.", flush=True)
    return done, known

def _vocal_history(path: str, sig: str | None) -> tuple[int, str | None]:
    """(earlier Demucs failures, last failure reason) for this file; reset if the file changed."""
    with _db_lock:
        c = get_db()
        row = c.execute("SELECT vocal_attempts, vocal_error, file_sig FROM tracks WHERE path = ?", (path,)).fetchone()
        c.close()
    if not row or (row["file_sig"] and sig and row["file_sig"] != sig):
        return 0, None
    return row["vocal_attempts"] or 0, row["vocal_error"]

def _save(path: str, r: dict, attempts: int, sig: str | None) -> None:
    with _db_lock:
        c = get_db()
        c.execute("""
            INSERT OR REPLACE INTO tracks
            (id, path, filename, bpm, beats, downbeats, confidence,
             mix_in_point, mix_out_point, duration, analyzed_at,
             key, lufs, grid_source, intro_end, outro_end, bar_energy, bar_bass,
             bar_vocal, analysis_version, vocal_source, vocal_attempts, vocal_error, file_sig,
             navidrome_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    (SELECT navidrome_id FROM tracks WHERE path = ?))
        """, (
            make_track_id(path), path, Path(path).name,
            r["bpm"], r["beats"], r["downbeats"], r["confidence"],
            r["mix_in_point"], r["mix_out_point"], r["duration"],
            r["key"], r["lufs"], r["grid_source"], r["intro_end"], r["outro_end"],
            r["bar_energy"], r["bar_bass"], r["bar_vocal"], r["analysis_version"],
            r["vocal_source"], attempts, r.get("demucs_error"), sig, path,
        ))
        c.commit()
        c.close()

def _analyse_one(path: str) -> None:
    sig = file_sig(path)
    attempts, last_error = _vocal_history(path, sig)
    r = analyze_v2(path, attempts, last_error)
    if r["vocal_source"] == "demucs":
        attempts = 0
    elif r.get("demucs_error") and attempts < MAX_DEMUCS_ATTEMPTS:
        attempts += 1  # Demucs was tried this time and failed
    if r["vocal_source"] != "demucs":
        print(f"  vocals from {r['vocal_source']} (Demucs attempts {attempts}/{MAX_DEMUCS_ATTEMPTS}: "
              f"{r.get('demucs_error') or 'n/a'})", flush=True)
    _save(path, r, attempts, sig)

def _demucs_retry_paths() -> set[str]:
    with _db_lock:
        c = get_db()
        rows = {r["path"] for r in c.execute(
            "SELECT path FROM tracks WHERE analysis_version >= ? AND vocal_source NOT IN ('demucs', 'none')",
            (ANALYSIS_VERSION,))}
        c.close()
    return rows

def _scan():
    try:
        os.nice(10)  # this thread only (Linux): keep Navidrome streaming smooth
    except (OSError, AttributeError):
        pass
    _rescan_requested.clear()
    on_disk = _list_audio()
    done, known = _prune_and_link(on_disk)
    # New files first, then outdated or replaced rows, then Demucs retries.
    retries = _demucs_retry_paths()
    queue = sorted(on_disk - done, key=lambda p: (p in known, p in retries, p))
    if not queue:
        print("No new tracks to analyze.", flush=True)
        return

    print(f"Analyzing {len(queue)} tracks...", flush=True)
    failed: set[str] = set()
    last_link = time.monotonic()
    n = 0
    while queue:
        if _rescan_requested.is_set():
            _rescan_requested.clear()
            on_disk = _list_audio()
            done, known = _prune_and_link(on_disk)
            last_link = time.monotonic()
            queued = set(queue)
            fresh = sorted(p for p in on_disk - done - known - queued - failed)
            queue = fresh + [p for p in queue if p in on_disk]
            if fresh:
                print(f"Rescan: {len(fresh)} new tracks moved to the front.", flush=True)
        elif time.monotonic() - last_link > LINK_EVERY:
            with _db_lock:
                conn = get_db()
                link_navidrome_ids(conn)  # songs Navidrome indexed since
                conn.close()
            last_link = time.monotonic()

        path = queue.pop(0)
        n += 1
        print(f"  [{n}/{n + len(queue)}] {Path(path).name}...", flush=True)
        try:
            _analyse_one(path)
        except Exception as e:
            failed.add(path)
            print(f"  FAILED: {e}", flush=True)

    with _db_lock:
        conn = get_db()
        link_navidrome_ids(conn)  # files new since the start of the scan
        conn.close()
    print("Analysis complete.", flush=True)
    if _rescan_requested.is_set():
        _scan()  # a request arrived during the very last track

# --- API Endpoints ---
@app.get("/automix/health")
async def health():
    return {"status": "ok"}

@app.get("/automix/tracks", dependencies=[Depends(require_user)])
def list_tracks():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, filename, bpm, confidence, mix_in_point, mix_out_point, duration,"
        " navidrome_id, key, lufs FROM tracks ORDER BY filename"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.get("/automix/tracks/{track_id}", dependencies=[Depends(require_user)])
def get_track(track_id: str):
    conn = get_db()
    row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Track not found")
    result = dict(row)
    for k in ("beats", "downbeats", "bar_energy", "bar_bass", "bar_vocal"):
        result[k] = json.loads(result[k]) if result.get(k) else []
    return result

@app.post("/automix/rescan", dependencies=[Depends(require_user)])
def rescan():
    if _scan_lock.locked():
        _rescan_requested.set()
        return {"status": "queued"}  # the running scan picks new files up next
    thread = threading.Thread(target=scan_and_analyze, daemon=True)
    thread.start()
    return {"status": "scan_started"}

@app.get("/automix/stats", dependencies=[Depends(require_user)])
def stats():
    conn = get_db()
    total = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
    analyzed = conn.execute(
        "SELECT COUNT(*) FROM tracks WHERE analysis_version >= ?", (ANALYSIS_VERSION,)).fetchone()[0]
    avg_bpm = conn.execute("SELECT AVG(bpm) FROM tracks WHERE bpm IS NOT NULL").fetchone()[0]
    sources = {r[0] or "pending": r[1] for r in conn.execute(
        "SELECT vocal_source, COUNT(*) FROM tracks WHERE analysis_version >= ? GROUP BY 1", (ANALYSIS_VERSION,))}
    fallbacks = [dict(r) for r in conn.execute(
        "SELECT filename, vocal_source, vocal_attempts, vocal_error FROM tracks"
        " WHERE analysis_version >= ? AND vocal_source NOT IN ('demucs', 'none') ORDER BY filename",
        (ANALYSIS_VERSION,))]
    conn.close()
    return {
        "total_tracks": total,
        "analyzed": analyzed,
        "average_bpm": round(avg_bpm, 1) if avg_bpm else None,
        "vocal_sources": sources,      # demucs / umxl / panns / repet / none
        "vocal_fallbacks": fallbacks,  # songs not on Demucs: attempts so far and why it failed
    }

# --- Startup ---
@app.on_event("startup")
async def startup():
    CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    init_db()
    thread = threading.Thread(target=scan_and_analyze, daemon=True)
    thread.start()

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
