# AutoMix v2 analysis — deploy notes

These files replace/sit next to `/opt/automix/app/main.py` on the VM.
`main.py` here is the VM's copy (as of 2026-10-25) with v2 already wired in:
it migrates the DB itself on startup (no sqlite3 CLI needed), re-analyses v1
rows in the background (~15 s per song, ~45 min for 169 songs on 2 OCPUs,
old data stays served meanwhile), drops rows for deleted files, never runs
two scans at once, and fills `navidrome_id`. Steps 2–5 below are done by it;
the service runs as `ubuntu`, which already owns navidrome.db. The PWA works
with or without this deployed: the new fields are optional.

| File | What it does |
|------|--------------|
| `analysis_v2.py` | `analyze_track(path)` → bpm, beats, **real downbeats**, confidence, phrase-aligned `mix_in_point`/`mix_out_point`, `key`, `lufs` |
| `navidrome_ids.py` | `{file path: Navidrome song id}` from Navidrome's DB, for exact matching in the PWA |
| `auth.py` | FastAPI dependency: verifies the Brook user against Navidrome (the bearer token is public in the JS bundle) |
| `sync-music.sh` | rclone sync + automatic `/automix/rescan` |

## 1. Copy and install

```bash
scp server/automix/*.py ubuntu@163.192.42.202:/opt/automix/app/
scp server/automix/sync-music.sh ubuntu@163.192.42.202:/opt/automix/
ssh ubuntu@163.192.42.202
sudo chmod +x /opt/automix/sync-music.sh
# Optional but recommended: neural downbeats (CPU-only torch, ~700 MB)
/opt/automix/venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
/opt/automix/venv/bin/pip install https://github.com/CPJKU/beat_this/archive/main.zip
# Sanity check on one file
/opt/automix/venv/bin/python /opt/automix/app/analysis_v2.py "/srv/music/<some song>.flac"
```

Without `beat_this`, `analysis_v2` falls back to librosa with a downbeat
phase estimate (kick energy + chord changes), which is already better than v1's
"every 4th beat from beat 0".

## 2. Database migration

```sql
-- sqlite3 /opt/automix/automix.db
ALTER TABLE tracks ADD COLUMN key TEXT;
ALTER TABLE tracks ADD COLUMN lufs REAL;
ALTER TABLE tracks ADD COLUMN navidrome_id TEXT;
ALTER TABLE tracks ADD COLUMN grid_source TEXT;
CREATE INDEX IF NOT EXISTS tracks_navidrome_id ON tracks(navidrome_id);
```

## 3. Use the new analysis in main.py

Where main.py analyses a file (librosa load → `beat_track` → cue points),
call `analyze_track(path)` instead and store every returned key. Then set
`navidrome_id` from `navidrome_ids()` (read the map once per scan, not once per file).
To re-analyse the existing library, clear the rows and rescan. A few hundred
tracks takes about 1–2 h on 2 OCPUs.

## 4. Return the new fields

`GET /automix/tracks` should include `navidrome_id`, `key` and `lufs` per track.
`GET /automix/tracks/{id}` already returns `beats`/`downbeats`; the PWA now uses them.

## 5. Auth

```python
from fastapi import Depends
from auth import require_user
# add dependencies=[Depends(require_user)] to /tracks, /tracks/{id}, /rescan, /stats
```

The automix user needs read access to Navidrome's DB for step 3:
`sudo usermod -aG navidrome <automix-user>` and `sudo chmod g+r /var/lib/navidrome/navidrome.db*`.

## 6. Keep streaming smooth while analysing

In `automix.service` under `[Service]`: `Nice=10`, `IOSchedulingClass=idle`, `CPUQuota=100%`
(one of the two cores). Then `sudo systemctl daemon-reload && sudo systemctl restart automix`.

## 7. Cron

Replace the rclone crontab line with:
`0 4 */2 * * /opt/automix/sync-music.sh >> /var/log/brook-sync.log 2>&1`
(set `RCLONE_REMOTE` in the script to your remote name).
