#!/usr/bin/env python3
"""Render DJ-mode sets to audio, for judging by ear.

Mirrors the app (src/lib/dj.ts): pickNextDJ chooses the songs,
planHookTransition + buildCrossfadeCurves + buildHookFxCurves mix them. Each
song plays from its build to the end of its hook; the next song's hook lands on
that bar. After a mix the incoming tempo eases back to its own over 4 bars,
like the app. Tempo changes use librosa's time stretch, which smears more than
the browser's; listen for timing, choice of section and song, not stretch quality.

    nice -n 15 /opt/automix/venv/bin/python -I render_dj.py --set 8 --out /tmp/hookeval/renders
    nice -n 15 /opt/automix/venv/bin/python -I render_dj.py --pairs 6 --out /tmp/hookeval/renders

--set N renders one continuous set of N songs, --pairs N separate two-song
hand-offs (each from a different start song).
"""

from __future__ import annotations

import argparse
import json
import random
import sqlite3
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfilt

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analysis_hooks as ah  # noqa: E402
from analysis_v2 import SR, decode  # noqa: E402

DB = "/opt/automix/automix.db"
MAX_STRETCH = 0.06
VOCAL_ON = 0.5
MIN_CONF = 0.45
CAMELOT = {  # key -> (number, letter), as in dj.ts
    "C": (8, "B"), "G": (9, "B"), "D": (10, "B"), "A": (11, "B"), "E": (12, "B"), "B": (1, "B"),
    "F#": (2, "B"), "C#": (3, "B"), "G#": (4, "B"), "D#": (5, "B"), "A#": (6, "B"), "F": (7, "B"),
    "Am": (8, "A"), "Em": (9, "A"), "Bm": (10, "A"), "F#m": (11, "A"), "C#m": (12, "A"), "G#m": (1, "A"),
    "D#m": (2, "A"), "A#m": (3, "A"), "Fm": (4, "A"), "Cm": (5, "A"), "Gm": (6, "A"), "Dm": (7, "A"),
}


def tempo_match(a: float, b: float):
    """(rate, factor) for the incoming deck, as tempoMatch in dj.ts."""
    if not (a > 0 and b > 0):
        return None
    for factor in (1, 2, 0.5):
        rate = a / (b * factor)
        if abs(rate - 1) <= MAX_STRETCH:
            return rate, factor
    return None


def bar_at(downbeats, t):
    return int(np.searchsorted(downbeats, t + 1e-3, side="right") - 1)


def bars_before(downbeats, t, bars, bar_len):
    i = bar_at(downbeats, t + 0.05)
    if i >= 0 and abs(downbeats[i] - t) < 0.2 and i - bars >= 0:
        return float(downbeats[i - bars])
    return max(0.0, t - bars * bar_len)


def sings(tr, t):
    """Singing in the bar around t; unknown counts as singing (as in dj.ts)."""
    v, d = tr["vocal"], tr["downbeats"]
    i = bar_at(d, t)
    return not (0 <= i < len(v)) or v[i] is None or v[i] >= VOCAL_ON


def plan(out, inn, match, mix_end, room):
    """planHookTransition (dj.ts), in the outgoing's own time."""
    bar, in_bar = 240 / out["bpm"], 240 / inn["bpm"]
    drop = inn["hook"]["drop"]

    def swap(why):
        seconds = bar if match else max(1.5, min(3, in_bar))
        if match and match[1] <= 1:
            in_start = bars_before(inn["downbeats"], drop, round(1 / match[1]), in_bar)
        else:
            in_start = max(0.0, drop - seconds * (match[0] if match else 1))
        return dict(style="cut", bars=1, seconds=seconds, swap=(0.75, 0.98), cue_out=mix_end - seconds,
                    in_start=in_start, why=why)

    if not match:
        return swap("tempos too far apart")
    rate, factor = match
    reasons = []
    for n in (8, 4, 2):
        if n > room:
            continue
        cue = mix_end - n * bar
        in_start = bars_before(inn["downbeats"], drop, max(1, round(n / factor)), in_bar)
        both = sum(sings(out, cue + (k + .5) * bar) and sings(inn, in_start + (k + .5) * bar * rate)
                   for k in range(n - 1))
        if both:
            reasons.append(f"{n} bars: both sing {both}")
            continue
        return dict(style="blend", bars=n, seconds=n * bar, swap=((n - 1) / n, 0.98), cue_out=cue,
                    in_start=in_start, why=", ".join(reasons))
    return swap(", ".join(reasons) or f"room {room} bars")


