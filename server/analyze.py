#!/usr/bin/env python3
"""Analyze BPM and musical key for all songs in the music library.
Writes results to /opt/brook-analysis/analysis.json served by Caddy.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import librosa
import numpy as np

MUSIC_DIR = "/srv/music"
OUTPUT_FILE = "/opt/brook-analysis/analysis.json"
SUPPORTED = {".mp3", ".flac", ".ogg", ".opus", ".m4a", ".wav", ".wma", ".aac"}

KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def detect_bpm(y, sr):
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    return round(float(np.asarray(tempo).flat[0]), 1)


def detect_key(y, sr):
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)

    major_profile = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor_profile = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

    best_corr = -1
    best_key = "C"
    best_mode = "major"

    for i in range(12):
        rolled = np.roll(chroma_mean, -i)
        maj_corr = np.corrcoef(rolled, major_profile)[0, 1]
        min_corr = np.corrcoef(rolled, minor_profile)[0, 1]

        if maj_corr > best_corr:
            best_corr = maj_corr
            best_key = KEY_NAMES[i]
            best_mode = "major"
        if min_corr > best_corr:
            best_corr = min_corr
            best_key = KEY_NAMES[i]
            best_mode = "minor"

    suffix = "" if best_mode == "major" else "m"
    return f"{best_key}{suffix}"


def load_audio(filepath):
    try:
        return librosa.load(filepath, sr=22050, mono=True, duration=120)
    except Exception:
        pass
    # Fallback: decode with ffmpeg to temp wav
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", filepath, "-ac", "1", "-ar", "22050",
             "-t", "120", "-f", "wav", tmp_path],
            capture_output=True, timeout=60,
        )
        return librosa.load(tmp_path, sr=22050, mono=True)
    finally:
        os.unlink(tmp_path)


def analyze_file(filepath):
    try:
        y, sr = load_audio(filepath)
        bpm = detect_bpm(y, sr)
        key = detect_key(y, sr)
        return {"bpm": bpm, "key": key}
    except Exception as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        return None


def main():
    existing = {}
    if os.path.exists(OUTPUT_FILE):
        with open(OUTPUT_FILE) as f:
            existing = json.load(f)

    music_path = Path(MUSIC_DIR)
    files = sorted(
        p for p in music_path.rglob("*")
        if p.suffix.lower() in SUPPORTED and p.is_file()
    )

    print(f"Found {len(files)} audio files")
    results = dict(existing)
    new_count = 0
    start = time.time()

    for i, fp in enumerate(files, 1):
        rel = str(fp.relative_to(music_path))
        if rel in results:
            continue

        print(f"[{i}/{len(files)}] {rel}")
        analysis = analyze_file(str(fp))
        if analysis:
            results[rel] = analysis
            new_count += 1

        if new_count % 10 == 0 and new_count > 0:
            with open(OUTPUT_FILE, "w") as f:
                json.dump(results, f, indent=2)

    with open(OUTPUT_FILE, "w") as f:
        json.dump(results, f, indent=2)

    elapsed = time.time() - start
    print(f"\nDone. Analyzed {new_count} new files in {elapsed:.0f}s")
    print(f"Total: {len(results)} entries in {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
