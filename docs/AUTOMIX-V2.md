# AutoMix DJ Mode v2 — Server-Side Transitions

> Server renders pro-quality DJ transitions. Phone plays them. Falls back to v1 browser crossfade if clip isn't ready.

## How It Works

```
Phone plays Song A
    |
    | Song A starts → POST /automix/transitions {from: A, to: B}
    |
    | Server renders clip in background:
    |   librosa (BPM + beats) → Rubber Band (time-stretch) → pedalboard (EQ + fade)
    |
    | Song A reaches cue point AND clip ready?
    |     YES → play server-rendered clip → Song B at offset
    |     NO  → fall back to v1 browser crossfade
    |
Phone plays Song B
```

## Features

| Feature | How |
|---------|-----|
| Beatmatching | Both songs play at the same tempo during transition |
| Beat-grid alignment | Downbeats of both songs land together |
| Bass swap | One bassline fades out as the other fades in, never both at once |
| Smart cue points | Mix starts at a musical phrase boundary |
| Pitch-locked stretching | Speed changes without pitch change (Rubber Band) |
| Automatic fallback | v1 browser crossfade runs if server clip isn't ready |

## Architecture

```
Google Drive → rclone (48h) → Oracle VM
                                  |
                    +-------------+-------------+
                    |             |             |
                Navidrome    AutoMix API    Caddy
              (Subsonic)    (FastAPI:8000)  (HTTPS)
                    |             |             |
                    +-------------+-------------+
                                  |
                          dpkmusic.duckdns.org
                                  |
                    /rest/*  →  Navidrome
                    /automix/* → FastAPI
                    /*       →  Brook PWA
```

## Tech Stack

| Job | Tool |
|-----|------|
| API + streaming | FastAPI (Python) |
| BPM + beats | librosa (not madmom — won't compile on ARM) |
| Time-stretching | Rubber Band via pyrubberband (available on arm64) |
| EQ, fades, limiter | pedalboard (Spotify) |
| Song data | SQLite with WAL mode |
| Background jobs | threading + queue |
| Audio decode/encode | ffmpeg |

## BPM Tier System

| BPM gap | Beatmatch? | Stretch | Overlap |
|---------|-----------|---------|---------|
| 0-6 | Yes | Song B only | 16 bars |
| 6-12 | Yes | Song B only (up to 10%) | 16 bars |
| 12-20 | Yes | Song B only + ramp back | 8 bars |
| 20+ | No | None — EQ crossfade only | ~10 seconds |

Half/double-time matches (70 vs 140 BPM) count as 0 gap.

Safety: if stretch exceeds 10%, drop to next tier.

## Cue Points (v2 — simple)

- **Mix-out:** `duration - overlap_length`
- **Mix-in:** first beat after 2 seconds

Upgrade to energy-based detection in v2.1.

## Gapless Playback (phone side)

Server renders clip with Song A's last 2s and Song B's first 2s baked in:

```
Song A: ████████████████|==|
                     clip: |==TRANSITION==|
                                       |==|Song B: ████████████████
```

Phone does:
1. Stop Song A at `cue_out - 2s`
2. Play clip (contains Song A's tail → blend → Song B's head)
3. Start Song B at `cue_in + 2s` with 50ms micro-crossfade

No sample-accurate scheduling needed. HTMLAudioElement handles it.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /automix/tracks | Library with analysis data |
| POST | /automix/transitions | Request transition render (returns job_id) |
| GET | /automix/transitions/{job_id} | Job status + play plan when ready |
| GET | /automix/transitions/{job_id}/clip | Stream the rendered clip |
| POST | /automix/rescan | Trigger re-analysis of new songs |

Auth: `Authorization: Bearer <token>` header on all endpoints.

## Cache Strategy

- Max 50 clips in `/var/brook-clips/`
- LRU eviction: on new render, delete oldest if count > 50
- ~3MB per clip = 150MB worst case
- SQLite tracks clip path + last_used timestamp

## SQLite Schema

```sql
CREATE TABLE tracks (
    id TEXT PRIMARY KEY,          -- Navidrome song ID
    path TEXT NOT NULL,
    bpm REAL,
    beats TEXT,                   -- JSON array of beat times
    downbeats TEXT,               -- JSON array (estimated: every 4th beat)
    confidence REAL,
    mix_in_point REAL,
    mix_out_point REAL,
    duration REAL,
    analyzed_at TEXT
);

CREATE TABLE transitions (
    id TEXT PRIMARY KEY,
    from_track TEXT NOT NULL,
    to_track TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- pending, rendering, ready, failed
    clip_path TEXT,
    play_plan TEXT,                -- JSON: {stop_a_at, clip_duration, start_b_at}
    created_at TEXT,
    last_used TEXT,
    FOREIGN KEY (from_track) REFERENCES tracks(id),
    FOREIGN KEY (to_track) REFERENCES tracks(id)
);
```

## Analysis Trigger

- FastAPI scans music directory on startup
- Analyzes any file not in SQLite
- Cron hits `POST /automix/rescan` after rclone sync

## Resolved Risks

| Risk | Resolution |
|------|-----------|
| madmom won't compile on ARM | Use librosa. Estimate downbeats by grouping beats into 4s |
| Rubber Band on ARM | Available via `apt install rubberband-cli` (confirmed arm64) |
| 2 CPUs too slow | Request transition when song starts (3-4 min headroom). Fallback to v1 if not ready |
| Gapless playback hard | Bake Song A tail + Song B head into clip. 50ms micro-crossfade at seams |
| SQLite concurrency | WAL mode. Single writer thread, FastAPI reads only |
| No API auth | Bearer token header |
| Meet-in-the-middle risky | Stretch Song B only. Simpler, less audible |

## Build Order

1. **FastAPI + SQLite** on VM behind Caddy `/automix/*` route
2. **Analysis pipeline:** librosa BPM + beats + cue points → SQLite
3. **EQ crossfade renderer:** pedalboard, no beatmatching yet
4. **PWA integration:** new `automix.ts` client, transition request on song start
5. **Phone playback:** `if (clipReady) playClip() else v1Crossfade()`
6. **Rubber Band beatmatching** (tiers 0-12)
7. **Tune cue points**, add tier 12-20

Each step is independently deployable. v1 crossfade works at every step.