def curves(points, swap_start, swap_end, style, bars):
    """buildCrossfadeCurves + buildHookFxCurves (dj.ts), as linear gains / Hz / dB."""
    p = np.linspace(0, 1, points)
    centre = min(0.98, max(0.02, (swap_start + swap_end) / 2))
    q = np.where(p <= centre, 0.5 * p / centre, 0.5 + 0.5 * (p - centre) / (1 - centre))
    g_out, g_in = np.cos(q * np.pi / 2), np.sin(q * np.pi / 2)
    s = np.clip((p - swap_start) / max(1e-3, swap_end - swap_start), 0, 1)
    b_out, b_in = np.cos(s * np.pi / 2), np.sin(s * np.pi / 2)
    g_out[-1], g_in[-1] = 0, 1
    last = (bars - 1) / bars if bars > 1 else 0.5
    hpf_out = np.full(points, 10.0)
    echo = np.zeros(points)
    if style == "blend":
        hpf_in = np.where(p < last, 400 * (20 / 400) ** (p / last), 10)
        mid_in = np.where(p < last, -6, -6 * (1 - (p - last) / (1 - last)))
    else:
        hpf_in = np.where(p < 0.97, 1500 * (30 / 1500) ** (p / 0.97), 10)
        mid_in = np.zeros(points)
        hpf_out = np.where(p < 0.25, 10, 20 * (1000 / 20) ** ((p - 0.25) / 0.75))
        echo = np.where(p < 0.5, 0, np.where(p < 0.75, 0.7 * (p - 0.5) / 0.25, 0.7))
    mid_in[-1], hpf_in[-1], echo[-1] = 0, 10, 0
    return dict(g_out=g_out, g_in=g_in, b_out=b_out, b_in=b_in, hpf_in=hpf_in, mid_in=mid_in,
                hpf_out=hpf_out, echo=echo)


def split_bass(x):
    low = sosfilt(butter(4, 200, "low", fs=SR, output="sos"), x)
    return low, x - low


def sweep_hpf(x, cutoffs):
    """High-pass whose cutoff follows `cutoffs` (one per block): a filter sweep."""
    out = np.array(x, copy=True)
    blk = len(x) // len(cutoffs) + 1
    zi = np.zeros((1, 2))
    for i, fc in enumerate(cutoffs):
        seg = x[i * blk:(i + 1) * blk]
        if not len(seg):
            break
        if fc > 15:
            y, zi = sosfilt(butter(2, fc, "high", fs=SR, output="sos"), seg, zi=zi)
            out[i * blk:i * blk + len(seg)] = y
        else:
            zi = np.zeros((1, 2))
    return out


