import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_START_LATENCY_S, GAPLESS_FADE_S, canGapless, clampLatency, equalPowerCurves,
  gaplessStartDelayS, updateLatency,
} from "../src/lib/gapless.ts";

test("the start is called early by the latency plus half the overlap", () => {
  const d = gaplessStartDelayS(1.0, 0.06);
  assert.ok(Math.abs(d - (1.0 - 0.06 - GAPLESS_FADE_S / 2)) < 1e-9);
});

test("a faster playbackRate shortens the wall-clock wait", () => {
  assert.ok(gaplessStartDelayS(1.0, 0.06, 2) < gaplessStartDelayS(1.0, 0.06, 1));
});

test("never negative, even when the song is already almost over", () => {
  assert.equal(gaplessStartDelayS(0.01, 0.06), 0);
  assert.equal(gaplessStartDelayS(-1, 0.06), 0);
  assert.equal(gaplessStartDelayS(1, 0.06, 0), gaplessStartDelayS(1, 0.06, 1)); // bad rate treated as 1
});

test("latency is clamped and a bad sample is ignored", () => {
  assert.equal(clampLatency(NaN), DEFAULT_START_LATENCY_S);
  assert.equal(clampLatency(5), 0.3);
  assert.equal(clampLatency(0), 0.01);
  assert.equal(updateLatency(0.08, NaN), 0.08);
  assert.equal(updateLatency(0.08, -1), 0.08);
});

test("one slow start moves the estimate only part of the way", () => {
  const next = updateLatency(0.06, 0.3);
  assert.ok(next > 0.06 && next < 0.2);
  let v = 0.06;
  for (let i = 0; i < 40; i++) v = updateLatency(v, 0.12);
  assert.ok(Math.abs(v - 0.12) < 0.005, "converges to a steady latency");
});

test("equal-power curves start and end exactly and keep constant power", () => {
  const { out, in: inn } = equalPowerCurves(16);
  assert.equal(out[0], 1);
  assert.equal(out[15], 0);
  assert.equal(inn[0], 0);
  assert.equal(inn[15], 1);
  for (let i = 1; i < 15; i++) assert.ok(Math.abs(out[i]! ** 2 + inn[i]! ** 2 - 1) < 1e-5);
});

test("gapless is skipped unless everything it needs is in place", () => {
  const ok = { enabled: true, hidden: false, hasNext: true, graphLive: true, nextReady: true };
  assert.equal(canGapless(ok), true);
  for (const k of ["enabled", "hasNext", "graphLive", "nextReady"] as const) assert.equal(canGapless({ ...ok, [k]: false }), false, k);
  assert.equal(canGapless({ ...ok, hidden: true }), false); // locked phone: the `ended` handoff does it
});
