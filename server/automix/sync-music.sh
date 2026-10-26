#!/bin/bash
# /home/ubuntu/sync-music.sh, run by cron daily at 00:00 (0 0 * * *).
# Same as the original, plus the AutoMix rescan at the end: before, new
# songs only got DJ data (beat grid, cues, key, loudness) when the
# automix service restarted.
LOG="/home/ubuntu/music-sync.log"
LOCK="/tmp/music-sync.lock"
exec 200>"$LOCK"
flock -n 200 || exit 0
echo "$(date): Starting sync" >> "$LOG"
rclone copy "gdrive:My Music" /srv/music --transfers 4 --checkers 8 --log-file "$LOG" --log-level INFO
echo "$(date): Sync complete" >> "$LOG"
echo "$(date): Running BPM/key analysis" >> "$LOG"
/opt/brook-analysis/venv/bin/python /opt/brook-analysis/analyze.py >> "$LOG" 2>&1
echo "$(date): Analysis complete" >> "$LOG"
echo "$(date): Triggering AutoMix rescan" >> "$LOG"
# Local-only token, kept out of the repo (mode 600, also used by automix.service).
AUTOMIX_TOKEN=$(sed -n 's/^AUTOMIX_TOKEN=//p' /opt/automix/automix.env)
curl -fsS -X POST http://127.0.0.1:8000/automix/rescan \
  -H "Authorization: Bearer ${AUTOMIX_TOKEN}" >> "$LOG" 2>&1
echo >> "$LOG"
