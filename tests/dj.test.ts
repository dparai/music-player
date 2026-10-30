// DJ-mode planner tests. Run: node --test tests/
// (Node 24 runs TypeScript directly; this folder is outside the app's tsconfig.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planHookTransition, planTransition, djCueOut, trustedHook, tempoMatch, buildHookFxCurves, fitScore, type TrackShape,
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

const QUIET = () => 0.05;                          // no singing
const OUT = shape(120, 0, 200, QUIET);            // bar = 2 s
const INN = shape(120, 0.5, 200, QUIET);
const MATCH = tempoMatch(120, 120)!;

test("8-bar build inside the outgoing hook lands the incoming drop at the hook end", () => {
  const p = planHookTransition(OUT, INN, MATCH, 100, 60.5, 8);
  assert.equal(p.style, "blend");
  assert.equal(p.bars, 8);
  assert.equal(p.seconds, 16);
  assert.equal(p.cueOut, 84);                    // 100 - 8 bars: the mix ends on the hook end
  assert.equal(p.inStart, 44.5);                 // 60.5 - 8 bars
  assert.ok(p.swapStart >= 0.85, "bass swap in the last bar");
});

test("room in the outgoing hook limits the build", () => {
  const p = planHookTransition(OUT, INN, MATCH, 100, 60.5, 4);
  assert.equal(p.bars, 4);
  assert.equal(p.cueOut, 92);
  assert.equal(p.inStart, 52.5);
});

test("no room: one-bar swap on the drop", () => {
  const p = planHookTransition(OUT, INN, MATCH, 100, 60.5, 0);
  assert.equal(p.style, "cut");
  assert.equal(p.bars, 1);
  assert.equal(p.cueOut, 98);
  assert.equal(p.inStart, 58.5);
});

test("both singing before the last bar: no blend, swap", () => {
  const out = shape(120, 0, 200, () => 0.9);              // outgoing hook is sung throughout
  const inSings = shape(120, 0.5, 200, () => 0.9);
  const p = planHookTransition(out, inSings, MATCH, 100, 60.5, 8);
  assert.equal(p.style, "cut");
  assert.equal(p.inStart, 58.5);
  assert.match(p.reason, /both sing/);

  // An instrumental build under a sung hook is the classic blend; a pickup
  // in the last bar before the drop is fine.
  const inPickup = shape(120, 0.5, 200, (t) => (t >= 58.5 && t < 60.5 ? 0.9 : 0.05));
  const q = planHookTransition(out, inPickup, MATCH, 100, 60.5, 8);
  assert.equal(q.style, "blend");
  assert.equal(q.bars, 8);

  // Sung build, but the outgoing's last 4 bars are instrumental: 4-bar blend.
  const outEnds = shape(120, 0, 200, (t) => (t >= 92 ? 0.05 : 0.9));
  const r = planHookTransition(outEnds, inSings, MATCH, 100, 60.5, 8);
  assert.equal(r.bars, 4);
});

test("unknown vocals count as singing: swap", () => {
  const p = planHookTransition(shape(120, 0, 200), shape(120, 0.5, 200), MATCH, 100, 60.5, 8); // no vocal data
  assert.equal(p.style, "cut");
  // Unknown on one side only: a known-instrumental build still blends.
  assert.equal(planHookTransition(shape(120, 0, 200), INN, MATCH, 100, 60.5, 8).style, "blend");
});

test("no tempo match: swap, incoming one of its own bars before its drop", () => {
  const far = shape(90, 0.5, 200, QUIET);
  const p = planHookTransition(OUT, far, tempoMatch(120, 90), 100, 60.5, 8);
  assert.equal(p.style, "cut");
  assert.ok(p.seconds >= 1.5 && p.seconds <= 3);
  assert.ok(Math.abs(p.cueOut + p.seconds - 100) < 1e-9, "outgoing ends at the hook end");
  assert.ok(Math.abs(p.inStart + p.seconds - 60.5) < 1e-9, "incoming drop lands there too");
});

test("half-time incoming counts its own (longer) bars", () => {
  const half = shape(60, 0.5, 300, QUIET);        // bar = 4 s
  const m = tempoMatch(120, 60)!;
  assert.equal(m.factor, 2);
  const p = planHookTransition(OUT, half, m, 100, 64.5, 8);
  assert.equal(p.bars, 8);                        // 8 outgoing bars = 16 s
  assert.equal(p.inStart, 64.5 - 4 * 4);          // = 4 incoming bars
  const s = planHookTransition(OUT, half, m, 100, 64.5, 0);
  assert.equal(s.style, "cut");
  assert.equal(s.inStart, 64.5 - 2);              // swap: half an incoming bar = one outgoing bar
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

test("hook FX: blend filter dive; swap wash-out, echo and filtered pickup", () => {
  const fx = buildHookFxCurves(128, "blend", 8);
  assert.ok(Math.abs(fx.hpfIn[0]! - 400) < 1e-3);
  assert.ok(fx.hpfIn[60]! < fx.hpfIn[10]!, "cutoff falls");
  assert.equal(fx.hpfIn[127], 10);
  assert.equal(fx.midIn[0], -6);
  assert.equal(fx.midIn[127], 0);
  assert.ok(fx.echoOut.every((v) => v === 0), "no echo on a blend");
  assert.ok(fx.hpfOut.every((v) => v === 10), "outgoing unfiltered on a blend");
  const cut = buildHookFxCurves(128, "cut", 1);
  assert.ok(cut.hpfIn[0]! > 1000 && cut.hpfIn[127] === 10, "incoming pickup filtered, opens on the drop");
  assert.ok(cut.hpfOut[0] === 10 && cut.hpfOut[120]! > 500, "outgoing washes out");
  assert.ok(Math.max(...cut.echoOut) >= 0.6 && cut.echoOut[0] === 0 && cut.echoOut[127] === 0);
});

test("fitScore: alike-sounding songs in one language score highest", () => {
  const a = { lang: "en", style: [1, 0, 0] };
  assert.equal(fitScore(a, { lang: "en", style: [1, 0, 0] }), 90);
  assert.equal(fitScore(a, { lang: "desi", style: [0, 1, 0] }), 0);
  assert.equal(fitScore(a, { lang: "desi", style: [-1, 0, 0] }), 0, "opposite sound is no bonus, not a penalty");
  assert.equal(fitScore(a, { lang: "en" }), 30, "no profile yet: language only");
});
