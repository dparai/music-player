# DJ Mode (Hook Mix)

> Goal: in **DJ** mode, play the part of each song people know (the chorus, or the drop) and hand off to the next song's build-up so its hook lands exactly when the previous one ends, the way an open-format club DJ quick-mixes.
> **Crossfade** (the old DJ mode) stays as it is: whole songs, phrase-mixed outro → intro.

This replaces the first draft (`brook_hook_mix_mode_documentation.md`). That draft targeted an imagined codebase. Six of its eight "challenges" (downbeat phase, half/double-time, cue timing, rate glide, next-song lock) were already solved by AutoMix v2, and its parallel transition engine would have thrown those fixes away.

---

## 1. Modes

| Button | Plays | Hand-off |
|---|---|---|
| **Crossfade** | Whole songs | Outgoing outro under incoming intro, 4–32 bars (`planTransition`) |
| **DJ** | Build-up → hook → a few bars after it, ~35–60 s per song | Incoming **build-up** under the outgoing **post-hook**; the incoming hook lands on the bar the outgoing fades out (`planHookTransition`) |

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
hook_in        = hook_drop − 8 bars   (start of the build the incoming deck plays during the mix)
hook_drop      = first bar of the hook
hook_out       = end of the hook (next section boundary, 8 or 16 bars after the drop)
hook_post_end  = how far the outgoing may keep playing after hook_out (≤ 8 bars, stops before the next vocals or the outro)
hook_kind      = chorus | drop | energy  (energy = no repeated section, loudest 8 bars after intro)
hook_confidence, hook_energy, hook_key, hook_alts (JSON, 2 runner-ups), hook_version
```

## 3. The hand-off (`planHookTransition`, `dj.ts`)

```
outgoing:  … HOOK ……………………… |hook_out| post-hook (n bars, fading) |
incoming:              | build (n bars, rising) |hook_drop| HOOK …
                       ^ mix starts at outgoing hook_out
```

- **n** = largest of 8 / 4 / 2 bars where (a) the outgoing post-hook has audio (≤ `hook_post_end`), and (b) the two decks are not singing at the same time for 2+ bars (`bar_vocal` on both sides). If neither works: `echo_out` (below).
- **Bass swap** in the last bar, so the incoming hook arrives with its bass ("pre-drop bass deprivation").
- **Styles:**
  - `blend`: equal-power faders (the existing curves); the incoming deck's mids ducked −6 dB and a high-pass dive 400 → 20 Hz over the build, both released on the drop.
  - `echo_out`: a ¾-beat dub echo on the outgoing's last bar, outgoing fader down in one beat; the incoming plays from `hook_drop − 1 bar` at full level. Used for tempos too far apart, or when vocals collide.
  - `cut`: the incoming slams in on its drop at the outgoing hook_out. Used when both are high-energy and n < 2.
- **Tempo:** the existing `tempoMatch` (×1, ×2, ×½ within 6%), the phase lock, and the 4-bar rate ease all apply unchanged.

### 3.1 Edge cases (every one has a defined behaviour)

| Situation | Behaviour |
|---|---|
| Incoming has no trusted hook | Plays from its `mix_in_point` with a Crossfade-style plan (and becomes the outgoing with its normal `mix_out_point`) |
| Outgoing has no trusted hook | Mix out at its Crossfade cue |
| DJ switched on mid-song, before `hook_out` | Mix at `hook_out` as normal |
| DJ switched on after `hook_out` | Mix on the next 4-bar line ≥ 8 s away (`echo_out` if no data) |
| User taps Next / picks a song in DJ mode | The new song starts at its `hook_in` (DJ keeps the hook flow) |
| Incoming not buffered at the cue | Extend: replay nothing, just slide the cue 4 bars later (the outgoing post-hook continues), at most twice, then `echo_out` |
| Seek while mixing | Same as Crossfade: abort the mix, keep the active deck |
| Pause mid-mix | AudioContext suspends; curves freeze (existing) |

## 4. Picking the next song in DJ mode

`pickNextDJ` gets a `dj` profile:
- **Key at the hook** (`hook_key`, chroma over the hook only; final choruses often modulate). Same Camelot scoring.
- **Tempo:** a straight/half/double match within 6% scores high (a beat-matched blend is possible); otherwise the `echo_out` path is used, so mismatches are allowed but rarer.
- **Energy flow:** prefer `hook_energy` within ±0.15 of the current one, with a slight upward drift.
- Skip tracks without a trusted hook unless nothing else is left.
- Recent window: 40 songs (at ~50 s per song, the old window repeated every ~17 min).

## 5. Seeking mid-file reliably

DJ mode seeks every ~50 s, so seeks must be cheap:
- Check if Navidrome transcodes for this client. If so, request `format=raw` so HTTP range seeks work.
- Preload the next song as soon as the previous mix finishes (not 30 s before the cue). Seek to the incoming start and wait for `seeked` plus `buffered` covering the first 8 bars; the hand-off only fires when ready (otherwise extend, §3.1).

## 5b. Status (2026-10-30, work saved mid-way)

Done (code in this branch, **not deployed to the VM yet**):
- Phase 0: Crossfade / DJ buttons (`mixMode`).
- Phase 1: `server/automix/analysis_hooks.py` (section-based detector, lyric fusion) + `tests/test_hooks.py` (10/10 synthetic checks pass).
- Phase 2 (in progress): `hooks_eval.py` scores audio-only hooks against LRCLIB lyric choruses; `--grid` does cross-validated weight tuning. First baseline on the VM library looked like **~50% hit rate (±2 bars) audio-only**, so tuning is still needed. With lyrics (production path) the chorus comes from the lyrics directly.
- Phase 3: `lyrics.py` (LRCLIB, backoff for its 503s), `main.py` hook pass (own `hook_version`, lyrics cache table, API fields).
- Phases 4–7 (app): `planHookTransition`, `djCueOut`, `trustedHook`, `buildHookFxCurves` in `dj.ts`; NowPlaying uses hook cues, early preload, buffered wait + 4-bar cue extension, DJ starts hand-picked songs at their build, HPF dive / mid duck / dub echo; DJ-aware picking (hook key, energy flow, trusted hooks, 40-song window). `npm test` (11/11) and the build pass.

Eval results (VM library, 170 analysed tracks):
- Lyrics: 123 tracks have a repeated lyric block (production path: lyric region + audio entry bar). 37 have none on LRCLIB, almost all instrumentals; 9 have only partial lyrics. Fuzzy line matching was tried: +1 track, but it moved or split the chorus on 44 others, so it was dropped.
- Audio only (no lyrics): 50/113 = 44% land inside a lyric chorus region; 62% when confidence ≥ 0.75. The weight grid (486 sets, two-fold CV) gives 45%, the same as the current `WEIGHTS`, so they stay: the limit is the features, not the weights.
- Phase 8: `render_dj.py` renders sample hand-offs (`--pairs N`, tempo-matched like the picker) and a continuous set (`--set N`) with the same plan, curves and FX as the app.

Next:
1. Listen to the renders; fix what sounds wrong.
2. Deploy `server/automix/*.py` to the VM (README steps) and restart the service; the hook pass backfills.
3. Test DJ mode on the phone (Phase 5 gate), then Phase 9 (wrong-hook button). Instrumentals (no lyrics) rely on the audio detector and its drop rule.

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
