# Brook

> *"Yohohoho!"* — Brook, Soul King

A personal music streaming PWA themed after the Straw Hat Pirates' beloved skeleton musician. Stream your own music library from anywhere, with a DJ mode that mixes songs like a real DJ: on the beat, on the phrase, planned for each pair of songs.

---

## How It Works

```
Your Music Collection
        |
        v
  Google Drive  -----> rclone copy (daily, 00:00) -----> Oracle Cloud VM (Always Free, ARM)
                                                          |
                                        +-----------------+-----------------+
                                        |                 |                 |
                                    Navidrome         Caddy            AutoMix
                                  (music server)   (HTTPS proxy)   (FastAPI + librosa
                                        |                 |          + Demucs)
                                        +-----------------+-----------------+
                                                          |
                                                          v
                                                   dpkmusic.duckdns.org
                                                          |
                                                          v
                                                    Brook PWA
                                                 (your browser)
```

**In plain English:**

1. You drop music files into Google Drive
2. Every night at midnight, `rclone` copies new or changed songs to an Oracle Cloud server (songs already there aren't downloaded again)
3. **Navidrome** indexes and serves the music via the Subsonic API
4. **Caddy** handles HTTPS with auto-renewing certificates
5. **AutoMix** analyses each *new* song once (~2 min): tempo, beat grid with real downbeats, key, loudness, where the intro ends and the outro starts, and where the vocals are (Demucs AI source separation)
6. **Brook** (this PWA) plays it all in your browser and uses that analysis to plan every DJ transition

---

## The Fun Parts

### DJ Mode

Brook doesn't just play the next song — it **mixes** like a real DJ:

- **Beat Sync** — the mix starts exactly on a downbeat, the incoming song is tempo-matched (up to ±6%, pitch preserved) and phase-locked to the outgoing beat (within ~10 ms), then eases back to its own tempo
- **Camelot Wheel** — picks the next song in a harmonically compatible key (so transitions sound musical, not jarring)
- **Adaptive Transitions** — every mix is planned for the two songs: as long as the incoming intro (1 to 32 bars), shorter when both songs are loud, cut before two vocals would overlap, never into silence. The screen shows the plan while mixing (`MIX 8 BARS`)
- **Bass Swap** — only one bassline at a time: the bass changes hands in one bar, exactly when the incoming song's bass comes in. No mud, no bass hole
- **Outro Cues** — the server finds where each song's outro starts (within its last 40 s) and mixes there, not in a bridge or "15 s before the end"
- **Loudness Levelling** — every song trimmed to about −14 LUFS, plus a master limiter, so volume doesn't jump between songs
- **Smart Song Endings** — detects real silence/fade-outs and starts the mix early instead of waiting for dead air
- **Reliable Vocal Detection** — Demucs separates the vocals from the music to see who is singing when. If it ever fails, it's retried with safer settings, and backed up by Open-Unmix, then a PANNs singing classifier, then a heuristic, so every song always gets a vocal map

### How DJ Song Selection Works

```
Current song: 120 BPM, key of Am (Camelot 8A)

Scoring each candidate:
  "Song X" — 122 BPM (+40 pts), key Dm/7A (+35 pts) = 75   <-- great pick
  "Song Y" — 85 BPM (+0 pts),  key F#/2B (+0 pts)  = 0    <-- skip
  "Song Z" — 118 BPM (+30 pts), key Am/8A (+50 pts) = 80   <-- even better

Pick randomly from the top 5, weighted by score.
```

Key and BPM come from the AutoMix server (whole-song analysis) when available.

### How a Transition Is Planned

```
Outgoing song:  ... last chorus | OUTRO ████████████░░░░ (silence)
                                ^ mix starts on this downbeat
Incoming song:                  | INTRO (no bass) ░░░░░░░| MAIN ███...
                                                       ^ bass swap here
Mix length: incoming intro length, capped by the outgoing outro,
            shorter if both are loud or two vocals would overlap,
            snapped to 1 / 2 / 4 / 8 / 16 / 32 bars
```

### Dual Deck Architecture

Brook runs two `<audio>` elements (Deck A and Deck B), like real DJ turntables:

```
Deck A: ████████████████░░░░  (playing, fading out)
                         \
                          \  ← mix zone (1–32 bars, planned per pair)
                           \
Deck B: ░░░░░░████████████████  (fading in, becomes active)
```

Each deck is a Web Audio channel strip, and every fade curve runs on the audio thread (sample-accurate, not a JS timer):

```
<audio> → loudness trim → analyser → low-shelf (bass swap) → fader ┐
                                                                    ├→ limiter → speakers
<audio> → loudness trim → analyser → low-shelf (bass swap) → fader ┘
```

During the mix:
- **Volume**: equal-power curve (cos/sin), with the crossover at the bass-swap point
- **Bass**: the low shelf compensates for the fader, so bass level stays flat through the whole mix
- **Tempo**: incoming deck is tempo-matched and nudged every 100 ms to stay on the beat, then eases back over 4 bars
- **Pause / Next**: pausing freezes the mix; Next jumps straight to the incoming song

Design notes and the plan for server-rendered transitions: [docs/AUTOMIX-V2.md](docs/AUTOMIX-V2.md).

---

## Tech Stack

| Layer | Tech | Why |
|-------|------|-----|
| Frontend | React + TypeScript + Vite | Fast builds, type safety |
| Styling | CSS Modules | Scoped styles, no conflicts |
| Audio | Web Audio API | Beat-synced mixing, bass swap, limiter, silence detection |
| PWA | vite-plugin-pwa + Workbox | Install to homescreen, offline UI |
| Music Server | Navidrome (Subsonic API) | Self-hosted, battle-tested |
| Reverse Proxy | Caddy | Auto HTTPS, zero config |
| Cloud | Oracle Cloud Always Free ARM | Free (2 OCPUs, 12 GB RAM, 200 GB disk); Brook uses ~13 GB disk, ~1–2.5 GB RAM |
| Sync | rclone + Google Drive (daily cron) | Drop files in Drive, they appear in Brook the next day |
| Analysis | AutoMix (FastAPI + librosa) | Beat grid, downbeats, cue points, key, loudness, song structure |
| Vocal Detection | Demucs → Open-Unmix → PANNs → heuristic | AI source separation on CPU (ARM), with backups |
| Audio Decode | ffmpeg | Decoding for analysis, EBU R128 loudness |
| DNS | DuckDNS | Free subdomain |

---

## Project Structure

```
src/
  App.tsx              Main app — routing, state, DJ song selection
  components/
    Login.tsx           Subsonic auth (salted token, not plain password)
    NowPlaying.tsx      The big one — dual-deck engine, beat sync, Web Audio
    Library.tsx         Virtual-scrolled song list with search
    MiniPlayer.tsx      Bottom bar with play/pause and progress
    BottomNav.tsx       Now Playing / Library tabs
  lib/
    subsonic.ts         Subsonic API client (getAllSongs, stream, coverArt)
    automix.ts          AutoMix server client (track data, beat grids, structure)
    dj.ts               Camelot wheel, tempo matching, transition planner, crossfade curves
    match.ts            Song ↔ analysis matching (Navidrome IDs, normalized filenames)
    storage.ts          localStorage persistence (creds, last played, view)
server/
  automix/              AutoMix server source (deployed to /opt/automix/app)
  analyze.py            Legacy BPM/key analysis.json generator
docs/
  AUTOMIX-V2.md         DJ engine design notes
```

### AutoMix Server (on the VM)

```
/opt/automix/
  app/
    main.py             FastAPI server — scanning, retries, REST API
    analysis_v2.py      Beats, downbeats, cues, key, loudness, structure, vocal fallback chain
    vocals_separate.py  Vocal separation (Demucs / Open-Unmix)
    vocals_classify.py  Singing classifier (PANNs)
    navidrome_ids.py    File path → Navidrome song ID
    auth.py             Verifies Brook users against Navidrome
  venv/                 Python venv (librosa, fastapi, uvicorn)
  automix.db            SQLite (WAL mode) — track analysis cache
/opt/demucs/venv/       Separate venv for the AI models (CPU torch, demucs, openunmix, panns)
```

The source and deploy notes live in [`server/automix/`](server/automix/README.md). The server runs as a systemd service on 127.0.0.1:8000, and Caddy routes `/automix/*` to it.

**What gets analysed when:** every night the sync triggers a rescan, which only analyses new songs, songs you replaced in Drive, and songs whose Demucs run failed before (up to 3 retries, each with a safer strategy). Everything else is skipped, so a normal night takes about 40 s. A full re-analysis only happens once, after an analysis upgrade. Analysis runs at low priority so streaming stays smooth.

---

## Security

- The app carries **no secret**: AutoMix requests are signed with your Navidrome login (salted token) and checked against Navidrome
- Local scripts use a private token on the VM, accepted only from inside the VM
- SSH is key-only; only ports 22, 80 and 443 are open; Navidrome and AutoMix listen on localhost only

---

## Running Locally

```bash
npm install
npm run dev
```

The dev server proxies `/rest/*`, `/api/*`, and `/automix/*` to the production instance, so you can develop against real data.

---

## Deploying

The app (the web folder is owned by `www-data`, so the copy needs `sudo`):

```bash
npm run build
scp -i ~/.ssh/your_key -r dist/. ubuntu@your-server:/tmp/brook-dist/
ssh -i ~/.ssh/your_key ubuntu@your-server 'sudo rm -rf /var/www/brook/assets && sudo cp -r /tmp/brook-dist/. /var/www/brook/ && sudo chown -R www-data:www-data /var/www/brook && rm -rf /tmp/brook-dist'
```

The AutoMix server: see [`server/automix/README.md`](server/automix/README.md).

Installed apps update themselves on their next launch.

---

## The Name

Brook is the musician of the Straw Hat Pirates in One Piece. He's a skeleton who ate the Revive-Revive Fruit, came back to life, and now plays music that moves souls. His catchphrase "Yohohoho!" is the login screen greeting.

*Soul King Brook would approve of beat-matched crossfades.*
