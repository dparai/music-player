#!/usr/bin/env python3
"""Render sample DJ-mode hand-offs to audio, for judging by ear.

Mirrors the app's DJ mix (src/lib/dj.ts planHookTransition +
buildCrossfadeCurves + buildHookFxCurves): the outgoing hook plays to its end,
the incoming build rises under the outgoing post-hook, the bass swaps in the
last bar and the incoming hook lands as the outgoing fades out. Tempo matching
uses librosa's time stretch, which smears more than the browser's; listen for
timing and choice of section, not stretch quality.

    nice -n 15 /opt/automix/venv/bin/python -I render_dj.py --pairs 8 --out /tmp/hookeval/renders
    nice -n 15 /opt/automix/venv/bin/python -I render_dj.py --set 6 --out /tmp/hookeval/renders

--set renders one continuous DJ set of N songs (hook to hook), --pairs N
separate two-song hand-offs. Picks songs whose hooks are trusted.
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


def tempo_match(a: float, b: float):
    if not (a > 0 and b > 0):
        return None
    for factor in (1, 2, 0.5):
        rate = a / (b * factor)
        if abs(rate - 1) <= MAX_STRETCH:
            return rate, factor
    return None


def bar_at(downbeats, t):
    i = int(np.searchsorted(downbeats, t + 1e-3, side="right") - 1)
    return i


def bars_before(downbeats, t, bars, bar_len):
    i = bar_at(downbeats, t + 0.05)
    if i >= 0 and abs(downbeats[i] - t) < 0.2 and i - bars >= 0:
        return float(downbeats[i - bars])
    return max(0.0, t - bars * bar_len)


def plan(out, inn, match, cue_out):
    """Same decision as planHookTransition (dj.ts)."""
    bar = 240 / out["bpm"]
    in_bar = 240 / inn["bpm"]
    if not match:
        return dict(style="cut", bars=1, seconds=max(1.5, min(3, bar)), swap=(0.3, 0.7),
                    in_start=bars_before(inn["downbeats"], inn["hook"]["drop"], 1, in_bar))
    rate, factor = match
    end = out.get("outro_end") or out["duration"]
    room = min(max(0, out["hook"]["post"]), int((end - cue_out) / bar + 0.01))

    def sings(tr, t):
        v, d = tr["vocal"], tr["downbeats"]
        i = bar_at(d, t)
        return 0 <= i < len(v) and (v[i] or 0) >= VOCAL_ON

    for n in (8, 4, 2):
        if n > room:
            continue
        in_start = bars_before(inn["downbeats"], inn["hook"]["drop"], max(1, round(n / factor)), in_bar)
        both = sum(1 for k in range(n) if sings(out, cue_out + (k + .5) * bar) and
                   sings(inn, in_start + (k + .5) * bar * rate))
        if both > 1:
            continue
        return dict(style="blend", bars=n, seconds=n * bar, swap=((n - 1) / n, 0.98), in_start=in_start)
    return dict(style="cut", bars=1, seconds=bar, swap=(0.25, 0.75),
                in_start=bars_before(inn["downbeats"], inn["hook"]["drop"], 1, in_bar))


def curves(points, swap_start, swap_end, style, bars):
    """buildCrossfadeCurves + buildHookFxCurves, as linear gains / Hz."""
    p = np.linspace(0, 1, points)
    centre = min(0.98, max(0.02, (swap_start + swap_end) / 2))
    q = np.where(p <= centre, 0.5 * p / centre, 0.5 + 0.5 * (p - centre) / (1 - centre))
    g_out, g_in = np.cos(q * np.pi / 2), np.sin(q * np.pi / 2)
    s = np.clip((p - swap_start) / max(1e-3, swap_end - swap_start), 0, 1)
    bass_out, bass_in = np.cos(s * np.pi / 2), np.sin(s * np.pi / 2)
    g_out[-1], g_in[-1] = 0, 1
    last = (bars - 1) / bars if bars > 1 else 0.5
    if style == "blend":
        hpf = np.where(p < last, 400 * (20 / 400) ** (p / last), 10)
        mid = np.where(p < last, -6, -6 * (1 - (p - last) / (1 - last)))
        echo = np.zeros(points)
    else:
        hpf, mid = np.full(points, 10.0), np.zeros(points)
        echo = np.where(p < 0.15, 0, np.where(p < 0.9, 0.6, 0.6 * (1 - (p - 0.9) / 0.1)))
    return g_out, g_in, bass_out, bass_in, hpf, mid, echo


def split_bass(x):
    sos = butter(4, 200, "low", fs=SR, output="sos")
    low = sosfilt(sos, x)
    return low, x - low


def blockwise_hpf(x, cutoffs):
    """High-pass with a cutoff that changes every block (a filter sweep)."""
    out = np.zeros_like(x)
    blk = len(x) // len(cutoffs) + 1
    zi = None
    for i, fc in enumerate(cutoffs):
        seg = x[i * blk:(i + 1) * blk]
        if not len(seg):
            break
        if fc <= 15:
            out[i * blk:i * blk + len(seg)] = seg
            zi = None
            continue
        sos = butter(2, fc, "high", fs=SR, output="sos")
        if zi is None or zi.shape[0] != sos.shape[0]:
            zi = np.zeros((sos.shape[0], 2))
        y, zi = sosfilt(sos, seg, zi=zi)
        out[i * blk:i * blk + len(seg)] = y
    return out


def mid_duck(x, gains_db):
    """Approximate 1 kHz peaking cut: band 500-2000 Hz scaled per block."""
    sos = butter(2, [500, 2000], "band", fs=SR, output="sos")
    band = sosfilt(sos, x)
    g = np.repeat(10 ** (np.asarray(gains_db) / 20), len(x) // len(gains_db) + 1)[: len(x)]
    return x + band * (g - 1)


def echo(x, send, delay_s, feedback=0.45, tail_s=4.0):
    d = int(delay_s * SR)
    n = len(x) + int(tail_s * SR)
    inp = np.zeros(n)
    inp[: len(x)] = x * np.repeat(send, len(x) // len(send) + 1)[: len(x)]
    out = np.zeros(n)
    sos = butter(1, 2500, "low", fs=SR, output="sos")
    buf = inp.copy()
    for _ in range(12):  # repeats, each quieter and duller
        buf = np.r_[np.zeros(d), buf[:-d]] if d > 0 else buf
        out += buf
        buf = sosfilt(sos, buf) * feedback
    return out


def stretch(y, rate):
    import librosa
    return librosa.effects.time_stretch(y, rate=rate) if abs(rate - 1) > 1e-3 else y


def track(row, lyrics, cache_dir):
    npy = Path(cache_dir) / "audio" / (row["id"] + ".npy")
    y = np.load(npy).astype(np.float32) if npy.exists() else decode(row["path"])
    r = ah.analyze_hooks(row["path"], row, lyrics or None, y=y)
    return {
        "name": Path(row["path"]).stem, "y": y, "bpm": float(row["bpm"]), "duration": float(row["duration"]),
        "outro_end": row.get("outro_end"), "downbeats": np.array(json.loads(row["downbeats"])),
        "vocal": json.loads(r["bar_vocal_full"]), "conf": r["hook_confidence"], "kind": r["hook_kind"],
        "hook": {"in": r["hook_in"], "drop": r["hook_drop"], "out": r["hook_out"], "post": r["hook_post_bars"]},
    }


def mix(out, inn, start_out):
    """Audio from `start_out` in the outgoing track through the incoming hook; returns
    (samples, incoming time where the result ends handing over, description)."""
    m = tempo_match(out["bpm"], inn["bpm"])
    cue = out["hook"]["out"]
    pl = plan(out, inn, m, cue)
    rate = m[0] if m else 1.0
    a = out["y"][int(start_out * SR): int((cue + pl["seconds"]) * SR)]
    pre = int((cue - start_out) * SR)
    # Incoming: from in_start, stretched to the outgoing tempo.
    in_seg = inn["y"][int(pl["in_start"] * SR): int((inn["hook"]["out"]) * SR)]
    in_seg = stretch(in_seg, rate)
    n_mix = int(pl["seconds"] * SR)
    pts = 256
    g_out, g_in, b_out, b_in, hpf, mid, ech = curves(pts, *pl["swap"], pl["style"], pl["bars"])
    up = lambda c: np.interp(np.arange(n_mix), np.linspace(0, n_mix - 1, pts), c)  # noqa: E731
    # Outgoing during the mix: bass and the rest on their own curves.
    seg_o = a[pre: pre + n_mix]
    seg_o = np.r_[seg_o, np.zeros(n_mix - len(seg_o))]
    lo, hi = split_bass(seg_o)
    mixed_o = lo * up(b_out) + hi * up(g_out)
    tail = echo(seg_o, ech[:: max(1, pts // 64)], 0.75 * 60 / out["bpm"]) if pl["style"] == "cut" else np.zeros(0)
    seg_i = in_seg[:n_mix]
    seg_i = np.r_[seg_i, np.zeros(n_mix - len(seg_i))]
    seg_i = blockwise_hpf(mid_duck(seg_i, mid[:: max(1, pts // 64)]), hpf[:: max(1, pts // 64)])
    lo, hi = split_bass(seg_i)
    mixed_i = lo * up(b_in) + hi * up(g_in)
    body = np.r_[a[:pre], mixed_o + mixed_i, in_seg[n_mix:]]
    if len(tail):
        body[pre: pre + len(tail)] += tail[: max(0, len(body) - pre)]
    desc = (f"{out['name']} -> {inn['name']}: {pl['style']} {pl['bars']} bars, "
            f"rate {rate:.3f}, in from {pl['in_start']:.1f}s (drop {inn['hook']['drop']:.1f}s)")
    return body, desc


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
    random.shuffle(rows)
    # Prefer songs with lyrics (the production path) and keep tempos mixable.
    rows.sort(key=lambda r: not ah.parse_lrc(lyr.get(r["path"], "")))
    tracks, notes = [], []
    want = max(args.set, 2 * args.pairs)
    for row in rows:
        if len(tracks) >= want:
            break
        t = track(row, ah.parse_lrc(lyr.get(row["path"], "")), args.cache)
        if t["conf"] >= MIN_CONF and t["hook"]["drop"] is not None:
            pairing = args.set or len(tracks) % 2 == 1  # the second song of a pair, or any song of a set
            if tracks and pairing and not tempo_match(tracks[-1]["bpm"], t["bpm"]):
                continue  # keep beat-matchable neighbours like the picker would
            tracks.append(t)
            print(f"  {t['name']}: {t['kind']} at {t['hook']['drop']:.1f}s (conf {t['conf']})", flush=True)

    def save(y, name):
        y = y / (np.abs(y).max() + 1e-9) * 0.9
        wav = outdir / f"{name}.wav"
        import soundfile as sf
        sf.write(wav, y.astype(np.float32), SR)
        mp3 = outdir / f"{name}.mp3"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-b:a", "192k", str(mp3)], check=True)
        wav.unlink()
        return mp3

    if args.pairs:
        for k in range(args.pairs):
            a, b = tracks[2 * k], tracks[2 * k + 1]
            y, desc = mix(a, b, a["hook"]["in"])
            notes.append(f"pair{k + 1}.mp3: {desc}")
            save(y, f"pair{k + 1}")
    if args.set:
        parts, start = [], tracks[0]["hook"]["in"]
        for a, b in zip(tracks, tracks[1:]):
            y, desc = mix(a, b, start)
            # Keep only up to the incoming drop; the next mix continues from there.
            cut = len(y) - int((b["hook"]["out"] - b["hook"]["drop"]) / (tempo_match(a["bpm"], b["bpm"]) or (1, 1))[0] * SR)
            parts.append(y[:max(0, cut)])
            start = b["hook"]["drop"]
            notes.append(desc)
        parts.append(tracks[-1]["y"][int(start * SR): int(tracks[-1]["hook"]["out"] * SR)])
        save(np.concatenate(parts), "dj_set")
        notes.insert(0, "dj_set.mp3:")
    (outdir / "README.txt").write_text("\n".join(notes) + "\n")
    print("\n".join(notes))


if __name__ == "__main__":
    main()