def mid_duck(x, gains_db):
    """Approximate 1 kHz peaking cut: the 500-2000 Hz band scaled per block."""
    band = sosfilt(butter(2, [500, 2000], "band", fs=SR, output="sos"), x)
    g = np.repeat(10 ** (np.asarray(gains_db) / 20), len(x) // len(gains_db) + 1)[: len(x)]
    return x + band * (g - 1)


def echo_tail(x, send, delay_s, feedback=0.45, tail_s=4.0):
    """Pre-fader dub echo: delayed, darker, quieter repeats of x * send."""
    d = int(delay_s * SR)
    buf = np.zeros(len(x) + int(tail_s * SR))
    buf[: len(x)] = x * np.interp(np.arange(len(x)), np.linspace(0, len(x) - 1, len(send)), send)
    out = np.zeros_like(buf)
    lp = butter(1, 2500, "low", fs=SR, output="sos")
    for _ in range(12):
        buf = np.r_[np.zeros(d), buf[:-d]]
        out += buf
        buf = sosfilt(lp, buf) * feedback
    return out


def stretch(y, rate):
    import librosa
    return librosa.effects.time_stretch(y, rate=rate) if abs(rate - 1) > 1e-3 and len(y) > 4096 else y


def track(row, lyrics, cache_dir):
    npy = Path(cache_dir) / "audio" / (row["id"] + ".npy")
    y = np.load(npy).astype(np.float32) if npy.exists() else decode(row["path"])
    r = ah.analyze_hooks(row["path"], row, lyrics or None, y=y)
    return {
        "name": Path(row["path"]).stem, "path": row["path"], "y": y, "bpm": float(row["bpm"]),
        "duration": float(row["duration"]), "key": r["hook_key"] or row["key"], "energy": r["hook_energy"],
        "downbeats": np.array(json.loads(row["downbeats"])), "vocal": json.loads(r["bar_vocal_full"]),
        "conf": r["hook_confidence"], "kind": r["hook_kind"],
        "hook": {"in": r["hook_in"], "drop": r["hook_drop"], "out": r["hook_out"]},
        "profile": json.loads(r.get("sound_profile") or "[]"), "lang": r.get("lyric_lang"),
    }


def pick_score(cur, cand, style=None):
    """pickNextDJ (dj.ts) without the random part."""
    s = 0.0
    a, b = CAMELOT.get(cur["key"]), CAMELOT.get(cand["key"])
    if a and b:
        num = min(abs(a[0] - b[0]), 12 - abs(a[0] - b[0]))
        dist = num + (0 if a[1] == b[1] else 1)
        s += {0: 50, 1: 35, 2: 10}.get(dist, 0)
    d = abs(cur["bpm"] - cand["bpm"]) / cur["bpm"]
    if d <= 0.03:
        s += 40
    elif d <= 0.06:
        s += 30
    elif d <= 0.10:
        s += 15
    elif tempo_match(cur["bpm"], cand["bpm"]):
        s += 20
    e = cand["energy"] - cur["energy"]
    s += 20 if -0.05 <= e <= 0.12 else 8 if abs(e) <= 0.2 else 0
    if style:
        s += style(cur, cand)
    return s


def render_set(songs, notes):
    """One continuous mix of `songs` (each from its build to its hook end)."""
    plans = []
    for a, b in zip(songs, songs[1:]):
        bar = 240 / a["bpm"]
        h = a["hook"]
        keep = h["drop"] + min(8, int((h["out"] - h["drop"]) / bar / 2)) * bar
        start = plans[-1]["in_start"] if plans else h["in"]
        room = int((h["out"] - max(keep, start)) / bar + 0.01)
        m = tempo_match(a["bpm"], b["bpm"])
        pl = plan(a, b, m, h["out"], room)
        pl["rel"] = m[0] if m else 1.0
        plans.append(pl)
        notes.append(f"  {a['name']} [{a['lang']}] -> {b['name']} [{b['lang']}]: {'swap' if pl['style'] == 'cut' else 'blend'} "
                     f"{pl['bars']} bar{'s' if pl['bars'] > 1 else ''}, rate {pl['rel']:.3f}"
                     f"{' (' + pl['why'] + ')' if pl['why'] else ''}")

    segs = []
    for k, t in enumerate(songs):
        start = plans[k - 1]["in_start"] if k else t["hook"]["in"]
        end = t["hook"]["out"] if k < len(songs) - 1 else min(t["duration"], t["hook"]["out"] + 2 * 240 / t["bpm"])
        y, drop = t["y"], t["hook"]["drop"]
        rel = plans[k - 1]["rel"] if k else 1.0
        ramp = min(end, drop + 4 * 240 / t["bpm"])
        cut = lambda a, b: y[int(a * SR): int(b * SR)]  # noqa: E731
        seg = np.r_[stretch(cut(start, drop), rel), stretch(cut(drop, ramp), (rel + 1) / 2), cut(ramp, end)]
        segs.append(seg)

    pos, total, out_parts = 0, 0, []
    for k, seg in enumerate(segs):
        seg = seg.astype(np.float64)
        tail = None
        if k:  # entry: the window before this song's drop
            pl = plans[k - 1]
            E = min(len(seg), int(pl["seconds"] * SR))
            c = curves(256, *pl["swap"], pl["style"], pl["bars"])
            up = lambda v: np.interp(np.arange(E), np.linspace(0, E - 1, len(v)), v)  # noqa: E731
            w = sweep_hpf(mid_duck(seg[:E], c["mid_in"][::4]), c["hpf_in"][::4])
            lo, hi = split_bass(w)
            seg[:E] = lo * up(c["b_in"]) + hi * up(c["g_in"])
        if k < len(segs) - 1:  # exit: the last window of this song
            pl = plans[k]
            X = min(len(seg), int(pl["seconds"] * SR))
            c = curves(256, *pl["swap"], pl["style"], pl["bars"])
            up = lambda v: np.interp(np.arange(X), np.linspace(0, X - 1, len(v)), v)  # noqa: E731
            w = sweep_hpf(seg[-X:], c["hpf_out"][::4])
            if pl["style"] == "cut":
                tail = echo_tail(w, c["echo"][::4], 0.75 * 60 / songs[k]["bpm"])
            lo, hi = split_bass(w)
            seg[-X:] = lo * up(c["b_out"]) + hi * up(c["g_out"])
        else:  # last song: fade out over its final 2 bars
            n = min(len(seg), int(2 * 240 / songs[k]["bpm"] * SR))
            seg[-n:] *= np.linspace(1, 0, n)
        out_parts.append((pos, seg))
        if tail is not None:
            out_parts.append((pos + len(seg) - X, tail))
        total = max(total, pos + len(seg), pos + len(seg) - (X if tail is not None else 0) + (len(tail) if tail is not None else 0))
        if k < len(segs) - 1:
            pos += len(seg) - int(plans[k]["seconds"] * SR)
    mix = np.zeros(total)
    for p, s in out_parts:
        mix[p:p + len(s)] += s
    return mix


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", type=int, default=0)
    ap.add_argument("--set", type=int, default=0)
    ap.add_argument("--out", default="/tmp/hookeval/renders")
    ap.add_argument("--cache", default="/tmp/hookeval")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    random.seed(args.seed)
    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    lyr_file = Path(args.cache) / "lyrics.json"
    lyr = json.loads(lyr_file.read_text()) if lyr_file.exists() else {}
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    rows = [dict(r) for r in db.execute("SELECT * FROM tracks WHERE bpm > 0 AND downbeats IS NOT NULL")]
    db.close()

    pool = []
    for row in rows:
        t = track(row, ah.parse_lrc(lyr.get(row["path"], "")), args.cache)
        if t["conf"] >= MIN_CONF and t["hook"]["drop"] is not None:
            pool.append(t)
    print(f"{len(pool)} songs with trusted hooks", flush=True)

    # Sound profiles z-scored across the pool, as the API does (main.py _add_style).
    X = np.array([t["profile"] for t in pool], float)
    X = (X - X.mean(axis=0)) / (X.std(axis=0) + 1e-9)
    X /= np.linalg.norm(X, axis=1, keepdims=True) + 1e-9
    for t, v in zip(pool, X):
        t["style"] = v
    style_fn = fit_score

    def chain(first, n, avoid=frozenset()):
        songs, used = [first], {first["path"], *avoid}
        while len(songs) < n:
            cands = [c for c in pool if c["path"] not in used]
            if not cands:
                break
            best = max(cands, key=lambda c: pick_score(songs[-1], c, style_fn) + random.random() * 10)
            songs.append(best)
            used.add(best["path"])
        return songs

    def save(y, name):
        y = y / (np.abs(y).max() + 1e-9) * 0.9
        import soundfile as sf
        wav = outdir / f"{name}.wav"
        sf.write(wav, y.astype(np.float32), SR)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-b:a", "192k",
                        str(outdir / f"{name}.mp3")], check=True)
        wav.unlink()

    notes = []
    starts = random.sample(pool, max(2 * args.pairs, 1 if args.set else 0))
    paired: set[str] = set()
    for k in range(args.pairs):
        if starts[k]["path"] in paired:
            continue
        songs = chain(starts[k], 2, paired)
        paired.update(t["path"] for t in songs)
        notes.append(f"pair{k + 1}.mp3:")
        save(render_set(songs, notes), f"pair{k + 1}")
    if args.set:
        songs = chain(starts[0], args.set)
        notes.append("dj_set.mp3:")
        save(render_set(songs, notes), "dj_set")
    (outdir / "README.txt").write_text("\n".join(notes) + "\n")
    print("\n".join(notes))


def fit_score(a, b):
    """fitScore (dj.ts): sound alike (0..60) + same lyric language (30)."""
    return 60 * max(0.0, float(np.dot(a["style"], b["style"]))) + (30 if a["lang"] and a["lang"] == b["lang"] else 0)


if __name__ == "__main__":
    main()
