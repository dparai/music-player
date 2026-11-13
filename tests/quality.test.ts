// Streaming quality tests. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { transcodeFor, QUALITIES } from "../src/lib/quality.ts";

test("original never transcodes", () => {
  assert.equal(transcodeFor({ bitRate: 950 }, "original", "opus"), null);
});

test("tiers cap the bitrate", () => {
  assert.deepEqual(transcodeFor({ bitRate: 950 }, "high", "opus"), { format: "opus", maxBitRate: 256 });
  assert.deepEqual(transcodeFor({ bitRate: 950 }, "normal", "mp3"), { format: "mp3", maxBitRate: 128 });
  assert.deepEqual(transcodeFor({ bitRate: 950 }, "saver", "opus"), { format: "opus", maxBitRate: 64 });
});

test("a file already at or under the tier is streamed as it is", () => {
  assert.equal(transcodeFor({ bitRate: 256 }, "high", "opus"), null);
  assert.equal(transcodeFor({ bitRate: 128 }, "high", "opus"), null);
  assert.notEqual(transcodeFor({ bitRate: 320 }, "high", "opus"), null);
});

test("unknown bitrate is transcoded", () => {
  assert.deepEqual(transcodeFor({}, "normal", "opus"), { format: "opus", maxBitRate: 128 });
  assert.deepEqual(transcodeFor({ bitRate: 0 }, "normal", "opus"), { format: "opus", maxBitRate: 128 });
});

test("high is 256 kbps", () => {
  assert.equal(QUALITIES.find((q) => q.id === "high")?.kbps, 256);
});
