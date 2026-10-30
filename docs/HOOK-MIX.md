# DJ Mode (Hook Mix)

> Goal: in **DJ** mode, play the part of each song people know (the chorus, or the drop) and hand off to the next song's build-up so its hook lands exactly when the previous one ends, the way an open-format club DJ quick-mixes.
> **Crossfade** (the old DJ mode) stays as it is: whole songs, phrase-mixed outro → intro.

This replaces the first draft (`brook_hook_mix_mode_documentation.md`). That draft targeted an imagined codebase. Six of its eight "challenges" (downbeat phase, half/double-time, cue timing, rate glide, next-song lock) were already solved by AutoMix v2, and its parallel transition engine would have thrown those fixes away.

---

## 1. Modes

| Button | Plays | Hand-off |
|---|---|---|
| **Crossfade** | Whole songs | Outgoing outro under incoming intro, 4–32 bars (`planTransition`) |
| **DJ** | Pre-chorus → chorus, ~30–50 s per song | At the end of the outgoing chorus: a one-bar **swap** (outgoing washes out into a dub echo, incoming comes in at its pre-chorus), or an instrumental **build blend** under the outgoing chorus (`planHookTransition`) |

- One state, `mixMode: "off" | "crossfade" | "dj"`. The buttons are exclusive; tapping the lit one turns mixing off.
- **DJ is never worse than Crossfade.** A track without trusted hook cues (`hook_confidence < 0.45`, or no analysis yet) gets the Crossfade treatment on that side of the mix.

## 2. What "the best part" means, and how it is found

The part people know is the **chorus**, the section whose lyrics repeat. In vocal-less electronic music, it's the **drop**. Brook's library is mostly vocal pop / Punjabi / Bollywood, so the chorus is the main target.

Two independent signals, fused:

1. **Audio structure** (always available, on the server):
   - Per-bar features on the existing downbeat grid: chroma (harmony), MFCC (timbre), `bar_energy`, `bar_bass`.
   - Foote checkerboard novelty on the bar self-similarity → section boundaries, snapped to 4-bar lines.
   - Section **repetition**: how strongly each section's chroma sequence recurs elsewhere (path-enhanced recurrence). Choruses repeat with the same harmony *and* melody.
   - Section score = repetition × loudness (relative to the track) × "lift" (energy jump at its start) × position prior (not intro, not outro).
   - **Drop** rule: a bar where `bar_bass` rises from < 0.35 to > 0.8 after ≥ 4 low-bass bars. It competes with the chorus candidates.
2. **Lyrics** (optional, when synced lyrics exist): LRCLIB (`lrclib.net`, free, no key) returns time-stamped lines. The most-repeated multi-line block *is* the chorus, and its first-line timestamps are the chorus starts. When present, the lyric answer chooses which audio section is the chorus and snaps it to the bar grid. This is also the **ground truth** used to measure the audio-only detector. Only the artist + title of each track are sent, and a setting can turn it off.

Which occurrence: the first chorus that is preceded by a build-up (energy lower in the 4–8 bars before it) and is not in the last 15% of the song. Usually that's chorus 1 or 2. The second is preferred when chorus 1 is a short half-chorus (≤ 4 bars) or comes before 20% of the track.

Cues stored per track (all on downbeats):

```
hook_in        = where the song comes in: the lyric block start (pre-chorus), 4–16 bars before the drop; else drop − 8 bars
hook_drop      = first bar of the hook
hook_out       = end of the hook: the end of the lyric chorus block (8–24 bars), else 8 or 16 bars after the drop
hook_post_end  = how far the outgoing may keep playing after hook_out (≤ 8 bars, stops before the next vocals or the outro)
hook_kind      = chorus | drop | energy  (energy = no repeated section, loudest 8 bars after intro)
hook_confidence, hook_energy, hook_key, hook_alts (JSON, 2 runner-ups), hook_version
bar_vocal_full = per-bar singing for the DJ planner (Demucs where measured, REPET estimate elsewhere, lyric line timing on top)
sound_profile, lyric_lang = for song fit (see §4)
```

## 3. The hand-off (`planHookTransition`, `dj.ts`)

The incoming song's entry lands on the bar where the outgoing hook ends. Nothing plays past the outgoing hook (that's where the next verse, more singing, starts).

