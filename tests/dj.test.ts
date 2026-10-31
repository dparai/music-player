// Crossfade planner tests. Run: node --test tests/
// (Node 24 runs TypeScript directly; this folder is outside the app's tsconfig.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planTransition, tempoMatch, chooseTransition, sharedVocalBars,
  MAX_EXIT_SHIFT, MAX_START_SHIFT, type TrackShape,
} from "../src/lib/dj.ts";

// A track at `bpm` with downbeats from `first` every bar.
function shape(bpm: number, first: number, duration: number, vocal?: (t: number) => number): TrackShape {
  const bar = 240 / bpm;
  const downbeats: number[] = [];
  for (let t = first; t < duration; t += bar) downbeats.push(Math.round(t * 1000) / 1000);
  return {
    bpm, duration, downbeats, introEnd: first + 8 * bar, outroEnd: duration - 4,
    barEnergy: downbeats.map(() => 1),
    barVocal: vocal ? downbeats.map((t) => vocal(t + bar / 2)) : undefined,
  };
}

const OUT = shape(120, 0, 200);   // bar = 2 s
const INN = shape(120, 0.5, 200);
const MATCH = tempoMatch(120, 120)!;

test("Crossfade planner: intro-length blend", () => {
  const p = planTransition(OUT, INN, MATCH, 150, 0.5);
  assert.equal(p.style, "blend");
  assert.equal(p.bars, 8);   // incoming intro is 8 bars
});

test("Crossfade planner: no tempo match is a short fade", () => {
  const far = shape(90, 0.5, 200);
  const p = planTransition(OUT, far, tempoMatch(120, 90), 150, 0.5);
  assert.equal(p.style, "fade");
});

test("tempoMatch: straight, double and half time within 6%", () => {
  assert.equal(tempoMatch(120, 122)!.factor, 1);
  assert.equal(tempoMatch(120, 60)!.factor, 2);
  assert.equal(tempoMatch(60, 120)!.factor, 0.5);
  assert.equal(tempoMatch(120, 90), null);
});

// ---- chooseTransition: pick the exit and start, not just the length ----------

const SING = 1, QUIET = 0;
// 120 BPM, 200 s: bar = 2 s, phrase lines (4 bars) every 8 s from the intro end.
const outSinging = (from: number) => shape(120, 0, 200, (t) => (t >= from ? SING : QUIET));
const innSinging = shape(120, 0.5, 200, () => SING);

test("chooseTransition: keeps the default when it is already good", () => {
  const c = chooseTransition(OUT, INN, MATCH, 152, 0.5);
  assert.equal(c.changed, false);
  assert.equal(c.cue, 152);
  assert.equal(c.inStart, 0.5);
});

test("chooseTransition: moves the exit earlier to avoid shared vocals", () => {
  // The outgoing song starts singing at 150 s; the incoming one sings from bar 1.
  const out = outSinging(150);
  const before = planTransition(out, innSinging, MATCH, 152, 0.5);
  assert.ok((before.bars ?? 0) <= 2, "default exit is a forced cut");
  const c = chooseTransition(out, innSinging, MATCH, 152, 0.5);
  assert.equal(c.changed, true);
  assert.ok(c.cue < 152 && 152 - c.cue <= MAX_EXIT_SHIFT);
  assert.ok((c.plan.bars ?? 0) >= 4);
  assert.equal(sharedVocalBars(out, innSinging, MATCH, c.plan.bars ?? 0, c.cue, c.inStart), 0);
});

test("chooseTransition: never moves the exit beyond the limit", () => {
  // Singing from 130 s: only an exit more than 16 s earlier would be clear.
  const out = outSinging(130);
  const c = chooseTransition(out, innSinging, MATCH, 152, 0.5);
  assert.equal(c.changed, false);
  assert.equal(c.cue, 152);
});

test("chooseTransition: no tempo match or no beat grid leaves the default alone", () => {
  const far = shape(90, 0.5, 200, () => SING);
  assert.equal(chooseTransition(outSinging(150), far, tempoMatch(120, 90), 152, 0.5).changed, false);
  const bare: TrackShape = { bpm: 120, duration: 200 };
  assert.equal(chooseTransition(bare, INN, MATCH, 152, 0.5).changed, false);
  assert.equal(chooseTransition(null, null, null, 152, 0.5).changed, false);
});

test("chooseTransition: invariants over many vocal patterns", () => {
  const rank = (out: TrackShape, inn: TrackShape, cue: number, st: number) => {
    const p = planTransition(out, inn, MATCH, cue, st);
    const clash = sharedVocalBars(out, inn, MATCH, p.bars ?? 0, cue, st);
    return ((p.bars ?? 0) <= 2 ? 1000 : 0) + clash * 100 - (p.bars ?? 0);
  };
  let changedCount = 0;
  for (let s = 0; s < 60; s++) {
    const a = 6 + (s % 7) * 3, b = 5 + (s % 5) * 4;
    const out = shape(120, 0, 200, (t) => (Math.floor(t / a) + s) % 2);
    const inn = shape(120, 0.5, 200, (t) => (Math.floor(t / b) + s * 3) % 3 === 0 ? QUIET : SING);
    const def = 152;
    const c = chooseTransition(out, inn, MATCH, def, 0.5);
    // chosen points are real downbeats, inside the allowed window and the song
    assert.ok(out.downbeats!.includes(c.cue), `cue ${c.cue} is a downbeat`);
    assert.ok(inn.downbeats!.includes(c.inStart), `start ${c.inStart} is a downbeat`);
    assert.ok(c.cue >= Math.max(out.duration / 2, def - MAX_EXIT_SHIFT) && c.cue <= def + MAX_EXIT_SHIFT);
    assert.ok(c.cue <= out.outroEnd! - 2 * 2 || c.cue === def, "leaves room before the song's last audio");
    assert.ok(c.inStart >= 0.5 && c.inStart - 0.5 <= MAX_START_SHIFT && c.inStart <= inn.introEnd! + 1e-9);
    // never worse than the default, and the default is kept when it was already fine
    assert.ok(rank(out, inn, c.cue, c.inStart) <= rank(out, inn, def, 0.5));
    if (c.changed) { changedCount++; assert.ok(rank(out, inn, c.cue, c.inStart) < rank(out, inn, def, 0.5)); }
  }
  assert.ok(changedCount > 5, "the search did something on the generated cases");
});
