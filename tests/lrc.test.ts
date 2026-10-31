import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLrc, activeLine } from "../src/lib/lrc.ts";

test("parses stamps, skips tags, sorts by time", () => {
  const l = parseLrc("[ar:Someone]\n[00:12.50] second\n[00:01.00] first\n[00:30] third")!;
  assert.equal(l.synced, true);
  assert.deepEqual(l.lines.map((x) => x.text), ["first", "second", "third"]);
  assert.equal(l.lines[1]!.time, 12.5);
  assert.equal(l.lines[2]!.time, 30);
});

test("one text with two stamps becomes two lines", () => {
  const l = parseLrc("[00:10.00][01:10.00] chorus")!;
  assert.deepEqual(l.lines.map((x) => x.time), [10, 70]);
});

test("plain text stays unsynced", () => {
  const l = parseLrc("just words\nmore words")!;
  assert.equal(l.synced, false);
  assert.equal(l.lines.length, 2);
  assert.equal(l.lines[0]!.time, null);
});

test("empty input gives null", () => {
  assert.equal(parseLrc("[ti:x]\n\n"), null);
});

test("activeLine finds the line being sung", () => {
  const lines = [{ time: 5, text: "a" }, { time: 10, text: "b" }, { time: 20, text: "c" }];
  assert.equal(activeLine(lines, 2), -1);
  assert.equal(activeLine(lines, 5), 0);
  assert.equal(activeLine(lines, 19.9), 1);
  assert.equal(activeLine(lines, 99), 2);
});
