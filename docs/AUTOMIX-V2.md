# AutoMix DJ Mode v2

> Goal: transitions that sound like a DJ mixed them: on the beat, on the phrase, no bass mud or bass hole, steady loudness.
> Built in three layers. Each one works on its own, and every layer falls back to the one below it.

```
Layer 3  Server-rendered clip  (big tempo gaps, key shifts, iOS)      ← planned
Layer 2  Beat-synced browser mix (Web Audio, phase-locked)           ← shipped
Layer 1  Plain browser crossfade (no beat data)                       ← shipped
```

## What changed from the first v2 plan, and why

| First plan said | Problem | Now |
|---|---|---|
| Downbeats = every 4th beat | Bar lines off by 1–3 beats, so phrase cues land mid-bar | Real downbeats: `beat_this`, or a librosa phase estimate. Tested on all 4 phases |
| Mix-out = `duration − overlap` | Mixes over the last chorus | 4/8-bar boundary at the biggest energy drop (outro) |
| Mix-in = first beat after 2 s | Starts on beat 2, not the bar line | First downbeat (≤ 30 s) |
| BPM tiers in absolute BPM ("0–6 BPM") | 6 BPM is 4.7% at 128 but 8.6% at 70 | Percent: ≤ 6% in browser, beyond that server |
| `tracks.id` = Navidrome song ID | Real table uses MD5(path); PWA guessed by filename | Extra `navidrome_id` column read from Navidrome's DB |
| "HTMLAudioElement handles the gapless seam" | Element start latency is 20–200 ms and varies (mobile) | Clip played via Web Audio; B aligned under the clip by the same phase-lock loop |
| Bearer token for auth | Token is in the public JS bundle | Subsonic credentials verified with Navidrome (`auth.py`) |

## Layer 1 + 2: browser mix (`NowPlaying.tsx`, `dj.ts`)

Graph per deck:

```
<audio> → source → preGain (−14 LUFS trim) → analyser → lowshelf 200 Hz → fader ┐
                                                                                 ├→ limiter → out
<audio> → source → preGain                 → analyser → lowshelf 200 Hz → fader ┘
```

1. **Preload** the next song on the idle deck 30 s before the cue, seeked to its first downbeat.
2. **Cue** = the server's `mix_out_point` or `duration − fade`, whichever is earlier, snapped to the last downbeat before it.
3. **Start exactly on the downbeat:** the 200 ms poll arms a `setTimeout` for the precise moment.
4. **Fade length is planned per pair** (`planTransition`): the incoming intro length (min 4 bars, 8 if unknown), capped by the outgoing audio left, 32 bars and 45 s; at most 8 bars when both are loud; ended before overlapping vocals; snapped to 1/2/4/8/16/32 bars. The bass swap and fader crossover land where the incoming bass enters. The server provides `intro_end`, `outro_end` and per-bar energy/bass/vocal arrays; vocals come from Demucs source separation (analysis v4), with a REPET heuristic as fallback.
5. **Curves** run on the audio thread (`setValueCurveAtTime`): equal-power faders plus a **one-bar bass swap** in the middle. The shelf offsets the fader, so bass power stays at 0.0 dB the whole time (the old fade dipped to −20 dB).
6. **Phase lock** every 100 ms: compare beat phases. If off by more than 80 ms, jump into phase; if off by more than 5 ms, nudge `playbackRate` by up to ±2%.
7. **Tempo** match up to ±6% with `preservesPitch`, then ease back to 1.0 over 4 bars (no audible snap).
8. **Pause mid-mix** suspends the AudioContext, so the curves freeze and resume where they stopped.

Falls back to an unsynced crossfade when either track lacks a confident grid, tempos are more than 6% apart, or the user seeks.

## Layer 3: server-rendered transitions (planned)

```
Song A starts ─→ POST /automix/transitions {from: navidrome_id A, to: navidrome_id B}
                 server (one ffmpeg filter graph, ~3–8 s on one core):
                   A: [cue_out, cue_out + 8 bars + 2 s]
                   B: [cue_in − 2 s, …] → rubberband tempo (and ±1 semitone if it improves the key match)
                   faders + bass swap identical to dj.ts → loudnorm trims → Opus 160k
                 → /var/brook-clips/{from}_{to}.opus + play_plan
Phone, at cue_out − 2 s: if clip ready → play clip, else Layer 2
```

When to use it: tempo gap 6–20%, a key clash fixable by a ±1 semitone shift, or iOS where two `<audio>` elements are unreliable.

The seam, done properly:
- Decode the clip to an `AudioBuffer`. Start it with `AudioBufferSourceNode.start(when)` at A's exact cue time (sample-accurate).
- Start deck B silent ~2 s before the clip ends and phase-lock it to the clip's timeline with the Layer 2 loop.
- Swap clip → B with a 30 ms gain crossfade. The audio is identical on both sides, so the seam can't be heard.

Ops:
- Render only when both tracks are analysed. The queue has a single worker at `Nice=10`, so streaming always wins.
- Cache key = `(from, to, analysis version)`. LRU at 50 clips: about 500 KB each (≈25 s of Opus at 160 kbps), so about 25 MB total.
- `pickNextDJ` scoring should use server `key` and `bpm` (dropping `analysis.json`). Reward pairs a render can fix, not just pairs already close.

## Rollout

1. ✅ Browser engine (this repo).
2. Deploy `server/automix/` (analysis v2, Navidrome IDs, auth, cron): see `server/automix/README.md`. Re-analyse the library once.
3. Point `pickNextDJ` at server key/BPM; retire `/api/analysis.json`.
4. Layer 3 render endpoint, then the clip playback path in the PWA.
