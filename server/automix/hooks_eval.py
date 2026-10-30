#!/usr/bin/env python3
"""Measure (and tune) the audio-only hook detector against lyric choruses.

For every analysed track that has synced lyrics on LRCLIB, the start of each
repeat of its most-repeated lyric block is taken as truth. A hit is a
hook_drop within 2 bars of any of them.

    nice -n 15 /opt/automix/venv/bin/python -I hooks_eval.py [--cache DIR] [--only SUBSTR] [--grid]

--grid tries a grid of score weights and reports two-fold cross-validated
accuracy (tune on half the songs, score on the other half), so a weight set
that only fits these particular songs doesn't look better than it is.

Decoded audio and lyrics are cached in DIR (default /tmp/hookeval), so runs
after the first one skip ffmpeg and the network.
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analysis_hooks as ah  # noqa: E402
from analysis_v2 import decode  # noqa: E402
from lyrics import get_synced_lyrics  # noqa: E402

DB = os.environ.get("AUTOMIX_DB", "/opt/automix/automix.db")

GRID = {
    "rep": [0.15, 0.30, 0.45],
    "count": [0.0, 0.10, 0.25],
    "energy": [0.15, 0.30, 0.45],
    "nov": [0.0, 0.15],
    "lift": [0.0, 0.15, 0.30],
    "vocal": [0.0, 0.25, 0.5],
}


def load_tracks(args) -> list[dict]:
    cache = Path(args.cache)
    (cache / "audio").mkdir(parents=True, exist_ok=True)
    lyr_file = cache / "lyrics.json"
    lyr = json.loads(lyr_file.read_text()) if lyr_file.exists() else {}
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    rows = [dict(r) for r in db.execute("SELECT * FROM tracks WHERE downbeats IS NOT NULL ORDER BY path")]
    db.close()
    out = []
    for row in rows:
        p = row["path"]
        if args.only and args.only.lower() not in p.lower():
            continue
        if p not in lyr:
            text = get_synced_lyrics(p, float(row["duration"]))
            if text is None:
                print(f"  lyrics fetch failed, skipping: {Path(p).name}", flush=True)
                continue
            lyr[p] = text
            lyr_file.write_text(json.dumps(lyr))
            time.sleep(1.0)  # be polite to the free API
        row["truth"] = ah.lyric_choruses(ah.parse_lrc(lyr[p]))
        out.append(row)
    return out


def audio(row: dict, cache_dir: str) -> np.ndarray:
    npy = Path(cache_dir) / "audio" / (row["id"] + ".npy")
    if npy.exists():
        return np.load(npy).astype(np.float32)
    y = decode(row["path"])
    np.save(npy, y.astype(np.float16))
    return y


def is_hit(row: dict, drop: float | None) -> tuple[bool, float]:
    bar = 240.0 / float(row["bpm"] or 120)
    if drop is None:
        return False, 99.0
    err = min(abs(drop - t) for t in row["truth"])
    return err <= 2 * bar + 0.5, err / bar


def report(args, rows: list[dict]) -> None:
    hits = n_truth = 0
    by_kind: dict[str, list[int]] = {}
    out = []
    t_total = 0.0
    for row in rows:
        y = audio(row, args.cache)
        t0 = time.time()
        r = ah.analyze_hooks(row["path"], row, None, y=y)  # audio only: lyrics are the answer key
        t_total += time.time() - t0
        rec = {"name": Path(row["path"]).name, "drop": r["hook_drop"], "kind": r["hook_kind"],
               "conf": r["hook_confidence"], "truth": [round(t, 1) for t in row["truth"]]}
        if row["truth"]:
            hit, err = is_hit(row, r["hook_drop"])
            rec.update(hit=hit, err_bars=round(err, 1))
            n_truth += 1
            hits += hit
            by_kind.setdefault(r["hook_kind"], []).append(int(hit))
        out.append(rec)
        mark = "" if "hit" not in rec else ("HIT " if rec["hit"] else "MISS")
        print(f"{mark:4} {rec['name'][:48]:48} drop {r['hook_drop']!s:>8} {r['hook_kind']:6} "
              f"c={r['hook_confidence']:.2f} truth {rec['truth']} err {rec.get('err_bars', '-')}", flush=True)
    print(f"\n{len(rows)} tracks, {n_truth} with lyric choruses, hook pass {t_total / max(len(rows), 1):.1f} s/track")
    if n_truth:
        print(f"hit rate (±2 bars): {hits}/{n_truth} = {hits / n_truth:.0%}")
        for k, v in by_kind.items():
            print(f"  {k}: {sum(v)}/{len(v)}")
        for lo in (0.0, 0.45, 0.6, 0.75):
            sel = [o for o in out if "hit" in o and o["conf"] >= lo]
            if sel:
                print(f"  conf >= {lo:.2f}: {sum(o['hit'] for o in sel)}/{len(sel)} = "
                      f"{sum(o['hit'] for o in sel) / len(sel):.0%}")
    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=1))


def grid(args, rows: list[dict]) -> None:
    rows = [r for r in rows if r["truth"]]
    keys = list(GRID)
    configs = [dict(zip(keys, v)) for v in itertools.product(*(GRID[k] for k in keys))]
    print(f"{len(rows)} tracks with lyric choruses, {len(configs)} weight sets", flush=True)
    hits = np.zeros((len(configs), len(rows)), bool)
    for j, row in enumerate(rows):
        y = audio(row, args.cache)
        cache: dict = {}
        ah.analyze_hooks(row["path"], row, None, y=y, cache=cache, pick_only=True)
        cache["S"] = None  # keep only the bar-level features (memory)
        for i, w in enumerate(configs):
            r = ah.analyze_hooks(row["path"], row, None, y=y, weights=w, cache=cache, pick_only=True)
            hits[i, j] = is_hit(row, r["hook_drop"])[0]
        print(f"  [{j + 1}/{len(rows)}] {Path(row['path']).name[:50]}", flush=True)

    base = [i for i, w in enumerate(configs) if all(w[k] == ah.WEIGHTS[k] for k in keys)]
    total = hits.mean(axis=1)
    folds = [np.arange(len(rows)) % 2 == 0, np.arange(len(rows)) % 2 == 1]
    cv = []
    for train, test in (folds, folds[::-1]):
        best = int(np.argmax(hits[:, train].mean(axis=1)))
        cv.append((hits[best, test].mean(), configs[best]))
    print(f"\ncurrent weights: {total[base[0]]:.0%}" if base else "\ncurrent weights not in grid")
    print(f"best on all songs: {total.max():.0%} with {configs[int(np.argmax(total))]}")
    print(f"cross-validated: {np.mean([c[0] for c in cv]):.0%}  (folds: "
          + ", ".join(f"{a:.0%} with {w}" for a, w in cv) + ")")
    top = np.argsort(-total)[:8]
    print("top weight sets:")
    for i in top:
        print(f"  {total[i]:.0%}  {configs[i]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default="/tmp/hookeval")
    ap.add_argument("--only", default="")
    ap.add_argument("--json", default="")
    ap.add_argument("--grid", action="store_true")
    args = ap.parse_args()
    rows = load_tracks(args)
    (grid if args.grid else report)(args, rows)


if __name__ == "__main__":
    main()
