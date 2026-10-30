// Crossfade planner tests. Run: node --test tests/
// (Node 24 runs TypeScript directly; this folder is outside the app's tsconfig.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planTransition, tempoMatch, type TrackShape,
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
