#!/usr/bin/env python3
"""AutoMix analysis v2 for Brook.

Drop-in replacement for the per-track analysis in /opt/automix/app/main.py.
Adds what the PWA's beat-synced mixer needs and v1 did not provide:

- real downbeats (v1 took every 4th beat from beat 0, so bar lines could be
  1-3 beats off): beat_this if installed, else a librosa phase estimate
- phrase-aligned mix-out cue at an energy drop (outro), instead of duration - 15
- mix-in cue on the first downbeat, instead of the second beat
- musical key (Camelot-compatible names used by src/lib/dj.ts)
- integrated loudness (EBU R128 / BS.1770 via ffmpeg) for -14 LUFS trims

Usage from main.py:
    from analysis_v2 import analyze_track
    row = analyze_track("/srv/music/Insane - AP Dhillon.flac")

Standalone check:
    /opt/automix/venv/bin/python analysis_v2.py "/srv/music/some song.flac"
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import librosa
import numpy as np

SR = 22050
HOP = 512
KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAX_INTRO_CUE = 30.0  # matches NowPlaying.tsx: don't skip more intro than this
MAX_OUTRO = 40.0      # never start the mix-out earlier than this before the end
# Bumped when analysis output changes; main.py re-analyses rows below it.
# 3: per-bar structure profile (energy, bass, vocals) + intro_end / outro_end.
# 4: vocals from Demucs source separation (heuristic only as a fallback).
ANALYSIS_VERSION = 4
# Vocal detection runs in its own venv (CPU torch); see vocals_separate.py and
# vocals_classify.py. Fallback chain, best first:
#   1. Demucs htdemucs      (separation; retried up to 3 times over later scans:
#                            plain, then in 10 s pieces, then pieces + file repair)
#   2. Open-Unmix umxl      (separation, different design; ~45 s per song)
#   3. PANNs CNN14          (singing classifier, no separation; ~30 s per song)
#   4. REPET heuristic      (in-process; can't fail)
VOCAL_PYTHON = os.environ.get("AUTOMIX_DEMUCS_PYTHON", "/opt/demucs/venv/bin/python")
SEPARATE_SCRIPT = Path(__file__).resolve().parent / "vocals_separate.py"
CLASSIFY_SCRIPT = Path(__file__).resolve().parent / "vocals_classify.py"
VOCAL_TIMEOUT = 1800       # s per attempt; doubled for the piecewise retry
MAX_DEMUCS_ATTEMPTS = 3    # main.py stops retrying Demucs for a file after this
CHUNK_SECONDS = 10
# bar_vocal is a 0..1 "singing" score, 0.5 = singing, whichever detector ran.
# Raw level that maps to 0.5, from calibration on real songs (2026-10-25):
#   Demucs vocal-stem share    instrumental 0.000-0.01, sung 0.15-0.41
#   Open-Unmix vocal-stem share instrumental 0.000-0.03, sung 0.14-0.44
#   PANNs singing probability  instrumental 0.000-0.005, sung 0.02-0.09
#   REPET foreground ratio     instrumental 0.00-0.10, sung 0.15-0.40 (overlaps)
SINGING_LEVEL = {"demucs": 0.05, "umxl": 0.07, "panns": 0.012, "repet": 0.18}
HEAD_SECONDS = 47.0   # incoming side: the planner reads up to 45 s after mix_in
VOCAL_HOP = 2048      # ~93 ms frames for the vocal estimate (keeps nn_filter small)


def decode(path: str, sr: int = SR) -> np.ndarray:
    """Decode any format ffmpeg knows (incl. m4a/AAC) to mono float32."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True, check=True, timeout=300,
    ).stdout
    return np.frombuffer(out, dtype=np.float32).copy()


def integrated_lufs(path: str) -> float | None:
    """Integrated loudness of the original file (all channels), in LUFS."""
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", path,
         "-filter_complex", "ebur128=framelog=quiet", "-f", "null", "-"],
        capture_output=True, text=True, timeout=300,
    )
    found = re.findall(r"I:\s+(-?\d+(?:\.\d+)?) LUFS", r.stderr)
    return float(found[-1]) if found else None


