#!/usr/bin/env python3
"""Measure how loud the vocals are, over time, with Demucs source separation.

Runs in its own venv (/opt/demucs/venv: CPU torch + demucs 4.0.1), so torch
never touches the AutoMix venv. analysis_v2.py calls it as a subprocess:

    /opt/demucs/venv/bin/python vocals_demucs.py "/srv/music/song.flac" [HEAD_END TAIL_START]

Only [0, HEAD_END] and [TAIL_START, end] are separated (seconds): the parts a
transition reads (this song's intro as the incoming track, its outro as the
outgoing one). Demucs runs at ~2.3x real time on the VM's 2 ARM cores, so a
whole song costs ~8 min; the two windows ~3-4 min. Without them (or when
they overlap) the whole song is separated.

Prints JSON to stdout:
    {"hop": 0.1, "vocal": [...], "total": [...], "model": "htdemucs", "seconds": 212.3}
`vocal` and `total` are RMS per 0.1 s frame of the separated vocal stem and of
the full mix, for the whole song; frames outside the windows are null. The
stems are measured and thrown away; nothing is written to disk.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time

import numpy as np
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model

MODEL = "htdemucs"
HOP = 0.1  # seconds per output frame


def decode(path: str, sr: int, channels: int) -> np.ndarray:
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", str(channels), "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True, check=True, timeout=300,
    ).stdout
    return np.frombuffer(out, dtype=np.float32).reshape(-1, channels).T.copy()


def frame_rms(x: np.ndarray, hop: int) -> np.ndarray:
    """x: (channels, samples) -> RMS per hop-sized frame (mono power)."""
    power = (x ** 2).mean(axis=0)
    n = len(power) // hop
    return np.sqrt(power[: n * hop].reshape(n, hop).mean(axis=1))


def windows_for(n_samples: int, sr: int, hop: int, head_end: float | None, tail_start: float | None) -> list[tuple[int, int]]:
    """Sample ranges to separate, aligned to whole frames, merged if they touch."""
    end = (n_samples // hop) * hop
    if head_end is None or tail_start is None:
        return [(0, end)]
    a = min(end, int(head_end * sr) // hop * hop + hop)
    b = max(0, int(tail_start * sr) // hop * hop)
    if b <= a:
        return [(0, end)]
    return [(0, a), (b, end)]


def main(path: str, head_end: float | None, tail_start: float | None) -> None:
    start = time.time()
    model = get_model(MODEL)
    model.eval()
    sr, ch = model.samplerate, model.audio_channels
    wav = torch.from_numpy(decode(path, sr, ch))
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    hop = int(HOP * sr)
    n_frames = wav.shape[1] // hop
    vocal: list[float | None] = [None] * n_frames
    total = frame_rms(wav.numpy(), hop)
    vi = model.sources.index("vocals")
    for a, b in windows_for(wav.shape[1], sr, hop, head_end, tail_start):
        seg = (wav[:, a:b] - mean) / std
        with torch.no_grad():
            sources = apply_model(model, seg[None], shifts=0, split=True, overlap=0.1, progress=False)[0]
        v = frame_rms((sources[vi] * std).numpy(), hop)  # demucs also adds ref.mean() (DC, ~0): skipped
        for i, x in enumerate(v):
            vocal[a // hop + i] = round(float(x), 5)
    print(json.dumps({
        "hop": HOP,
        "vocal": vocal,
        "total": [round(float(v), 5) for v in total],
        "model": MODEL,
        "seconds": round(time.time() - start, 1),
    }))


if __name__ == "__main__":
    has_windows = len(sys.argv) > 3
    main(sys.argv[1], float(sys.argv[2]) if has_windows else None, float(sys.argv[3]) if has_windows else None)
