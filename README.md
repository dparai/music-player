# Brook

> *"What aستميع complement to being alive!"* — Brook, Soul King

A personal music streaming PWA themed after the Straw Hat Pirates' beloved skeleton musician. Stream your own music library from anywhere, with DJ-grade crossfading and beat matching.

---

## How It Works

```
Your Music Collection
        |
        v
  Google Drive  -----> rclone sync (every 48h) -----> Oracle Cloud VM
                                                          |
                                        +-----------------+-----------------+
                                        |                 |                 |
                                    Navidrome         Caddy            AutoMix
                                  (music server)   (HTTPS proxy)   (FastAPI + librosa)
                                        |                 |                 |
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
2. `rclone` syncs them to an Oracle Cloud server every 48 hours
3. **Navidrome** indexes and serves the music via the Subsonic API
4. **Caddy** handles HTTPS with auto-renewing certificates
5. **AutoMix** (FastAPI + librosa) analyzes each track's BPM, beats, and cue points
6. **Brook** (this PWA) plays it all in your browser with a slick UI, pulling server-side analysis for smarter transitions

---

## The Fun Parts

### DJ Mode

Brook doesn't just play the next song — it **mixes** like a real DJ:

- **Beat Sync** — the mix starts exactly on a downbeat, the incoming song is tempo-matched (up to ±6%, pitch preserved) and phase-locked to the outgoing beat (within ~10 ms), then eases back to its own tempo
- **Camelot Wheel** — picks the next song in a harmonically compatible key (so transitions sound musical, not jarring)
- **Adaptive Transitions** — every mix is planned for the two songs: as long as the incoming intro (1 to 32 bars), shorter when both songs are loud, cut before two vocals would overlap, never into silence. The bass swaps exactly when the incoming bass comes in
- **Bass Swap** — only one bassline at a time: the bass changes hands in one bar in the middle of the mix, with no mud and no mid-mix bass hole
- **Outro Cues** — the server finds where each song's outro starts and mixes there, not just "15 s before the end"
- **Loudness Levelling** — every song trimmed to about −14 LUFS, plus a master limiter, so volume doesn't jump between songs
- **Smart Song Endings** — detects real silence/fade-outs and starts the mix early instead of waiting for dead air
- **Server-Side Analysis (AutoMix)** — FastAPI + librosa on the VM: BPM, beat grid with real downbeats, cue points, key, loudness, and a per-bar structure profile (energy, bass, intro/outro, and vocals from Demucs source separation) for every song, matched to Navidrome song IDs

### How DJ Song Selection Works

```
Current song: 120 BPM, key of Am (Camelot 8A)

Scoring each candidate:
  "Song X" — 122 BPM (+40 pts), key Dm/7A (+35 pts) = 75   <-- great pick
  "Song Y" — 85 BPM (+0 pts),  key F#/2B (+0 pts)  = 0    <-- skip
  "Song Z" — 118 BPM (+30 pts), key Am/8A (+50 pts) = 80   <-- even better

Pick randomly from the top 5, weighted by score.
```

### Dual Deck Architecture

Brook runs two `<audio>` elements (Deck A and Deck B), like real DJ turntables:

```
Deck A: ████████████████░░░░  (playing, fading out)
                         \
                          \  ← crossfade zone (15s)
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
- **Volume**: equal-power curve (cos/sin) so total energy stays constant
- **Bass**: the low shelf compensates for the fader, so bass level stays flat (0 dB) through the whole mix
- **Tempo**: incoming deck is tempo-matched and nudged every 100 ms to stay on the beat, then eases back over 4 bars
- **Pause / Next**: pausing freezes the mix; Next jumps straight to the incoming song

Details and the plan for server-rendered transitions: [docs/AUTOMIX-V2.md](docs/AUTOMIX-V2.md).

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
| Cloud | Oracle Cloud Always Free ARM | Free forever (2 OCPUs, 12GB RAM) |
| Sync | rclone + Google Drive | Drop files in Drive, they appear in Brook |
| Analysis | AutoMix (FastAPI + librosa) | BPM, beat grid, cue point detection |
| Audio Decode | ffmpeg | Decoding for analysis, EBU R128 loudness |
| DNS | DuckDNS | Free subdomain with auto-updating IP |

---

## Project Structure

```
src/
  App.tsx              Main app — routing, state, DJ song selection
  components/
    Login.tsx           Subsonic auth (salted token, not plain password)
    NowPlaying.tsx      The big one — dual deck engine, crossfade, Web Audio
    Library.tsx         Virtual-scrolled song list with search
    MiniPlayer.tsx      Bottom bar with play/pause and progress
  lib/
    subsonic.ts         Subsonic API client (getAllSongs, stream, coverArt)
    automix.ts          AutoMix server client (track data, beat grids, cue points)
    dj.ts               Camelot wheel, tempo matching, crossfade curves, DJ scoring
    match.ts            Song ↔ analysis matching (normalized filenames)
    storage.ts          localStorage persistence (creds, last played, view)
```

### AutoMix Server (on the VM)

```
/opt/automix/
  app/
    main.py             FastAPI server — scanning + REST API
    analysis_v2.py      BPM, beats, downbeats, cue points, key, loudness
    navidrome_ids.py    File path → Navidrome song ID
    auth.py             Verifies Brook users against Navidrome
  venv/                 Python venv (librosa, fastapi, uvicorn)
  automix.db            SQLite (WAL mode) — track analysis cache
```

The source lives in [`server/automix/`](server/automix/README.md). The server runs as a systemd service on port 8000, and Caddy routes `/automix/*` to it. On startup, and after every Drive sync (`sync-music.sh` calls `/automix/rescan`), it scans `/srv/music`: it analyses new songs, re-analyses old v1 rows in the background, and drops songs that were deleted. Analysis runs at low priority so streaming stays smooth.

---

## Running Locally

```bash
npm install
npm run dev
```

The dev server proxies `/rest/*`, `/api/*`, and `/automix/*` to the production instance, so you can develop against real data.

---

## Deploying

```bash
npm run build
scp -r dist/. ubuntu@your-server:/var/www/brook/
```

That's it. Caddy serves the static files and proxies Subsonic API calls to Navidrome.

---

## The Name

Brook is the musician of the Straw Hat Pirates in One Piece. He's a skeleton who ate the Revive-Revive Fruit, came back to life, and now plays music that moves souls. His catchphrase "Yohohoho!" is the login screen greeting.

*Soul King Brook would approve of beat-matched crossfades.*