def fade_duration_for(bpm: float | None) -> float:
    """Same rule as fadeDurationFor() in src/lib/dj.ts: 8 bars, kept in 8-24 s."""
    if not bpm or bpm <= 0:
        return 15.0
    seconds = 8 * 4 * 60 / bpm
    while seconds > 24:
        seconds /= 2
    while seconds < 8:
        seconds *= 2
    return seconds


def _beats_beat_this(y: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Neural beat + downbeat tracker (pip install beat_this; runs on ARM CPU)."""
    try:
        from beat_this.inference import Audio2Beats
    except ImportError:
        return None
    model = getattr(_beats_beat_this, "_model", None)
    if model is None:
        model = Audio2Beats(checkpoint_path="final0", device="cpu", dbn=False)
        _beats_beat_this._model = model  # type: ignore[attr-defined]
    try:
        beats, downbeats = model(y, SR)
    except Exception as e:  # bad audio, OOM: fall back to librosa
        print(f"beat_this failed: {e}", file=sys.stderr)
        return None
    beats, downbeats = np.asarray(beats, float), np.asarray(downbeats, float)
    if len(beats) < 8 or len(downbeats) < 2:
        return None
    return beats, downbeats


def _beats_librosa(y: np.ndarray, S: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """librosa beats, with the bar phase chosen from kick energy and chord changes.

    Beat 1 of a bar usually carries the strongest kick, and harmony tends to
    change on bar lines, so score each of the 4 possible phases on both.
    """
    onset_env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, aggregate=np.median)
    _, frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=SR, hop_length=HOP)
    frames = np.asarray(frames, int)
    beats = librosa.frames_to_time(frames, sr=SR, hop_length=HOP)
    if len(beats) < 8:
        return beats, beats[::4]

    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    # Loud off-beat hi-hats can pull the tracker half a beat off the kick.
    # The kick (lowest band) belongs on the beat: if there's clearly more of it
    # halfway between the tracked beats, shift the whole grid by half a beat.
    low_all = S[freqs < 150].sum(axis=0)
    half = int(round(np.median(np.diff(frames)) / 2))
    on = low_all[np.clip(frames, 0, S.shape[1] - 1)]
    off = low_all[np.clip(frames + half, 0, S.shape[1] - 1)]
    if half > 0 and off.mean() > 1.3 * on.mean():
        frames = frames + half
        beats = librosa.frames_to_time(frames, sr=SR, hop_length=HOP)

    frames = np.clip(frames, 0, S.shape[1] - 1)
    # Summarise each beat over its whole span [beat, next beat): a tracked beat
    # frame can sit just before the kick, so sampling that single frame misses it.
    # sync(pad=True) yields [0, f0), [f0, f1), ...; drop the pre-first-beat segment.
    low = S[freqs < 150].sum(axis=0, keepdims=True)
    low_at_beat = librosa.util.sync(low, frames, aggregate=np.max)[0, 1:]
    chroma = librosa.util.sync(librosa.feature.chroma_stft(S=S ** 2, sr=SR), frames, aggregate=np.median)[:, 1:]
    change = np.r_[0.0, np.linalg.norm(np.diff(chroma, axis=1), axis=0)]

    def norm(v: np.ndarray) -> np.ndarray:
        m = v.mean()
        return v / m if m > 0 else v

    low_at_beat, change = norm(low_at_beat), norm(change)
    scores = [low_at_beat[k::4].mean() + change[k::4].mean() for k in range(4)]
    phase = int(np.argmax(scores))
    return beats, beats[phase::4]


def _confidence(beats: np.ndarray) -> float:
    """0..1 from inter-beat interval regularity."""
    if len(beats) < 8:
        return 0.0
    ibi = np.diff(beats)
    cv = float(np.std(ibi) / np.mean(ibi))
    return round(max(0.0, 1.0 - 4.0 * cv), 3)


def _extend_grid(beats: np.ndarray, downbeats: np.ndarray, duration: float, period: float) -> tuple[np.ndarray, np.ndarray]:
    """Continue the grid to the end of the track at the fitted tempo.

    Beat trackers drop beats where the music thins out, which is exactly the
    outro we want to cue on. DJ software assumes a constant grid; so do we.
    """
    if period <= 0 or len(beats) == 0 or len(downbeats) == 0:
        return beats, downbeats
    extra_beats = np.arange(beats[-1] + period, duration - 0.05, period)
    extra_downs = np.arange(downbeats[-1] + 4 * period, duration - 0.05, 4 * period)
    return np.r_[beats, extra_beats], np.r_[downbeats, extra_downs]


def detect_key(y_harm: np.ndarray) -> str:
    """Krumhansl-Schmuckler on the harmonic part of the whole track."""
    chroma = librosa.feature.chroma_cqt(y=y_harm, sr=SR, hop_length=HOP).mean(axis=1)
    major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    best = (-2.0, "C")
    for i in range(12):
        rolled = np.roll(chroma, -i)
        best = max(best,
                   (float(np.corrcoef(rolled, major)[0, 1]), KEY_NAMES[i]),
                   (float(np.corrcoef(rolled, minor)[0, 1]), KEY_NAMES[i] + "m"))
    return best[1]


def phrase_cues(y: np.ndarray, downbeats: np.ndarray, duration: float, bpm: float,
                origin: float | None = None) -> tuple[float, float]:
    """(mix_in, mix_out) on downbeats.

    mix_out: a bar in the last minute where energy drops (the outro),
    preferring later ones, leaving room for a full fade. Bars on a 4- or
    8-bar phrase line get a bonus; phrases are counted from `origin` (where
    the main section starts, i.e. intro_end), not from the first tracked
    downbeat, which is often a bar late. Falls back to the last bar that still
    fits the fade.
    """
    fade = fade_duration_for(bpm)
    mix_in = float(downbeats[0]) if len(downbeats) and downbeats[0] <= MAX_INTRO_CUE else 0.0
    simple_out = max(duration / 2, duration - fade)
    if len(downbeats) < 16:
        return mix_in, simple_out

    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    times = librosa.frames_to_time(np.arange(len(rms)), sr=SR, hop_length=HOP)
    edges = np.r_[downbeats, duration]
    bar_energy = np.array([
        rms[(times >= a) & (times < b)].mean() if np.any((times >= a) & (times < b)) else 0.0
        for a, b in zip(edges[:-1], edges[1:])
    ])
    mean_energy = bar_energy.mean() or 1.0

    bar = 240.0 / bpm if bpm > 0 else 2.0
    origin = float(downbeats[0]) if origin is None else origin
    best_i, best_score = None, 0.0
    last_fit = None
    for i in range(4, len(downbeats) - 1):
        t = float(downbeats[i])
        phrase = int(round((t - origin) / bar))
        # Mix out within the last 40 s: an earlier drop is a bridge, not an outro.
        if t < max(duration / 2, duration - MAX_OUTRO) or t + fade > duration - 0.5:
            continue
        last_fit = t
        before = bar_energy[max(0, i - 4):i].mean()
        after = bar_energy[i:i + 4].mean()
        drop = (before - after) / mean_energy
        # The outro is the *last* clear drop: the biggest one is often the
        # bridge (Espresso: 112 s of 175 s), which would cut a third of the song.
        # Later candidates win unless an earlier one is a much bigger drop.
        score = drop + (0.1 if phrase % 8 == 0 else 0.05 if phrase % 4 == 0 else 0.0) + 1.5 * (t / duration)
        if drop > 0.15 and score > best_score:
            best_i, best_score = t, score
    if best_i is not None:
        return mix_in, best_i
    return mix_in, last_fit if last_fit is not None else simple_out


def _per_bar(values: np.ndarray, times: np.ndarray, edges: np.ndarray, agg=np.mean) -> np.ndarray:
    """Aggregate a frame-rate feature over each bar [edges[i], edges[i+1])."""
    idx = np.searchsorted(times, edges)
    out = np.zeros(len(edges) - 1)
    for i in range(len(out)):
        a, b = idx[i], max(idx[i + 1], idx[i] + 1)
        seg = values[a:b]
        out[i] = agg(seg) if len(seg) else 0.0
    return out


def _vocal_ratio(y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-frame share of vocal-band energy that is "foreground" (frame times, ratio).

    REPET-SIM (librosa's vocal-separation recipe): the repeating background
    (beat, pads, riffs) is what similar frames have in common; what doesn't
    repeat, in the 250-3500 Hz band, is mostly the voice. Low resolution
    (93 ms) keeps the similarity matrix small on 2 OCPUs.
    """
    hop = VOCAL_HOP if len(y) / SR < 600 else 2 * VOCAL_HOP
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    width = max(3, int(librosa.time_to_frames(2.0, sr=SR, hop_length=hop)))
    bg = librosa.decompose.nn_filter(S, aggregate=np.median, metric="cosine", width=width)
    bg = np.minimum(S, bg)
    fg = librosa.util.softmask(S - bg, 2.0 * bg, power=2) * S
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    band = (freqs >= 250) & (freqs <= 3500)
    total = (S[band] ** 2).sum(axis=0) + 1e-10
    ratio = (fg[band] ** 2).sum(axis=0) / total
    times = librosa.frames_to_time(np.arange(S.shape[1]), sr=SR, hop_length=hop)
    return times, ratio


def structure_profile(y: np.ndarray, S: np.ndarray, downbeats: np.ndarray, duration: float, mix_in: float) -> dict:
    """Per-bar energy / bass / vocals and where the intro ends and audio ends.

    All per-bar arrays line up with `downbeats` (bar i = [downbeats[i], next)).
    Energy and bass are relative to the track's median bar, so 1.0 = "typical".
    - intro_end: first bar from mix_in where the track is really going (energy
      and bass both >= 60% of typical for two bars): where the incoming bass
      lands, so the bass swap belongs there.
    - outro_end: end of the last bar that is still audible (within 40 dB of
      the typical bar, and above -60 dBFS), so a mix never fades into trailing
      silence. A quiet hats-only outro still counts as audible.
    """
    if len(downbeats) < 2:
        return {}
    edges = np.r_[downbeats, duration]
    rms = librosa.feature.rms(S=S, frame_length=2048, hop_length=HOP)[0]
    t = librosa.frames_to_time(np.arange(len(rms)), sr=SR, hop_length=HOP)
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    low = S[freqs < 150].sum(axis=0)

    def rel(v: np.ndarray) -> np.ndarray:
        audible = v[v > 0]
        med = float(np.median(audible)) if len(audible) else 0.0
        return v / med if med > 0 else v

    energy = rel(_per_bar(rms, t, edges))
    bass = rel(_per_bar(low, t, edges))

    start = int(np.searchsorted(downbeats, mix_in - 0.05))
    intro_end = float(downbeats[start])
    for i in range(start, min(len(energy) - 1, start + 64)):
        if min(energy[i], energy[i + 1]) >= 0.6 and min(bass[i], bass[i + 1]) >= 0.6:
            intro_end = float(downbeats[i])
            break

    bar_rms = _per_bar(rms, t, edges)
    with np.errstate(divide="ignore"):
        bar_db = 20 * np.log10(np.maximum(bar_rms, 1e-12))
    loud = bar_db[bar_db > -100]
    floor = max(-60.0, float(np.median(loud)) - 40.0) if len(loud) else -60.0
    audible = np.nonzero(bar_db >= floor)[0]
    outro_end = float(edges[audible[-1] + 1]) if len(audible) else duration

    r2 = lambda a: [round(float(x), 2) for x in a]  # noqa: E731
    return {
        "intro_end": round(intro_end, 3),
        "outro_end": round(min(outro_end, duration), 3),
        "bar_energy": json.dumps(r2(energy)),
        "bar_bass": json.dumps(r2(bass)),
    }


def demucs_available() -> bool:
    return os.path.exists(VOCAL_PYTHON) and SEPARATE_SCRIPT.exists()


def _failure_reason(returncode: int | None, stderr: str, timed_out: bool) -> str:
    """Short reason for a failed vocal-detection run; decides the next retry strategy."""
    if timed_out:
        return "timeout"
    if returncode in (-15, -2):
        return "interrupted"  # service stopped/restarted mid-song: not the song's fault
    err = stderr.lower()
    if returncode == -9 or "memoryerror" in err or "out of memory" in err or "cannot allocate" in err:
        return "memory"
    if "ffmpeg" in err or "decode" in err or "invalid data" in err or "calledprocesserror" in err:
        return "decode"
    last = stderr.strip().splitlines()[-1][:120] if stderr.strip() else f"exit {returncode}"
    return f"error: {last}"


def _run_json(cmd: list[str], timeout: float) -> tuple[dict | None, str | None]:
    """Run a vocal-detection script; (parsed JSON, None) or (None, failure reason)."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError as e:
        return None, f"error: {e}"
    if r.returncode == 0 and r.stdout.strip():
        try:
            return json.loads(r.stdout.strip().splitlines()[-1]), None
        except json.JSONDecodeError:
            return None, "error: bad output"
    return None, _failure_reason(r.returncode, r.stderr, False)


def _separate(model: str, path: str, head_end: float, tail_start: float,
              chunk: bool, repair: bool) -> tuple[tuple[np.ndarray, np.ndarray] | None, str | None]:
    """(frame times, vocal share) via vocals_separate.py, NaN outside the windows."""
    cmd = [VOCAL_PYTHON, "-I", str(SEPARATE_SCRIPT), path, "--model", model,
           "--head-end", f"{head_end:.2f}", "--tail-start", f"{tail_start:.2f}"]
    if chunk:
        cmd += ["--chunk", str(CHUNK_SECONDS)]
    if repair:
        cmd.append("--repair")
    d, reason = _run_json(cmd, VOCAL_TIMEOUT * (2 if chunk else 1))
    if d is None or not d.get("vocal"):
        return None, reason or "error: empty output"
    vocal = np.array([np.nan if v is None else v for v in d["vocal"]], dtype=float)
    total = np.array(d["total"][: len(vocal)], dtype=float)
    share = vocal ** 2 / (total ** 2 + 1e-10)
    return (np.arange(len(share)) * float(d["hop"]), share), None


def _classify(path: str, repair: bool) -> tuple[tuple[np.ndarray, np.ndarray] | None, str | None]:
    """(frame times, singing probability) via vocals_classify.py (PANNs)."""
    if not CLASSIFY_SCRIPT.exists():
        return None, "error: classifier not installed"
    cmd = [VOCAL_PYTHON, "-I", str(CLASSIFY_SCRIPT), path] + (["--repair"] if repair else [])
    d, reason = _run_json(cmd, VOCAL_TIMEOUT)
    if d is None or not d.get("singing"):
        return None, reason or "error: empty output"
    p = np.array(d["singing"], dtype=float)
    return (np.arange(len(p)) * float(d["hop"]), p), None


def detect_vocals(path: str, y: np.ndarray, duration: float, mix_in: float, mix_out: float,
                  demucs_attempts: int = 0, last_error: str | None = None) -> dict:
    """Run the fallback chain. Returns times, score (0..1, 0.5 = singing), source,
    and demucs_error (None if Demucs succeeded or wasn't tried).

    `demucs_attempts` / `last_error` (from earlier scans) pick the Demucs
    strategy: 1st try plain; after a timeout or out-of-memory, in 10 s pieces;
    after a read error, with file repair; 3rd try both. After
    MAX_DEMUCS_ATTEMPTS failures Demucs is skipped and the backups are used.
    """
    head_end, tail_start = min(duration, mix_in + HEAD_SECONDS), max(0.0, mix_out - 2.0)
    decode_trouble = bool(last_error and last_error.startswith("decode"))
    demucs_error: str | None = None
    if demucs_available() and demucs_attempts < MAX_DEMUCS_ATTEMPTS:
        chunk = demucs_attempts >= 1 and not (demucs_attempts == 1 and decode_trouble)
        repair = decode_trouble or demucs_attempts >= 2
        res, demucs_error = _separate("htdemucs", path, head_end, tail_start, chunk, repair)
        if res is not None:
            times, share = res
            return {"times": times, "score": share / (2 * SINGING_LEVEL["demucs"]), "source": "demucs",
                    "demucs_error": None}
        print(f"demucs failed ({demucs_error}): {path}", file=sys.stderr, flush=True)
        if demucs_error == "interrupted":
            raise RuntimeError("vocal detection interrupted")  # don't save a fallback row
        decode_trouble = decode_trouble or demucs_error.startswith("decode")
    elif demucs_attempts >= MAX_DEMUCS_ATTEMPTS:
        demucs_error = last_error

    if demucs_available():
        res, err = _separate("umxl", path, head_end, tail_start, chunk=False, repair=decode_trouble)
        if res is not None:
            times, share = res
            return {"times": times, "score": share / (2 * SINGING_LEVEL["umxl"]), "source": "umxl",
                    "demucs_error": demucs_error}
        print(f"open-unmix failed ({err}): {path}", file=sys.stderr, flush=True)
        decode_trouble = decode_trouble or (err or "").startswith("decode")
        res, err = _classify(path, repair=decode_trouble)
        if res is not None:
            times, p = res
            return {"times": times, "score": p / (2 * SINGING_LEVEL["panns"]), "source": "panns",
                    "demucs_error": demucs_error}
        print(f"panns failed ({err}): {path}", file=sys.stderr, flush=True)

    times, ratio = _vocal_ratio(y)
    return {"times": times, "score": ratio / (2 * SINGING_LEVEL["repet"]), "source": "repet",
            "demucs_error": demucs_error}


def bar_vocals(times: np.ndarray, score: np.ndarray, downbeats: np.ndarray, duration: float) -> str | None:
    """Per-bar singing score JSON (0..1, 0.5 = singing; null where not measured)."""
    if len(downbeats) < 2:
        return None
    edges = np.r_[downbeats, duration]
    idx = np.searchsorted(times, edges)
    out: list[float | None] = []
    for i in range(len(edges) - 1):
        seg = score[idx[i]:max(idx[i + 1], idx[i] + 1)]
        seg = seg[~np.isnan(seg)]
        out.append(round(float(min(1.0, np.median(seg))), 2) if len(seg) else None)
    return json.dumps(out)


def analyze_track(path: str, demucs_attempts: int = 0, last_error: str | None = None) -> dict:
    """Everything the tracks table needs for one file."""
    y = decode(path)
    duration = len(y) / SR
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))

    grid = _beats_beat_this(y)
    source = "beat_this"
    if grid is None:
        grid = _beats_librosa(y, S)
        source = "librosa"
    beats, downbeats = grid
    # Slope of a line through the beats: immune to the ~23 ms frame quantisation
    # that skews a median of intervals (124 BPM read as 123.05).
    bpm = float(60.0 / np.polyfit(np.arange(len(beats)), beats, 1)[0]) if len(beats) > 8 else 0.0
    if bpm > 0:
        beats, downbeats = _extend_grid(beats, downbeats, duration, 60.0 / bpm)

    y_harm = librosa.effects.harmonic(y)
    first = float(downbeats[0]) if len(downbeats) else 0.0
    profile = structure_profile(y, S, downbeats, duration, first if first <= MAX_INTRO_CUE else 0.0)
    mix_in, mix_out = phrase_cues(y, downbeats, duration, bpm, origin=profile.get("intro_end"))
    # Never cue the mix-out at (or past) the end of audible audio: keep at
    # least 4 bars between them when the song allows it.
    if profile.get("outro_end") and bpm > 0:
        latest = profile["outro_end"] - 4 * 240.0 / bpm
        if mix_out > latest:
            earlier = downbeats[downbeats <= latest]
            if len(earlier) and earlier[-1] >= duration / 2:
                mix_out = float(earlier[-1])

    vocals = detect_vocals(path, y, duration, mix_in, mix_out, demucs_attempts, last_error)
    vocal_json = bar_vocals(vocals["times"], vocals["score"], downbeats, duration)

    return {
        "intro_end": profile.get("intro_end"),
        "outro_end": profile.get("outro_end"),
        "bar_energy": profile.get("bar_energy"),
        "bar_bass": profile.get("bar_bass"),
        "bar_vocal": vocal_json,
        "vocal_source": vocals["source"] if vocal_json else "none",
        "demucs_error": vocals["demucs_error"],
        "analysis_version": ANALYSIS_VERSION,
        "bpm": round(bpm, 2),
        "beats": json.dumps([round(float(b), 4) for b in beats]),
        "downbeats": json.dumps([round(float(d), 4) for d in downbeats]),
        "confidence": _confidence(beats),
        "mix_in_point": round(mix_in, 3),
        "mix_out_point": round(mix_out, 3),
        "duration": round(duration, 3),
        "key": detect_key(y_harm),
        "lufs": integrated_lufs(path),
        "grid_source": source,
    }


if __name__ == "__main__":
    for p in sys.argv[1:]:
        r = analyze_track(p)
        r["beats"] = f"<{len(json.loads(r['beats']))} beats>"
        r["downbeats"] = f"<{len(json.loads(r['downbeats']))} downbeats>"
        for k in ("bar_energy", "bar_bass", "bar_vocal"):
            if r.get(k):
                r[k] = " ".join("-" if x is None else f"{x:.1f}" for x in json.loads(r[k]))
        print(p, json.dumps(r, indent=2))
