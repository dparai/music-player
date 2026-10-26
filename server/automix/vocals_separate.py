#!/usr/bin/env python3
"""Measure how loud the vocals are, over time, by separating them from the music.

Runs in its own venv (/opt/demucs/venv: CPU torch, demucs 4.0.1, openunmix),
so torch never touches the AutoMix venv. analysis_v2.py calls it as a
subprocess:

    /opt/demucs/venv/bin/python vocals_separate.py SONG [--model htdemucs|umxl]
        [--head-end S --tail-start S] [--chunk S] [--repair]

--model      htdemucs (Demucs, best) or umxl (Open-Unmix, the backup model:
             different design, lighter, a bit less precise).
--head-end / --tail-start
             Only [0, head_end] and [tail_start, end] are separated: the parts
             a transition reads (this song's intro as the incoming track, its
             outro as the outgoing one). Separation runs at ~2.3x real time on
             the VM's 2 ARM cores, so this halves the cost.
--chunk      Separate in pieces of this many seconds (retry after a timeout or
             out-of-memory: less RAM at a time).
--repair     Decode with ffmpeg's error tolerance (skip corrupt frames, first
             audio stream only): retry after the file couldn't be read.

Prints JSON to stdout:
    {"hop": 0.1, "vocal": [...], "total": [...], "model": "htdemucs", "seconds": 212.3}
`vocal` and `total` are RMS per 0.1 s frame of the vocal stem and of the full
mix, for the whole song; frames outside the windows are null. Stems are
measured and thrown away; nothing is written to disk.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time

import numpy as np
import torch

HOP = 0.1  # seconds per output frame


def decode(path: str, sr: int, channels: int, repair: bool) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error"]
    if repair:
        cmd += ["-err_detect", "ignore_err", "-fflags", "+discardcorrupt+genpts"]
    cmd += ["-i", path]
    if repair:
        cmd += ["-map", "0:a:0"]
    cmd += ["-vn", "-ac", str(channels), "-ar", str(sr), "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True, timeout=600, check=not repair).stdout
    if not out:
        raise RuntimeError("decode produced no audio")
    return np.frombuffer(out, dtype=np.float32)[: len(out) // 4 // channels * channels].reshape(-1, channels).T.copy()


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


def pieces(a: int, b: int, size: int | None) -> list[tuple[int, int]]:
    if not size:
        return [(a, b)]
    return [(s, min(b, s + size)) for s in range(a, b, size)]


class Demucs:
    name = "htdemucs"

    def __init__(self) -> None:
        from demucs.pretrained import get_model
        self.model = get_model("htdemucs")
        self.model.eval()
        self.sr, self.channels = self.model.samplerate, self.model.audio_channels
        self.vi = self.model.sources.index("vocals")

    def vocals(self, seg: torch.Tensor, mean: torch.Tensor, std: torch.Tensor) -> np.ndarray:
        from demucs.apply import apply_model
        with torch.no_grad():
            out = apply_model(self.model, ((seg - mean) / std)[None], shifts=0, split=True, overlap=0.1, progress=False)[0]
        return (out[self.vi] * std).numpy()  # demucs also adds the mean back (DC, ~0): skipped


class OpenUnmix:
    name = "umxl"

    def __init__(self) -> None:
        from openunmix import utils
        # niter=0: no Wiener/EM refinement, which needs two targets (we only ask for vocals).
        self.sep = utils.load_separator("umxl", targets=["vocals"], niter=0, device="cpu", pretrained=True)
        self.sep.freeze()
        self.sr, self.channels = int(self.sep.sample_rate), 2

    def vocals(self, seg: torch.Tensor, mean: torch.Tensor, std: torch.Tensor) -> np.ndarray:
        with torch.no_grad():
            out = self.sep(seg[None])  # (batch, targets, channels, samples)
        return out[0, 0].numpy()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--model", choices=["htdemucs", "umxl"], default="htdemucs")
    ap.add_argument("--head-end", type=float)
    ap.add_argument("--tail-start", type=float)
    ap.add_argument("--chunk", type=float, default=0)
    ap.add_argument("--repair", action="store_true")
    args = ap.parse_args()

    start = time.time()
    sep = Demucs() if args.model == "htdemucs" else OpenUnmix()
    wav = torch.from_numpy(decode(args.path, sep.sr, sep.channels, args.repair))
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    hop = int(HOP * sep.sr)
    vocal: list[float | None] = [None] * (wav.shape[1] // hop)
    chunk = int(args.chunk * sep.sr) // hop * hop if args.chunk else None
    for a, b in windows_for(wav.shape[1], sep.sr, hop, args.head_end, args.tail_start):
        for c, d in pieces(a, b, chunk):
            v = frame_rms(sep.vocals(wav[:, c:d], mean, std), hop)
            for i, x in enumerate(v):
                if c // hop + i < len(vocal):
                    vocal[c // hop + i] = round(float(x), 5)
    print(json.dumps({
        "hop": HOP,
        "vocal": vocal,
        "total": [round(float(v), 5) for v in frame_rms(wav.numpy(), hop)],
        "model": sep.name,
        "seconds": round(time.time() - start, 1),
    }))


if __name__ == "__main__":
    main()