```
swap:   outgoing  … CHORUS ……… last bar: high-pass up + dub echo |
        incoming               pickup, filtered, rising          |PRE-CHORUS … CHORUS …

blend:  outgoing  … CHORUS ……… last n bars ………|
        incoming      | build, filtered, rising  |CHORUS …
```

- **Blend** (8 / 4 / 2 bars, inside the outgoing hook, which keeps its first half to itself) only where the two decks never sing at the same time before the last bar. A bar with no vocal data counts as singing. In vocal pop the bars before a chorus are almost always sung, so most vocal hand-offs are swaps, as an open-format DJ quick-mixes vocal tracks. The blend: equal-power faders, bass swap in the last bar, incoming mids −6 dB and a high-pass dive 400 → 20 Hz, all released on the drop.
- **Swap** (one bar): outgoing high-pass rising to 1 kHz, a dotted-eighth dub echo fed from beat 3 that rings on after the fader is gone; the incoming pickup bar rises under a high-pass falling from 1.5 kHz and opens on its pre-chorus. Also used for any pair that can't be beat-matched (the incoming then plays at its own tempo).
- **Tempo:** `tempoMatch` (×1, ×2, ×½ within 6%), the phase lock, and the 4-bar rate ease after the mix.
- The plan is made once per song pair when the cue is scheduled (the cue is the hook end minus the plan's length) and kept, so it can't shrink as the cue approaches.

### 3.1 Edge cases (every one has a defined behaviour)

| Situation | Behaviour |
|---|---|
| Incoming has no trusted hook | Plays from its `mix_in_point` with a Crossfade-style plan (and becomes the outgoing with its normal `mix_out_point`) |
| Outgoing has no trusted hook | Mix out at its Crossfade cue |
| DJ switched on mid-song, before `hook_out` | Mix at `hook_out` as normal |
| DJ switched on after `hook_out` | Hand off on the next 4-bar line ≥ 8 s away |
| User taps Next / picks a song in DJ mode | The new song starts at its `hook_in` (DJ keeps the hook flow) |
| Incoming not buffered at the cue | Slide the hand-off 4 bars later (the outgoing plays on past its hook), at most twice |
| Seek while mixing | Same as Crossfade: abort the mix, keep the active deck |
| Pause mid-mix | AudioContext suspends; curves freeze (existing) |

## 4. Picking the next song in DJ mode

`pickNextDJ` gets a `dj` profile:
- **Key at the hook** (`hook_key`, chroma over the hook only; final choruses often modulate). Same Camelot scoring.
- **Tempo:** a straight/half/double match within 6% scores high (a beat-matched blend is possible); otherwise the hand-off is a swap, so mismatches are allowed but rarer.
- **Song fit** (`fitScore`): the server stores a sound profile per track (MFCC mean and spread, spectral contrast, onset density, tempo) and the lyric language (`inst`, `desi`, `en`, `es`, `ru`, `east-asia`). `/automix/tracks` returns the profile z-scored across the library as a unit vector (`style`); the picker adds 60 × similarity + 30 for the same language, so a set doesn't lurch from metalcore to Punjabi pop to a game theme. Nearest neighbours checked by name on the library: Narvent with phonk, Sabrina Carpenter with Charlie Puth and Taylor Swift, Khalid with Post Malone.
- **Energy flow:** prefer `hook_energy` within ±0.15 of the current one, with a slight upward drift.
- Skip tracks without a trusted hook unless nothing else is left.
- Recent window: 40 songs (at ~50 s per song, the old window repeated every ~17 min).

## 5. Seeking mid-file reliably

DJ mode seeks every ~50 s, so seeks must be cheap:
- Check if Navidrome transcodes for this client. If so, request `format=raw` so HTTP range seeks work.
- Preload the next song as soon as the previous mix finishes (not 30 s before the cue). Seek to the incoming start and wait for `seeked` plus `buffered` covering the first 8 bars; the hand-off only fires when ready (otherwise extend, §3.1).

## 5b. Status (Release 2, 2026-10-30)

Shipped in the app:
- Crossfade / DJ buttons; DJ hand-offs (swap / build blend) with filter, echo and bass-swap FX; hook-aware preload, buffered wait and cue extension; DJ picking with hook key, energy flow, song fit and a 40-song window. `npm test` passes.

Server (`server/automix`, **deploy separately**, then the hook pass backfills; until then DJ mode falls back to Crossfade):
- `analysis_hooks.py` (detector, lyric fusion, pre-chorus entry, chorus end, sound profile, language), `lyrics.py` (LRCLIB), `main.py` (hook pass, columns, API), `hooks_eval.py` (accuracy vs lyrics), `render_dj.py` (renders sets to listen to).

Eval (VM library, 170 tracks):
- Lyrics: 123 tracks have a repeated lyric block (chorus from lyrics, entry bar from audio). 37 have none on LRCLIB, almost all instrumentals; 9 have only partial lyrics. Fuzzy line matching: +1 track but moved or split the chorus on 44 others, dropped.
- Audio only: 44% land inside a lyric chorus region (62% at confidence ≥ 0.75). Weight grid (486 sets, two-fold CV): 45%, same as the current weights.
- Old design (incoming build under the outgoing post-hook): 63% of blends had both decks singing for 2+ bars. The current planner allows none.
- Listening test: the old renders were judged poor (song choice, transitions); the current set (song fit, swaps into the pre-chorus) was judged "much better".

Next:
1. **Beat grids:** every grid on the VM is the librosa fallback (beat_this was never installed; it needs torch, which lives in `/opt/demucs/venv`). 20 tracks (12%) sit half a beat off. beat_this, run from the Demucs venv like `vocals_separate.py`, fixes most of the vocal ones (Shaboozey, Candy Paint, Ek Raat, Bed Chem, Dai Dai, Bazzi: 300 ms → ~20 ms) but not the ambient phonk ones, and disagrees with the current downbeats on 72% of tracks and with the tempo octave on 25%. Switching means a full re-analysis (~40 s/track): do it as its own change, checked with renders.
2. Phone test (Phase 5 gate), then Phase 9 (wrong-hook button).
## 6. Roadmap (each phase has a gate it must pass)

| # | Phase | Gate |
|---|---|---|
| 0 ✅ | Modes: `mixMode`, **Crossfade** + **DJ** buttons, DJ = Crossfade fallback | typecheck + build |
| 1 | `analysis_hooks.py`: audio-structure hook detector + synthetic-song unit tests (known chorus positions) | synthetic tests find every chorus within ±1 bar |
| 2 | Evaluation harness: LRCLIB lyric-chorus truth for the library, scorer (`hooks_eval.py`) | prints hit rate; detector ≥ 80% within ±2 bars of a lyric chorus |
| 3 | Lyrics fusion in production (optional, cached, setting to disable) + `hook_*` columns, own `hook_version`, background backfill at `Nice=10` | backfill doesn't affect streaming; API returns the fields |
| 4 | `planHookTransition` + unit tests (vocals, outro, tempo, missing data) | all tests pass; Crossfade tests unchanged |
| 5 | NowPlaying DJ engine: hook cues, early preload + buffered wait, cue extension, Next = start at hook_in, DJ switched on mid-song | 20-song session on a phone: no stalls, drops on the bar (phase error at the drop < 20 ms in the mix log) |
| 6 | FX: mid duck, HPF dive, pre-fader dub echo with a damped feedback, `echo_out` / `cut` | no clicks; the echo tail outlives the fader; pause mid-mix is clean |
| 7 | DJ picking: hook key, energy flow, trusted-hook filter, 40-song window | 1-hour session: no repeats, no key clashes at hand-offs |
| 8 | Offline QA renders: the server renders sample DJ transitions to audio with the same plan + curves, so they can be listened to in one place | 10 sample hand-offs sound right by ear (the final judge) |
| 9 | "Wrong hook" button (cycles `hook_alts`, saves an override), later Layer 3 server-rendered clips | override survives rescans |

### Risks

| Risk | Covered by |
|---|---|
| Wrong section chosen | Lyrics fusion, confidence gate → Crossfade fallback, alternatives + override, a measured hit rate |
| Vocal collisions | `bar_vocal` on both sides decides n and the style; `echo_out` |
| Seek stalls | `format=raw`, buffered wait, cue extension |
| Re-analysis cost on 2 ARM cores | Separate `hook_version`; the hook pass reuses one decode; no Demucs in the hook pass (it uses the existing vocal data and the lyrics) |
| Breaking Crossfade | One engine; DJ only changes cues and plans; Crossfade code paths untouched |
