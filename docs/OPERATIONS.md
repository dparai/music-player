# Brook: how it runs on the server

Everything that lives outside this repo's source files but that Brook depends on.
Host: Oracle Cloud Always Free ARM VM (2 cores, 12 GB RAM). Real address: **dpkmusic.duckdns.org**.
(`deepakmusic.duckdns.org` is listed in Caddy but has no DNS record.)

## Layout

| What | Where |
|---|---|
| The app (built `dist/`) | `/var/www/brook` (owned by `www-data`) |
| Navidrome (music server, Subsonic API) | `127.0.0.1:4533`, proxied as `/rest/*` |
| AutoMix (analysis API) | `127.0.0.1:8000`, proxied as `/automix/*`; code in `/opt/automix/app`, database `/opt/automix/automix.db` |
| Old BPM/key file | `/opt/brook-analysis/analysis.json`, served as `/api/analysis.json` |
| Music | `/srv/music` (a mirror of the Google Drive folder `My Music`) |
| Nightly job | `/home/ubuntu/sync-music.sh`, cron `0 0 * * *`; log `/home/ubuntu/music-sync.log` |
| Dynamic DNS | `~/duckdns/duck.sh`, cron every 5 minutes |

## Caddy (the Brook site block in `/etc/caddy/Caddyfile`)

```
deepakmusic.duckdns.org, dpkmusic.duckdns.org {
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
    }

    # Compress text only: app files and JSON. Never audio or images (already
    # compressed, and compressing a stream would break byte-range seeking).
    @compressible path / *.html *.js *.css *.json *.svg *.webmanifest /automix/* /api/analysis.json
    encode @compressible zstd gzip

    handle /rest/* { reverse_proxy 127.0.0.1:4533 }
    handle /api/analysis.json {
        header Access-Control-Allow-Origin *
        header Content-Type application/json
        root * /opt/brook-analysis
        rewrite * /analysis.json
        file_server
    }
    handle /automix/* { reverse_proxy 127.0.0.1:8000 }

    handle {
        root * /var/www/brook
        # Files with a hash in the name never change: cache them for a year.
        @hashed path /assets/*
        header @hashed Cache-Control "public, max-age=31536000, immutable"
        @icons path /icon-192.png /icon-512.png /icon.svg
        header @icons Cache-Control "public, max-age=86400"
        # The page, service worker and manifest are re-checked on every visit.
        @shell {
            not path /assets/* /icon-192.png /icon-512.png /icon.svg
        }
        header @shell Cache-Control "no-cache"
        try_files {path} /index.html
        file_server
    }
}
```

Effect: the 277 KB app file is about 92 KB over the wire. Check a change with
`sudo -u caddy caddy validate --config <file> --adapter caddyfile` before `sudo systemctl reload caddy`.

## Navidrome

`/var/lib/navidrome/navidrome.toml` sets `MusicFolder = '/srv/music'`, `ScanSchedule = '@every 15m'` and
`ImageCacheSize = "1.5GB"` (the default 100 MB was full and kept throwing covers away).

## The nightly job (`server/automix/sync-music.sh`)

1. `rclone sync "gdrive:My Music" /srv/music --max-delete 5`: Drive deletions are mirrored; a run that would delete more than 5 files stops, so a renamed, empty or unreachable Drive folder cannot wipe the library.
2. Cover cache cleanup: files in `/var/lib/navidrome/cache/images` that nobody has read for 90 days are deleted, and Navidrome is restarted if any were (it keeps an in-memory index of that cache).
3. `analyze.py`: updates `analysis.json` and drops entries of deleted songs.
4. `POST /automix/rescan`: analyses new or replaced songs and prunes the rest.

## When a song is deleted from Drive

| Data | Removed by | When |
|---|---|---|
| The audio file in `/srv/music` | `rclone sync` | the next midnight run |
| Navidrome's entry, playlists, play counts | Navidrome | its next scan, within 15 min |
| AutoMix `tracks` and `transitions` rows (beat grid, key, cues, loudness) | `_prune_and_link` in `main.py` | the rescan right after the sync |
| `analysis.json` entry | `analyze.py` | the same run |
| Cached lyrics | `cleanup.prune_lyrics_cache`: each cache row records its title and duration and is kept only while a song matches | the same rescan |
| Cover images in the Navidrome cache | age cleanup (step 2 above) | 90 days after the last view |

## Deploying

App: `npm run build`, back up `/var/www/brook` to `/opt/automix/backup-pwa-<timestamp>`, copy `dist/.` in, `chown -R www-data:www-data`.
Before deploying, build the branch and compare the bundle name (`assets/index-<hash>.js`) with the one the live site serves: the same source gives the same name, so a different name means the live site holds changes this branch does not.

Server: copy `server/automix/*.py` to `/opt/automix/app`, `server/analyze.py` to `/opt/brook-analysis`, `server/automix/sync-music.sh` to `/home/ubuntu`, then `sudo systemctl restart automix`.
Backups of earlier states are in `/opt/automix/backup-*`.

## Known issues

- About 12% of the beat grids (librosa fallback) sit half a beat off, which makes a beat-matched mix gallop. The fix is the neural tracker beat_this (it needs torch, which lives in `/opt/demucs/venv`) and a full re-analysis.
- Phones stream the original files (`format=raw`; 142 of 170 songs are FLAC at about 39 MB). A "Data saver" stream (Opus 128) would cut that to about 4 MB but needs seek testing.
- A free `duckdns.org` name with a login page can be flagged by Google Safe Browsing ("Dangerous site" on phones). A domain of your own avoids the shared reputation.
