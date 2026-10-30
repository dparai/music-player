// DJ-mode planner tests. Run: node --test tests/
// (Node 24 runs TypeScript directly; this folder is outside the app's tsconfig.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planHookTransition, planTransition, djCueOut, trustedHook, tempoMatch, buildHookFxCurves, type TrackShape,
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

const OUT = shape(120, 0, 200);       // bar = 2 s
const INN = shape(120, 0.5, 200);
const MATCH = tempoMatch(120, 120)!;

test("8-bar build lands the incoming drop at the end of the mix", () => {
  const p = planHookTransition(OUT, INN, MATCH, 100, 60.5, 8);
  assert.equal(p.style, "blend");
  assert.equal(p.bars, 8);
  assert.equal(p.seconds, 16);
  assert.equal(p.inStart, 44.5);                 // 60.5 - 8 bars
  assert.ok(p.swapStart >= 0.85, "bass swap in the last bar");
});

test("outgoing post-hook room limits the build", () => {
  const p = planHookTransition(OUT, INN, MATCH, 100, 60.5, 4);
  assert.equal(p.bars, 4);
  assert.equal(p.inStart, 52.5);
});

test("no room after the hook: cut on the drop", () => {
  const p = planHookTransition(OUT, INN, MATCH, 100, 60.5, 0);
  assert.equal(p.style, "cut");
  assert.equal(p.inStart, 58.5);
});

test("outro end limits the build too", () => {
  const p = planHookTransition(OUT, INN, MATCH, 190, 60.5, 8); // outroEnd 196: 3 bars left
  assert.equal(p.bars, 2);
});

test("vocals over each other shorten the build, then cut", () => {
  const out = shape(120, 0, 200, () => 0.9);              // outgoing sings throughout
  const inSingsBuild = shape(120, 0.5, 200, () => 0.9);   // incoming too
  const p = planHookTransition(out, inSingsBuild, MATCH, 100, 60.5, 8);
  assert.equal(p.style, "cut");
  assert.equal(p.inStart, 58.5);                 // one bar before the drop
  assert.match(p.reason, /vocals overlap/);

  // Incoming only sings in the last bar before its drop: one shared bar is fine.
  const inLate = shape(120, 0.5, 200, (t) => (t >= 58.5 && t < 60.5 ? 0.9 : 0.05));
  const q = planHookTransition(out, inLate, MATCH, 100, 60.5, 8);
  assert.equal(q.style, "blend");
  assert.equal(q.bars, 8);
});

test("no tempo match: short cut, incoming a bar before its drop", () => {
  const far = shape(90, 0.5, 200);
  const p = planHookTransition(OUT, far, tempoMatch(120, 90), 100, 60.5, 8);
  assert.equal(p.style, "cut");
  assert.ok(Math.abs(p.inStart - (60.5 - 240 / 90)) < 0.01);
  assert.ok(p.seconds >= 1.5 && p.seconds <= 3);
});

test("half-time incoming counts its own (longer) bars", () => {
  const half = shape(60, 0.5, 300);               // bar = 4 s
  const m = tempoMatch(120, 60)!;
  assert.equal(m.factor, 2);
  const p = planHookTransition(OUT, half, m, 100, 64.5, 8);
  assert.equal(p.bars, 8);                        // 8 outgoing bars = 16 s
  assert.equal(p.inStart, 64.5 - 4 * 4);          // = 4 incoming bars
});

test("djCueOut: end of the hook, else the next 4-bar line from the hook", () => {
  const hook = { in: 44, drop: 60, out: 92, postBars: 8 };
  const d = OUT.downbeats!;
  assert.equal(djCueOut(d, hook, 50), 92);
  // DJ switched on at 95 s: next 4-bar line (from bar 30 = 60 s) at least 8 s away.
  assert.equal(djCueOut(d, hook, 95), 108);
  assert.equal(djCueOut(undefined, hook, 95), null);
});

test("trustedHook needs complete cues and enough confidence", () => {
  const t = { hook_in: 44, hook_drop: 60, hook_out: 92, hook_post_bars: 8, hook_confidence: 0.7 };
  assert.deepEqual(trustedHook(t), { in: 44, drop: 60, out: 92, postBars: 8 });
  assert.equal(trustedHook({ ...t, hook_confidence: 0.3 }), null);
  assert.equal(trustedHook({ ...t, hook_out: null }), null);
  assert.equal(trustedHook({ ...t, hook_out: 50 }), null);
  assert.equal(trustedHook(null), null);
});

test("Crossfade planner is unchanged: intro-length blend", () => {
  const p = planTransition(OUT, INN, MATCH, 150, 0.5);
  assert.equal(p.style, "blend");
  assert.equal(p.bars, 8);   // incoming intro is 8 bars
});

test("hook FX: filter dives over the build and opens fully for the drop", () => {
  const fx = buildHookFxCurves(128, "blend", 8);
  assert.ok(Math.abs(fx.hpfIn[0]! - 400) < 1e-3);
  assert.ok(fx.hpfIn[60]! < fx.hpfIn[10]!, "cutoff falls");
  assert.equal(fx.hpfIn[127], 10);
  assert.equal(fx.midIn[0], -6);
  assert.equal(fx.midIn[127], 0);
  assert.ok(fx.echoOut.every((v) => v === 0), "no echo on a blend");
  const cut = buildHookFxCurves(128, "cut", 1);
  assert.ok(cut.hpfIn.every((v) => v === 10) && cut.midIn.every((v) => v === 0));
  assert.ok(Math.max(...cut.echoOut) >= 0.6 && cut.echoOut[0] === 0 && cut.echoOut[127] === 0);
});
