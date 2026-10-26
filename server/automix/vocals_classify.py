#!/usr/bin/env python3
"""Detect singing over time with a sound classifier (no separation).

Backup of the backup: when neither Demucs nor Open-Unmix could separate a
song, this asks PANNs (CNN14, trained on Google's AudioSet) how likely each
moment is "singing". Much faster than separation (seconds per song) and
robust, but less precise about where singing starts and stops.

Runs in /opt/demucs/venv (needs panns_inference; weights ~300 MB in
~/panns_data, downloaded on first use):

    /opt/demucs/venv/bin/python vocals_classify.py SONG [--repair]

Prints JSON: {"hop": 0.1, "singing": [...], "model": "panns-cnn14"}
`singing` is the highest probability among the singing labels (Singing, Choir,
Male/Female/Child/Synthetic singing, Rapping) per 0.1 s frame.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run with -I: script dir isn't on sys.path
from vocals_separate import decode  # noqa: E402

SR = 32000                # PANNs sample rate
FRAME = 0.01              # PANNs framewise resolution
HOP = 0.1
CHUNK = 30                # seconds per inference call (bounded RAM)
SINGING = [27, 28, 32, 33, 34, 35, 36]  # AudioSet: Singing, Choir, Male/Female/Child/Synthetic singing, Rapping


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--repair", action="store_true")
    args = ap.parse_args()

    start = time.time()
    # panns_inference prints status lines to stdout; keep stdout for the JSON only.
    with contextlib.redirect_stdout(sys.stderr):
        from panns_inference import SoundEventDetection
        sed = SoundEventDetection(checkpoint_path=None, device="cpu")
    audio = decode(args.path, SR, 1, args.repair)[0]
    probs: list[np.ndarray] = []
    for a in range(0, len(audio), CHUNK * SR):
        seg = audio[a:a + CHUNK * SR]
        if len(seg) < SR:  # PANNs needs at least ~1 s
            seg = np.pad(seg, (0, SR - len(seg)))
        with torch.no_grad(), contextlib.redirect_stdout(sys.stderr):
            fw = sed.inference(seg[None, :])[0]  # (frames, 527)
        n = int(round(len(audio[a:a + CHUNK * SR]) / SR / FRAME))
        probs.append(fw[:n, SINGING].max(axis=1))
    p = np.concatenate(probs) if probs else np.zeros(0)
    per = int(round(HOP / FRAME))
    n = len(p) // per
    singing = p[: n * per].reshape(n, per).mean(axis=1)
    print(json.dumps({
        "hop": HOP,
        "singing": [round(float(x), 4) for x in singing],
        "model": "panns-cnn14",
        "seconds": round(time.time() - start, 1),
    }))


if __name__ == "__main__":
    main()
