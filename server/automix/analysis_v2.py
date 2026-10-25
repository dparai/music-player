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
import re
import subprocess
import sys

import librosa
import numpy as np

SR = 22050
HOP = 512
KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAX_INTRO_CUE = 30.0  # matches NowPlaying.tsx: don't skip more intro than this
MAX_OUTRO = 60.0      # never start the mix-out earlier than this before the end


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

    frames = np.clip(frames, 0, S.shape[1] - 1)
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
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


def phrase_cues(y: np.ndarray, downbeats: np.ndarray, duration: float, bpm: float) -> tuple[float, float]:
    """(mix_in, mix_out) on downbeats.

    mix_out: a 4-bar boundary in the last minute where energy drops (the
    outro), preferring later ones, leaving room for a full fade.
    Boundaries on 8-bar phrases get a bonus. Falls back to the last boundary
    that still fits the fade.
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

    best_i, best_score = None, 0.0
    last_fit = None
    for i in range(4, len(downbeats) - 1, 4):
        t = float(downbeats[i])
        # Mix out within the last minute: an earlier drop is a bridge, not an outro.
        if t < max(duration / 2, duration - MAX_OUTRO) or t + fade > duration - 0.5:
            continue
        last_fit = t
        before = bar_energy[max(0, i - 4):i].mean()
        after = bar_energy[i:i + 4].mean()
        drop = (before - after) / mean_energy
        # The outro is the *last* clear drop: the biggest one is often the
        # bridge (Espresso: 112 s of 175 s), which would cut a third of the song.
        # Later candidates win unless an earlier one is a much bigger drop.
        score = drop + (0.05 if i % 8 == 0 else 0.0) + 0.5 * (t / duration)
        if drop > 0.15 and score > best_score:
            best_i, best_score = t, score
    if best_i is not None:
        return mix_in, best_i
    return mix_in, last_fit if last_fit is not None else simple_out


def analyze_track(path: str) -> dict:
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
    mix_in, mix_out = phrase_cues(y, downbeats, duration, bpm)

    return {
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
        print(p, json.dumps(r, indent=2))
