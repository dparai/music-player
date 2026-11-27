import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCueOut, planPair, MAX_INTRO_CUE } from "../src/lib/mixPlan.ts";

// 120 BPM: a beat every 0.5 s, a bar every 2 s, downbeats at 0, 2, 4, ...
const downbeats = Array.from({ length: 120 }, (_, i) => i * 2);
const track = (id: string, bpm: number, over: object = {}) =>
  ({ id, filename: id, bpm, confidence: 0.9, mix_in_point: 0, mix_out_point: 201, duration: 240, ...over }) as never;
const detail = (id: string, bpm: number, over: object = {}) => ({ ...(track(id, bpm) as object), path: "", beats: [], downbeats, ...over }) as never;

test("the default exit is the server's cue snapped back to a bar line", () => {
  const t = track("a", 120);
  const d = detail("a", 120);
  const r = defaultCueOut(t, d, 120, 240);
  assert.equal(r.onDownbeat, true);
  assert.equal(r.at % 2, 0);
  assert.ok(r.at <= 201 && 201 - r.at <= 8);
});

test("no beat grid: the cue is where the server says, not on a downbeat", () => {
  const r = defaultCueOut(track("a", 120), null, 120, 240);
  assert.equal(r.onDownbeat, false);
});

test("two songs at the same tempo give a mix that starts on bar lines", () => {
  const p = planPair({
    outId: "a", inId: "b", outTrack: track("a", 120), outDetail: detail("a", 120),
    inTrack: track("b", 120), inDetail: detail("b", 120), outBpm: 120, inBpm: 120, outDuration: 240,
  });
  assert.ok(p);
  assert.equal(p.fromId, "a");
  assert.equal(p.toId, "b");
  assert.equal(p.cueOutMs % 2000, 0, "starts on the outgoing bar line");
  assert.equal(p.inStartMs % 2000, 0, "starts on the incoming bar line");
  assert.equal(p.rate, 1);
  assert.ok(p.fadeMs >= 1000 && p.fadeMs <= 45000);
});

test("a slightly slower incoming song is sped up to the outgoing tempo", () => {
  const p = planPair({
    outId: "a", inId: "b", outTrack: track("a", 124), outDetail: detail("a", 124),
    inTrack: track("b", 120), inDetail: detail("b", 120), outBpm: 124, inBpm: 120, outDuration: 240,
  });
  assert.ok(p);
  assert.ok(Math.abs(p.rate - 124 / 120) < 1e-9);
});

test("no plan when the tempos are too far apart, the beat data is weak or missing", () => {
  const base = { outId: "a", inId: "b", outDuration: 240 };
  assert.equal(planPair({ ...base, outTrack: track("a", 100), outDetail: detail("a", 100), inTrack: track("b", 140), inDetail: detail("b", 140), outBpm: 100, inBpm: 140 }), null);
  assert.equal(planPair({ ...base, outTrack: track("a", 120, { confidence: 0.1 }), outDetail: detail("a", 120, { confidence: 0.1 }), inTrack: track("b", 120), inDetail: detail("b", 120), outBpm: 120, inBpm: 120 }), null);
  assert.equal(planPair({ ...base, outTrack: track("a", 120), outDetail: null, inTrack: track("b", 120), inDetail: detail("b", 120), outBpm: 120, inBpm: 120 }), null);
  assert.equal(planPair({ ...base, outTrack: null, outDetail: null, inTrack: null, inDetail: null, outBpm: null, inBpm: null }), null);
});

test("an incoming song whose first bar is far into the file gets no plan", () => {
  const late = Array.from({ length: 100 }, (_, i) => MAX_INTRO_CUE + 5 + i * 2);
  assert.equal(planPair({
    outId: "a", inId: "b", outTrack: track("a", 120), outDetail: detail("a", 120),
    inTrack: track("b", 120), inDetail: detail("b", 120, { downbeats: late }), outBpm: 120, inBpm: 120, outDuration: 240,
  }), null);
});
