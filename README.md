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

- **Beat Matching** — adjusts playback speed (within +-8%) so the BPMs align during transitions
- **Camelot Wheel** — picks the next song in a harmonically compatible key (so transitions sound musical, not jarring)
- **15-Second Crossfade** — equal-power volume curve with bass EQ crossover, so the low end doesn't mud up during the blend
- **Smart Song Endings** — uses Web Audio `AnalyserNode` to detect silence/fade-outs and start the crossfade early instead of waiting for dead air
- **Server-Side Analysis (AutoMix v2)** — FastAPI server with librosa analyzes every track for precise BPM, beat grid, and mix in/out cue points. The PWA fetches this data and uses server cue points over client-side detection when available

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

During the crossfade:
- **Volume**: equal-power curve (cos/sin) so total energy stays constant
- **Bass EQ**: low-shelf filter sweeps the bass from outgoing to incoming
- **BPM**: incoming track speed-adjusts to match outgoing tempo, then snaps back after

---

## Tech Stack

| Layer | Tech | Why |
|-------|------|-----|
| Frontend | React + TypeScript + Vite | Fast builds, type safety |
| Styling | CSS Modules | Scoped styles, no conflicts |
| Audio | Web Audio API | Crossfade, EQ, silence detection |
| PWA | vite-plugin-pwa + Workbox | Install to homescreen, offline UI |
| Music Server | Navidrome (Subsonic API) | Self-hosted, battle-tested |
| Reverse Proxy | Caddy | Auto HTTPS, zero config |
| Cloud | Oracle Cloud Always Free ARM | Free forever (2 OCPUs, 12GB RAM) |
| Sync | rclone + Google Drive | Drop files in Drive, they appear in Brook |
| Analysis | AutoMix (FastAPI + librosa) | BPM, beat grid, cue point detection |
| Audio Decode | ffmpeg | Pre-decode m4a/AAC for librosa analysis |
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
    automix.ts          AutoMix server client (track data, BPM, cue points)
    dj.ts               Camelot wheel, BPM matching, DJ scoring algorithm
    storage.ts          localStorage persistence (creds, last played, view)
```

### AutoMix Server (on the VM)

```
/opt/automix/
  app/
    main.py             FastAPI server — analysis engine + REST API
  venv/                 Python venv (librosa, fastapi, uvicorn)
  automix.db            SQLite (WAL mode) — track analysis cache
```

The server runs as a systemd service on port 8000. Caddy routes `/automix/*` to it. On startup it scans `/srv/music` recursively, analyzing any new or previously failed tracks. Formats not natively supported by soundfile (m4a, AAC, WMA) are pre-decoded to WAV via ffmpeg before analysis.

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
