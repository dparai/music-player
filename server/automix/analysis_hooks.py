#!/usr/bin/env python3
"""Hook detection for Brook's DJ mode: where the part people know is.

The "hook" is the chorus (the section whose lyrics and melody come back) or,
in vocal-less dance tracks, the drop. DJ mode plays each song from a short
build-up into its hook and hands off when the hook ends (docs/HOOK-MIX.md).

Runs after analysis_v2 and reuses its downbeats and per-bar profile, so it
needs one decode and one STFT per track, no source separation.

    from analysis_hooks import analyze_hooks
    cues = analyze_hooks(path, row, lyrics)   # row: the tracks row (dict)

Standalone check (prints the cues next to the lyric choruses, if any):
    /opt/automix/venv/bin/python analysis_hooks.py "/srv/music/some song.flac"
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata

import librosa
import numpy as np

from analysis_v2 import HOP, KEY_NAMES, SINGING_LEVEL, SR, _vocal_ratio

# Bumped when the cues change; main.py re-runs the hook pass on rows below it
# (without re-running the full analysis).
HOOK_VERSION = 1

BUILD_BARS = 8        # hook_in = hook_drop - this: the build the incoming deck plays under the mix
MAX_POST_BARS = 8     # outgoing may keep playing this long after hook_out while the next build rises
MIN_LAG_BARS = 8      # repeats closer than this are loops inside one section, not a section coming back
EARLY = 0.10          # hooks don't start in the first 10% (intro) ...
LATE = 0.85           # ... or the last 15% (outro, final chorus fade)

# Section score weights, tuned against lyric choruses on the library (hooks_eval.py).
WEIGHTS = {
    "rep": 0.30,      # how strongly the section's 8 bars come back elsewhere
    "count": 0.10,    # how many times it comes back
    "energy": 0.30,   # loudness relative to the track's loudest 8 bars
    "nov": 0.15,      # how sharp the boundary at its start is
    "lift": 0.15,     # energy jump at its start (a build into it)
    "vocal": 0.25,    # share of the score that depends on singing (sung tracks)
}


# --- small helpers -------------------------------------------------------

def _seg_mean(M: np.ndarray, times: np.ndarray, edges: np.ndarray) -> np.ndarray:
    """Mean of each row of M (rows x frames) over [edges[i], edges[i+1])."""
    idx = np.clip(np.searchsorted(times, edges), 0, M.shape[1])
    csum = np.concatenate([np.zeros((M.shape[0], 1)), np.cumsum(M, axis=1)], axis=1)
    a, b = idx[:-1], np.maximum(idx[1:], idx[:-1] + 1)
    b = np.minimum(b, M.shape[1])
    a = np.minimum(a, b - 1)
    return (csum[:, b] - csum[:, a]) / np.maximum(b - a, 1)


def _unit(X: np.ndarray) -> np.ndarray:
    return X / (np.linalg.norm(X, axis=0, keepdims=True) + 1e-9)


def _norm01(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, float)
    lo, hi = np.nanmin(v), np.nanmax(v)
    return (v - lo) / (hi - lo) if hi - lo > 1e-9 else np.zeros_like(v)


def _ks_key(chroma_mean: np.ndarray) -> str:
    """Krumhansl-Schmuckler on a 12-bin chroma (same profiles as analysis_v2)."""
    major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    best = (-2.0, "C")
    for i in range(12):
        rolled = np.roll(chroma_mean, -i)
        best = max(best,
                   (float(np.corrcoef(rolled, major)[0, 1]), KEY_NAMES[i]),
                   (float(np.corrcoef(rolled, minor)[0, 1]), KEY_NAMES[i] + "m"))
    return best[1]


# --- lyrics ----------------------------------------------------------------

_LRC_LINE = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)")


def parse_lrc(text: str | None) -> list[tuple[float, str]]:
    """[(seconds, line)] from LRC synced lyrics; empty lines dropped."""
    out = []
    for raw in (text or "").splitlines():
        m = _LRC_LINE.match(raw.strip())
        if m and m.group(3).strip():
            out.append((int(m.group(1)) * 60 + float(m.group(2)), m.group(3).strip()))
    return sorted(out)


def _norm_line(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).lower()
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)          # ad-libs: "(yeah)", "[x2]"
    return re.sub(r"[^\w]+", " ", s).strip()


def lyric_choruses(lines: list[tuple[float, str]]) -> list[float]:
    """Start times of each occurrence of the most-repeated block of lines.

    A chorus is a run of consecutive lines that comes back. Score each repeated
    run by (lines in it) x (times it occurs); the best run's occurrences are the
    chorus starts. A single line that repeats on its own ("na na na") only
    counts when nothing longer repeats.
    """
    if len(lines) < 6:
        return []
    keys = [_norm_line(t) for _, t in lines]
    n = len(keys)
    best: tuple[float, list[int]] = (0.0, [])
    for i in range(n):
        if not keys[i]:
            continue
        for j in range(i + 1, n):
            if keys[j] != keys[i]:
                continue
            # Length of the common run starting at i and j (not overlapping).
            k = 0
            while j + k < n and i + k < j and keys[i + k] == keys[j + k] and keys[i + k]:
                k += 1
            if k < 2:
                continue
            block = keys[i:i + k]
            starts = [s for s in range(n - k + 1) if keys[s:s + k] == block]
            # Drop overlapping occurrences (a run of identical lines).
            occ: list[int] = []
            for s in starts:
                if not occ or s >= occ[-1] + k:
                    occ.append(s)
            if len(occ) < 2:
                continue
            score = min(k, 8) * len(occ)
            if score > best[0]:
                best = (score, occ)
    if not best[1]:
        return []
    return [lines[s][0] for s in best[1]]


def lyric_vocal_bars(lines: list[tuple[float, str]], edges: np.ndarray) -> np.ndarray:
    """0/1 per bar: a lyric line is being sung in it (a line lasts until the
    next one starts, at most 8 s)."""
    sung = np.zeros(len(edges) - 1)
    for k, (t, _) in enumerate(lines):
        end = min(lines[k + 1][0] if k + 1 < len(lines) else t + 4.0, t + 8.0)
        a = np.searchsorted(edges, t, side="right") - 1
        b = np.searchsorted(edges, end, side="left")
        sung[max(a, 0):max(b, a + 1)] = 1.0
    return sung


# --- the detector ------------------------------------------------------------

def _novelty(S: np.ndarray, half: int = 4) -> np.ndarray:
    """Foote checkerboard novelty along the diagonal of a bar SSM (0..1)."""
    n = S.shape[0]
    g = np.exp(-0.5 * (np.arange(-half, half) + 0.5) ** 2 / (half / 2.0) ** 2)
    K = np.outer(g, g)
    K[:half, half:] *= -1
    K[half:, :half] *= -1
    P = np.pad(S, half, mode="edge")
    nov = np.array([np.sum(P[i:i + 2 * half, i:i + 2 * half] * K) for i in range(n)])
    return _norm01(np.maximum(nov, 0))


def _stripes(S: np.ndarray, L: int) -> np.ndarray:
    """R[i, j] = mean similarity of bars i..i+L-1 with j..j+L-1 (NaN if out of range)."""
    n = S.shape[0]
    R = np.full((n, n), np.nan)
    kernel = np.ones(L) / L
    for d in range(-(n - L), n - L + 1):
        diag = np.diagonal(S, d)
        if len(diag) < L:
            continue
        run = np.convolve(diag, kernel, mode="valid")
        i = np.arange(len(run)) + max(0, -d)
        R[i, i + d] = run
    return R


def _structure(S: np.ndarray, times: np.ndarray, edges: np.ndarray, energy: np.ndarray, nb: int):
    """Bar-level similarity, boundaries and repetition (the expensive part)."""
    # Harmony+melody per quarter bar (so the sequence inside a bar counts),
    # timbre per bar.
    chroma = librosa.feature.chroma_stft(S=S ** 2, sr=SR)
    quarter = np.concatenate([[a + q * (b - a) / 4 for q in range(4)] for a, b in zip(edges[:-1], edges[1:])]
                             + [[edges[-1]]])
    cq = _unit(_seg_mean(chroma, times, quarter))                      # 12 x 4nb
    Xc = _unit(cq.T.reshape(nb, 48).T)                                  # 48 x nb
    mel = librosa.feature.melspectrogram(S=S ** 2, sr=SR)
    mfcc = librosa.feature.mfcc(S=librosa.power_to_db(mel), n_mfcc=14)[1:]
    Xt = _seg_mean(mfcc, times, edges)
    Xt = _unit((Xt - Xt.mean(axis=1, keepdims=True)) / (Xt.std(axis=1, keepdims=True) + 1e-9))
    Sc = Xc.T @ Xc
    St = (Xt.T @ Xt + 1) / 2
    Ssim = 0.7 * Sc + 0.3 * St

    # Section boundaries: novelty on harmony, timbre and loudness together.
    Ee = np.log1p(energy)[None, :]
    Se = 1 - np.abs(Ee.T - Ee) / (np.ptp(Ee) + 1e-9)
    nov = _novelty((Sc + St + Se) / 3, half=4)

    # Repetition: an 8-bar block that comes back >= MIN_LAG_BARS away.
    L = 8
    R = _stripes(Ssim, L)
    lag = np.abs(np.arange(nb)[:, None] - np.arange(nb)[None, :])
    R[lag < MIN_LAG_BARS] = np.nan
    valid = np.isfinite(R)
    tau = float(np.nanpercentile(R[valid], 90)) if valid.any() else 1.0
    rep_best = np.nan_to_num(np.nanmax(np.where(valid, R, -np.inf), axis=1), neginf=0.0)
    rep_count = np.zeros(nb)
    for i in range(nb):
        js = np.nonzero(np.nan_to_num(R[i], nan=-1) >= tau)[0]
        if len(js):
            rep_count[i] = 1 + np.sum(np.diff(js) > 4)  # distinct occurrences

    return chroma, mel, Ssim, nov, R, tau, rep_best, rep_count


def detect_hooks(y: np.ndarray, downbeats: np.ndarray, duration: float, bpm: float,
                 bar_energy: np.ndarray, bar_bass: np.ndarray, bar_vocal: np.ndarray | None,
                 outro_end: float | None = None, lyrics: list[tuple[float, str]] | None = None,
                 S: np.ndarray | None = None, weights: dict | None = None, cache: dict | None = None,
                 pick_only: bool = False) -> dict:
    """Hook cues for one track. All times are downbeats (seconds).

    bar_energy / bar_bass: per bar, 1.0 = the track's typical bar (analysis_v2).
    bar_vocal: per bar 0..1 singing score (0.5 = singing), NaN where unknown.
    weights / cache / pick_only: for tuning (hooks_eval.py): other score
    weights, a dict that keeps the expensive features between calls for the
    same track, and skipping everything after the choice (key, energy, alts).
    """
    W = {**WEIGHTS, **(weights or {})}
    downbeats = np.asarray(downbeats, float)
    nb = len(downbeats)
    edges = np.r_[downbeats, duration]
    bar_len = 240.0 / bpm if bpm > 0 else float(np.median(np.diff(downbeats))) if nb > 1 else 2.0
    energy = np.asarray(bar_energy, float)[:nb]
    bass = np.asarray(bar_bass, float)[:nb]
    end = outro_end or duration
    if nb < 24 or len(energy) < nb:
        return _fallback(downbeats, duration, energy, bar_len, "too short for structure")

    if cache is not None and cache.get("S") is not None:
        S = cache["S"]
    if S is None:
        S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))
    if cache is not None:
        cache["S"] = S
    times = librosa.frames_to_time(np.arange(S.shape[1]), sr=SR, hop_length=HOP)
    if cache is not None and "feat" in cache:
        chroma, mel, Ssim, nov, R, tau, rep_best, rep_count = cache["feat"]
    else:
        chroma, mel, Ssim, nov, R, tau, rep_best, rep_count = _structure(S, times, edges, energy, nb)
        if cache is not None:
            cache["feat"] = (chroma, mel, Ssim, nov, R, tau, rep_best, rep_count)
    L = 8

    # Vocals: measured where we have it, lyrics where we have them.
    vocal = np.full(nb, np.nan) if bar_vocal is None else np.asarray(bar_vocal, float)[:nb]
    if lyrics:
        lv = lyric_vocal_bars(lyrics, edges)
        vocal = np.where(np.isfinite(vocal), np.maximum(vocal, 0.6 * lv), 0.6 * lv)
    vocal = np.nan_to_num(vocal, nan=0.0)
    sung_track = float(np.mean(vocal >= 0.5)) > 0.15

    # 8-bar loudness, relative to the loudest 8 bars of the track.
    e8 = np.array([energy[i:i + L].mean() if i + L <= nb else np.nan for i in range(nb)])
    e_top = float(np.nanpercentile(e8, 95)) or 1.0
    pos = (downbeats - downbeats[0]) / max(1.0, duration)

    def lift(i: int) -> float:
        if i < 4 or i + 2 > nb:
            return 0.0
        return float(np.clip((energy[i:i + 2].mean() - energy[i - 4:i].mean()) / e_top, 0, 1))

    rep_n = _norm01(rep_best)

    def score(i: int) -> float:
        if i + L > nb or not (EARLY <= pos[i] <= LATE) or edges[i + L] > end:
            return -1.0
        s = (W["rep"] * rep_n[i] + W["count"] * min(rep_count[i], 3) / 3
             + W["energy"] * min(e8[i] / e_top, 1.0) + W["nov"] * nov[i] + W["lift"] * lift(i))
        if sung_track:
            s *= 1 - W["vocal"] + W["vocal"] * min(1.0, vocal[i:i + L].mean() / 0.5)
        return float(s)

    scores = np.array([score(i) for i in range(nb)])
    # Sections start at boundaries: novelty peaks (strongest within 2 bars).
    starts = [i for i in range(nb) if scores[i] >= 0 and nov[i] >= 0.25
              and nov[i] >= nov[max(0, i - 2):i + 3].max()]
    if not starts:
        starts = [i for i in range(nb) if scores[i] >= 0]
    kind, lyric_used = "chorus", False

    # Lyrics, when they exist, say which section is the chorus. Snap each lyric
    # chorus start to the nearest downbeat, leaning later: singers often start
    # on a pickup just before the bar line, and LRC stamps lead the voice.
    # A clearly stronger section boundary one bar away wins over the nearest.
    lyric_starts = lyric_choruses(lyrics) if lyrics else []
    lyric_bars: list[int] = []
    for t in lyric_starts:
        b = int(np.argmin(np.abs(downbeats - (t + 0.2 * bar_len))))
        for k in (b - 1, b + 1):
            if 0 <= k < nb and nov[k] > nov[b] + 0.4:
                b = k
        if scores[b] >= 0:
            lyric_bars.append(b)

    # Drop: bass comes back hard after a bass-less build. Competes with choruses
    # in tracks that are mostly instrumental.
    jump = np.array([bass[i:i + 4].mean() - bass[max(0, i - 4):i].mean() if 4 <= i <= nb - 4 else 0.0
                     for i in range(nb)])
    drops = [i for i in range(4, nb - 4)
             if bass[i - 4:i].mean() < 0.35 and bass[i:i + 4].mean() > 0.8 and EARLY <= pos[i] <= LATE
             and jump[i] >= jump[max(0, i - 2):i + 3].max()]  # the sharpest bar of each jump

    if lyric_bars:
        occurrences = sorted(set(lyric_bars))
        lyric_used = True
    else:
        starts = sorted(set(starts) | {d for d in drops if scores[d] >= 0})
        best = max(starts, key=lambda i: scores[i])
        if scores[best] < 0:
            return _fallback(downbeats, duration, energy, bar_len, "no candidate section")
        if drops and not sung_track:
            d = max(drops, key=lambda i: scores[i])
            if scores[d] >= 0.8 * scores[best]:
                best, kind = d, "drop"
        # The same section elsewhere: other section starts whose next 8 bars
        # match. Stronger starts claim their place first, so the second half
        # of a 16-bar chorus can't pose as another chorus.
        row = np.nan_to_num(R[best], nan=-1)
        occurrences = [best]
        for k in sorted(starts, key=lambda k: -scores[k]):
            if (row[k] >= 0.95 * tau and scores[k] >= 0.8 * scores[best]
                    and all(abs(k - o) >= L for o in occurrences)):
                occurrences.append(k)
        occurrences.sort()
        if kind == "drop" and not any(o in drops for o in occurrences if o != best):
            # The drop rule fired once, but the section also comes back without a
            # bass-less build before it (a chorus after a breakdown): a chorus.
            if len(occurrences) > 1:
                kind = "chorus"

    # Which occurrence: the first full one (not a stripped-down or short first
    # chorus) that has room for a build before it.
    top_e = max(e8[o] for o in occurrences if np.isfinite(e8[o]))
    full = [o for o in occurrences if np.isfinite(e8[o]) and e8[o] >= 0.85 * top_e and o >= 4
            and EARLY <= pos[o] <= LATE]
    drop_bar = (full or occurrences)[0]

    # Length: 16 bars if the next 8 still hold up (same section, still loud), else 8.
    hook_bars = 8
    if drop_bar + 16 <= nb and edges[drop_bar + 16] <= end:
        second = energy[drop_bar + 8:drop_bar + 16].mean()
        same = Ssim[drop_bar + 8:drop_bar + 16, drop_bar:drop_bar + 8].diagonal().mean()
        boundary = nov[drop_bar + 7:drop_bar + 10].max()
        if second >= 0.85 * energy[drop_bar:drop_bar + 8].mean() and (same >= tau or boundary < 0.5):
            hook_bars = 16
    out_bar = min(drop_bar + hook_bars, nb)
    post = 0
    while post < MAX_POST_BARS and out_bar + post + 1 <= nb and edges[out_bar + post + 1] <= end:
        post += 1

    # Confidence: lyrics agree > strong repetition with a clear winner > loudness only.
    others = [scores[i] for i in range(nb) if scores[i] >= 0 and all(abs(i - o) >= L for o in occurrences)]
    margin = scores[drop_bar] - (max(others) if others else 0.0)
    conf = 0.45 * float(_norm01(rep_best)[drop_bar]) + 0.35 * float(np.clip(margin * 4, 0, 1)) \
        + 0.20 * min(1.0, rep_count[drop_bar] / 2)
    if kind == "drop":
        conf = max(conf, 0.6)
    if lyric_used:
        conf = max(conf, 0.85)
    if rep_best.max() < 0.5 and not lyric_used and kind == "chorus":
        kind = "energy"
        conf = min(conf, 0.4)

    if pick_only:
        return {**_cue_dict(downbeats, edges, drop_bar, hook_bars, nb), "hook_kind": kind,
                "hook_confidence": round(float(np.clip(conf, 0, 1)), 3)}

    # Alternatives: the best two other sections (for the "wrong hook" button).
    alts, taken = [], [drop_bar]
    for i in np.argsort(-scores):
        if scores[i] < 0 or len(alts) == 2:
            break
        if all(abs(i - t) >= L for t in taken):
            taken.append(int(i))
            alts.append(_cue_triplet(downbeats, edges, int(i), 8, nb))

    hook_chroma = _seg_mean(chroma, times, edges[drop_bar:out_bar + 1]).mean(axis=1)
    onset = librosa.onset.onset_strength(S=librosa.power_to_db(mel), sr=SR)
    a, b = np.searchsorted(times, [edges[drop_bar], edges[out_bar]])
    density = float(np.mean(onset[a:b])) if b > a else 0.0
    centroid = librosa.feature.spectral_centroid(S=S[:, a:b], sr=SR).mean() if b > a else 0.0
    # Rough 0..1 "energy" for flow between songs: tempo, attack density, brightness.
    hook_energy = (0.4 * np.clip((bpm - 70) / 80, 0, 1) + 0.35 * np.clip(density / 2.5, 0, 1)
                   + 0.25 * np.clip((centroid - 1000) / 2500, 0, 1))

    return {
        **_cue_dict(downbeats, edges, drop_bar, hook_bars, nb),
        "hook_post_bars": post,
        "hook_kind": kind,
        "hook_confidence": round(float(np.clip(conf, 0, 1)), 3),
        "hook_energy": round(float(hook_energy), 3),
        "hook_key": _ks_key(hook_chroma),
        "hook_alts": json.dumps(alts),
        "hook_lyrics": bool(lyrics),
        "hook_version": HOOK_VERSION,
    }


def _cue_triplet(downbeats: np.ndarray, edges: np.ndarray, drop: int, bars: int, nb: int) -> list[float]:
    d = _cue_dict(downbeats, edges, drop, bars, nb)
    return [d["hook_in"], d["hook_drop"], d["hook_out"]]


def _cue_dict(downbeats: np.ndarray, edges: np.ndarray, drop: int, bars: int, nb: int) -> dict:
    return {
        "hook_in": round(float(downbeats[max(0, drop - BUILD_BARS)]), 3),
        "hook_drop": round(float(downbeats[drop]), 3),
        "hook_out": round(float(edges[min(drop + bars, nb)]), 3),
    }


def _fallback(downbeats: np.ndarray, duration: float, energy: np.ndarray, bar_len: float, why: str) -> dict:
    """Loudest 8 bars after the first 10%: better than nothing, flagged as low confidence."""
    nb = len(downbeats)
    if nb < 12:
        return {"hook_in": None, "hook_drop": None, "hook_out": None, "hook_post_bars": 0,
                "hook_kind": "none", "hook_confidence": 0.0, "hook_energy": None, "hook_key": None,
                "hook_alts": "[]", "hook_lyrics": False, "hook_version": HOOK_VERSION, "hook_note": why}
    edges = np.r_[downbeats, duration]
    lo = max(4, int(0.1 * nb))
    best = max(range(lo, max(lo + 1, nb - 8)), key=lambda i: energy[i:i + 8].mean())
    return {**_cue_dict(downbeats, edges, best, 8, nb), "hook_post_bars": min(4, nb - best - 8),
            "hook_kind": "energy", "hook_confidence": 0.2, "hook_energy": None, "hook_key": None,
            "hook_alts": "[]", "hook_lyrics": False, "hook_version": HOOK_VERSION, "hook_note": why}


def analyze_hooks(path: str, row: dict, lyrics: list[tuple[float, str]] | None = None,
                  y: np.ndarray | None = None, weights: dict | None = None, cache: dict | None = None,
                  pick_only: bool = False) -> dict:
    """Hook cues for a track that analysis_v2 already analysed (`row` = its tracks row)."""
    from analysis_v2 import decode  # ffmpeg; imported here so tests can pass `y`
    if y is None:
        y = decode(path)
    downbeats = np.array(json.loads(row["downbeats"] or "[]"), float)
    duration = float(row["duration"] or len(y) / SR)
    energy = np.array(json.loads(row["bar_energy"] or "[]"), float)
    bass = np.array(json.loads(row["bar_bass"] or "[]"), float)
    if len(downbeats) < 2 or len(energy) < len(downbeats):
        return _fallback(downbeats, duration, energy, 2.0, "no beat grid")
    vocal = np.array([np.nan if v is None else v for v in json.loads(row["bar_vocal"] or "null") or []], float)
    if len(vocal) < len(downbeats):
        vocal = np.r_[vocal, np.full(len(downbeats) - len(vocal), np.nan)]
    # Demucs only measures the head and the tail; fill the middle (where hooks
    # live) with the cheap REPET estimate so the DJ planner can see vocals there.
    if cache is not None and "vocal" in cache:
        vocal = cache["vocal"]
    elif np.isnan(vocal).any():
        t, ratio = _vocal_ratio(y)
        edges = np.r_[downbeats, duration]
        est = _seg_mean(ratio[None, :], t, edges)[0] / (2 * SINGING_LEVEL["repet"])
        vocal = np.where(np.isnan(vocal), np.minimum(est, 1.0), vocal)
    if cache is not None:
        cache["vocal"] = vocal
    r = detect_hooks(y, downbeats, duration, float(row["bpm"] or 0), energy, bass, vocal,
                     row.get("outro_end"), lyrics, weights=weights, cache=cache, pick_only=pick_only)
    if not pick_only:
        r["bar_vocal_full"] = json.dumps([round(float(v), 2) for v in vocal])
    return r


if __name__ == "__main__":
    import sqlite3
    from analysis_v2 import analyze_track
    from lyrics import get_synced_lyrics

    db = sqlite3.connect("/opt/automix/automix.db")
    db.row_factory = sqlite3.Row
    for p in sys.argv[1:]:
        row = db.execute("SELECT * FROM tracks WHERE path = ?", (p,)).fetchone()
        row = dict(row) if row else analyze_track(p)
        lines = parse_lrc(get_synced_lyrics(p, float(row["duration"])))
        r = analyze_hooks(p, row, lines or None)
        r.pop("bar_vocal_full", None)
        print(p, json.dumps(r, indent=2))
        print("lyric choruses:", [round(t, 1) for t in lyric_choruses(lines)])
