import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EQ_BANDS, EQ_RANGE_DB, PRESETS, autoPreampDb, clampGain, isFlat, peakResponseDb, presetFor,
  responseDb, sanitizeSound, biquadCoefs, bandKind,
} from "../src/lib/sound.ts";

test("flat curve needs no preamp and has a 0 dB response everywhere", () => {
  const flat = new Array(10).fill(0);
  assert.equal(autoPreampDb(flat), 0);
  for (const f of [20, 100, 1000, 10000, 20000]) assert.ok(Math.abs(responseDb(flat, f)) < 1e-9);
});

test("a single boost is centred on its band and matches the gain there", () => {
  const g = new Array(10).fill(0);
  g[5] = 6; // 1 kHz peaking
  assert.ok(Math.abs(responseDb(g, 1000) - 6) < 0.05);
  assert.ok(responseDb(g, 100) < 0.6);
  assert.ok(responseDb(g, 10000) < 0.6);
});

test("outer bands shelve: a 31 Hz boost lifts everything below it", () => {
  const g = new Array(10).fill(0);
  g[0] = 6;
  assert.equal(bandKind(0), "lowshelf");
  assert.equal(bandKind(9), "highshelf");
  assert.ok(responseDb(g, 20) > 5);
  assert.ok(responseDb(g, 5000) < 0.3);
});

test("auto preamp cancels the peak, never over-correcting a flat or cut-only curve", () => {
  const boost = PRESETS.find((p) => p.id === "bass")!.gains;
  const pre = autoPreampDb(boost);
  assert.ok(pre < 0);
  assert.ok(peakResponseDb(boost) + pre <= 0.001, "peak must end at or below 0 dB");
  assert.ok(peakResponseDb(boost) + pre > -0.2, "and not be over-cut");
  const cut = new Array(10).fill(-4);
  assert.equal(autoPreampDb(cut), 0);
});

test("overlapping boosts add up, so the preamp is larger than the biggest single gain", () => {
  const g = new Array(10).fill(0);
  g[4] = 6; g[5] = 6;
  assert.ok(-autoPreampDb(g) > 6.5);
});

test("every preset keeps its peak at or under 0 dB after the preamp", () => {
  for (const p of PRESETS) {
    assert.equal(p.gains.length, EQ_BANDS.length, p.id);
    assert.ok(p.gains.every((x) => Math.abs(x) <= EQ_RANGE_DB), p.id);
    assert.ok(peakResponseDb(p.gains) + autoPreampDb(p.gains) <= 0.001, p.id);
  }
});

test("clampGain keeps to the range in half-dB steps and survives junk", () => {
  assert.equal(clampGain(20), EQ_RANGE_DB);
  assert.equal(clampGain(-20), -EQ_RANGE_DB);
  assert.equal(clampGain(1.26), 1.5);
  assert.equal(clampGain(NaN), 0);
});

test("presetFor finds a preset exactly, and reports custom curves as null", () => {
  assert.equal(presetFor(PRESETS[2]!.gains)?.id, "treble");
  const custom = PRESETS[2]!.gains.slice(); custom[0] = 1;
  assert.equal(presetFor(custom), null);
  assert.ok(isFlat(PRESETS[0]!.gains));
  assert.ok(!isFlat(custom));
});

test("sanitizeSound repairs bad stored data instead of throwing", () => {
  const d = sanitizeSound(null);
  assert.deepEqual(d.eq, new Array(10).fill(0));
  assert.equal(d.normalize, true);
  assert.equal(d.gapless, true);
  assert.deepEqual(sanitizeSound({ eq: [1, 2, 3] }).eq, new Array(10).fill(0)); // wrong length
  const s = sanitizeSound({ eq: [99, -99, "x", 0, 0, 0, 0, 0, 0, 1.2], normalize: false, gapless: 5 });
  assert.deepEqual(s.eq, [12, -12, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(s.normalize, false);
  assert.equal(s.gapless, true); // not a boolean: keep the default
});

test("biquad coefficients are stable (poles inside the unit circle)", () => {
  for (const kind of ["lowshelf", "peaking", "highshelf"] as const) {
    for (const f of EQ_BANDS) for (const g of [-12, 12]) {
      const c = biquadCoefs(kind, f, g, 1.41, 44100);
      assert.ok(Math.abs(c.a2) < 1 && Math.abs(c.a1) < 1 + c.a2, `${kind} ${f} ${g}`);
    }
  }
});
