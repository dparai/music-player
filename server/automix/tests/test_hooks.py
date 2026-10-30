"""Hook detector tests on synthetic songs with known structure.

    python -I server/automix/tests/test_hooks.py      (needs librosa, numpy)

Each song is built bar by bar at 120 BPM (one bar = 2 s), so the true chorus /
drop bar is known exactly. Real-library accuracy is measured separately with
hooks_eval.py against lyric choruses.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import librosa  # noqa: E402

from analysis_hooks import detect_hooks, lyric_choruses, parse_lrc, lyric_vocal_bars  # noqa: E402
from analysis_v2 import HOP, SR, structure_profile  # noqa: E402

BPM = 120.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(7)


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def tone(f: float, dur: float, amp: float, harmonics: int = 3, decay: float = 0.0) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    env = np.exp(-decay * t) if decay else np.ones_like(t)
    w = sum(np.sin(2 * np.pi * f * k * t) / k for k in range(1, harmonics + 1))
    fade = np.minimum(1, np.minimum(t / 0.01, (dur - t) / 0.02 + 1e-9))
    return amp * w * env * np.clip(fade, 0, 1)


def add(buf: np.ndarray, x: np.ndarray, at: float) -> None:
    i = int(at * SR)
    j = min(len(buf), i + len(x))
    buf[i:j] += x[: j - i]


# Chord progressions (root midi of 4 one-bar triads), minor/major quality.
PROG = {
    "A": [(57, "m"), (53, ""), (48, ""), (55, "")],   # Am F C G
    "B": [(50, "m"), (52, "m"), (53, ""), (55, "")],  # Dm Em F G
    "C": [(53, ""), (55, ""), (52, "m"), (57, "m")],  # F G Em Am
    "D": [(48, ""), (52, "m"), (50, "m"), (55, "")],  # C Em Dm G
}
MELODY = {  # 8 notes per bar-pair, one per half bar, relative to a base
    "verse": [0, 2, 3, 2, 0, -2, 0, 0],
    "chorus": [7, 7, 9, 7, 12, 11, 9, 7],
    "bridge": [5, 4, 2, 0, 2, 4, 5, 7],
}


def section(kind: str, bars: int, prog: str, energy: float, bass: bool, drums: bool,
            melody: str | None, riser: bool = False) -> list[dict]:
    return [dict(kind=kind, prog=prog, idx=b, energy=energy, bass=bass, drums=drums, melody=melody,
                 riser=riser, bars=bars) for b in range(bars)]


def render(plan: list[dict]) -> np.ndarray:
    y = np.zeros(int(len(plan) * BAR * SR) + SR)
    for n, bar in enumerate(plan):
        t0 = n * BAR
        root, q = PROG[bar["prog"]][bar["idx"] % 4]
        third = 3 if q == "m" else 4
        e = bar["energy"]
        for iv in (0, third, 7):
            add(y, tone(hz(root + iv), BAR, 0.05 * e, harmonics=4), t0)
        if bar["bass"]:
            for b in range(4):
                add(y, tone(hz(root - 24), BEAT, 0.35 * e, harmonics=2, decay=2.0), t0 + b * BEAT)
        if bar["drums"]:
            for b in range(4):
                add(y, tone(55, 0.25, 0.6 * e, harmonics=1, decay=18), t0 + b * BEAT)
                add(y, rng.standard_normal(int(0.05 * SR)) * 0.05 * e, t0 + b * BEAT + BEAT / 2)
        if bar["melody"]:
            notes = MELODY[bar["melody"]]
            base = root + 12 + (bar["idx"] % 2) * 0
            for k in range(2):
                m = notes[(bar["idx"] % 4) * 2 + k] if bar["melody"] != "verse" else notes[((bar["idx"] % 4) * 2 + k) % 8]
                add(y, tone(hz(60 + m + (0 if bar["melody"] == "verse" else 2)), BAR / 2, 0.16 * e, harmonics=5),
                    t0 + k * BAR / 2)
        if bar["riser"]:
            t = np.arange(int(BAR * SR)) / SR
            f = 300 + 900 * (bar["idx"] + t / BAR) / bar["bars"]
            add(y, 0.04 * np.sin(2 * np.pi * np.cumsum(f) / SR) * (bar["idx"] + 1) / bar["bars"], t0)
    return (y / (np.abs(y).max() + 1e-9) * 0.8).astype(np.float32)


def pop(verse_prog: str = "A") -> tuple[list[dict], list[int]]:
    plan = (section("intro", 8, "D", 0.4, False, False, None)
            + section("verse", 16, verse_prog, 0.6, True, True, "verse")
            + section("pre", 8, "B", 0.55, False, True, "verse", riser=True)
            + section("chorus", 16, "C", 1.0, True, True, "chorus")
            + section("verse", 16, verse_prog, 0.6, True, True, "verse")
            + section("pre", 8, "B", 0.55, False, True, "verse", riser=True)
            + section("chorus", 16, "C", 1.0, True, True, "chorus")
            + section("bridge", 8, "D", 0.5, False, False, "bridge")
            + section("chorus", 16, "C", 1.0, True, True, "chorus")
            + section("outro", 8, "D", 0.35, False, False, None))
    starts = [i for i, b in enumerate(plan) if b["kind"] == "chorus" and b["idx"] == 0]
    return plan, starts


def edm() -> tuple[list[dict], list[int]]:
    plan = (section("intro", 16, "A", 0.5, False, True, None)
            + section("build", 8, "A", 0.5, False, False, None, riser=True)
            + section("drop", 16, "A", 1.0, True, True, None)
            + section("break", 16, "D", 0.4, False, False, None)
            + section("build", 8, "A", 0.5, False, False, None, riser=True)
            + section("drop", 16, "A", 1.0, True, True, None)
            + section("outro", 16, "A", 0.5, False, True, None))
    starts = [i for i, b in enumerate(plan) if b["kind"] == "drop" and b["idx"] == 0]
    return plan, starts


def run(plan: list[dict], lyrics=None, sung: bool = False) -> dict:
    y = render(plan)
    duration = len(y) / SR
    downbeats = np.arange(len(plan)) * BAR
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))
    prof = structure_profile(y, S, downbeats, duration, 0.0)
    # Singing in verses, pre-choruses and choruses (what Demucs would report).
    vocal = np.array([0.8 if b["melody"] in ("verse", "chorus") else 0.05 for b in plan]) if sung else None
    return detect_hooks(y, downbeats, duration, BPM, json.loads(prof["bar_energy"]), json.loads(prof["bar_bass"]),
                        vocal, prof["outro_end"], lyrics, S=S)


def bar_of(t: float) -> int:
    return int(round(t / BAR))


failures = 0


def check(name: str, ok: bool, detail: str) -> None:
    global failures
    print(("PASS " if ok else "FAIL ") + name + ": " + detail)
    failures += 0 if ok else 1


def test_pop(verse_prog: str, label: str, sung: bool = False) -> None:
    plan, starts = pop(verse_prog)
    r = run(plan, sung=sung)
    b = bar_of(r["hook_drop"])
    # Instrumental with a bass-less pre-chorus: "drop" is a fair label too.
    kinds = ("chorus",) if sung else ("chorus", "drop")
    check(label, b in starts[:2] and r["hook_kind"] in kinds and bar_of(r["hook_in"]) == b - 8,
          f"drop bar {b} (choruses at {starts}), in {bar_of(r['hook_in'])}, out {bar_of(r['hook_out'])}, "
          f"{r['hook_kind']}, conf {r['hook_confidence']}")
    check(label + " length", bar_of(r["hook_out"]) - b in (8, 16), f"{bar_of(r['hook_out']) - b} bars")


def test_edm() -> None:
    plan, starts = edm()
    r = run(plan)
    b = bar_of(r["hook_drop"])
    check("edm drop", b in starts and r["hook_kind"] in ("drop", "chorus"),
          f"drop bar {b} (drops at {starts}), {r['hook_kind']}, conf {r['hook_confidence']}")


def test_lyrics() -> None:
    lrc = "\n".join([
        "[00:10.00] Walking down the road tonight",
        "[00:14.00] Nothing seems to feel right",
        "[00:18.00] Every step a little slow",
        "[00:22.00] Nowhere else for me to go",
        "[00:30.00] Oh, hold me now (yeah)",
        "[00:34.00] Don't let me fall",
        "[00:38.00] Hold me now",
        "[00:42.00] Through it all",
        "[00:50.00] Morning light is coming through",
        "[00:54.00] All I see is me and you",
        "[01:02.00] Oh hold me now",
        "[01:06.00] Don't let me fall",
        "[01:10.00] Hold me now",
        "[01:14.00] Through it all",
        "[01:30.00] Oh, hold me now!",
        "[01:34.00] Don't let me fall",
        "[01:38.00] Hold me now",
        "[01:42.00] Through it all",
    ])
    lines = parse_lrc(lrc)
    starts = lyric_choruses(lines)
    check("lyric chorus", starts == [30.0, 62.0, 90.0], f"{starts}")
    sung = lyric_vocal_bars(lines, np.arange(0, 120, 2.0))
    check("lyric vocal bars", sung[5] == 1 and sung[2] == 0 and sung[13] == 1, f"bars 2,5,13 = {sung[[2, 5, 13]]}")


def test_lyrics_steer() -> None:
    # Lyrics put the chorus at the second chorus's bar: detector must follow them
    # (snapped to the bar grid; the singer starts on a pickup 0.3 s early).
    plan, starts = pop("C")
    t = starts[1] * BAR - 0.3
    lines = [(t + 2 * k, w) for k, w in enumerate("la di da hey you there".split())]
    lines += [(10.0 + 2 * k, w) for k, w in enumerate("one two three four five six".split())]
    lines += [(t + 80 + 2 * k, w) for k, w in enumerate("la di da hey you there".split())]
    r = run(plan, sorted(lines))
    b = bar_of(r["hook_drop"])
    check("lyrics steer", b == starts[1] and r["hook_confidence"] >= 0.85, f"drop bar {b}, want {starts[1]}")


if __name__ == "__main__":
    test_lyrics()
    test_pop("A", "pop (verse/chorus differ)")
    test_pop("C", "pop (verse shares chorus chords)")
    test_pop("C", "pop sung (verse shares chorus chords)", sung=True)
    test_edm()
    test_lyrics_steer()
    print(f"\n{failures} failed")
    sys.exit(1 if failures else 0)
