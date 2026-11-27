import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeQueue, sameQueue, NATIVE_QUEUE_AFTER } from "../src/lib/nativeQueue.ts";

const s = (id: string) => ({ id, title: id } as never);

test("queue is [previous, current, ...after] and the start index points at the current song", () => {
  const q = nativeQueue(s("c"), [s("a"), s("b")], [s("d"), s("e")]);
  assert.deepEqual(q.songs.map((x: { id: string }) => x.id), ["b", "c", "d", "e"]);
  assert.equal(q.startIndex, 1);
});

test("with nothing before, the current song is first", () => {
  const q = nativeQueue(s("a"), [], [s("b")]);
  assert.deepEqual(q.songs.map((x: { id: string }) => x.id), ["a", "b"]);
  assert.equal(q.startIndex, 0);
});

test("the current song and repeats are never listed twice", () => {
  const q = nativeQueue(s("a"), [s("a")], [s("a"), s("b"), s("b"), s("c")]);
  assert.deepEqual(q.songs.map((x: { id: string }) => x.id), ["a", "b", "c"]);
});

test("the queue after the current song is capped", () => {
  const after = Array.from({ length: NATIVE_QUEUE_AFTER + 50 }, (_, i) => s("x" + i));
  assert.equal(nativeQueue(s("a"), [], after).songs.length, NATIVE_QUEUE_AFTER + 1);
});

test("sameQueue compares ids and urls", () => {
  assert.equal(sameQueue([{ id: "a", url: "1" }], [{ id: "a", url: "1" }]), true);
  assert.equal(sameQueue([{ id: "a", url: "1" }], [{ id: "a", url: "2" }]), false);
  assert.equal(sameQueue([{ id: "a" }], [{ id: "a" }, { id: "b" }]), false);
});
