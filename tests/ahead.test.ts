import { test } from "node:test";
import assert from "node:assert/strict";
import { AheadStore, type AheadDeps, type AheadItem } from "../src/lib/ahead.ts";
import { upcomingSongs } from "../src/lib/queue.ts";

const big = (n = 50_000) => new Blob([new Uint8Array(n)]);

function rig(opts: { fail?: Set<string>; sizes?: Record<string, number>; hang?: Set<string> } = {}) {
  const calls: string[] = [];
  const made: string[] = [];
  const revoked: string[] = [];
  const events: string[] = [];
  const deps: AheadDeps = {
    fetchFn: (url, init) => {
      calls.push(url);
      if (opts.hang?.has(url)) {
        return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
      }
      if (opts.fail?.has(url)) return Promise.resolve(new Response("nope", { status: 503 }));
      return Promise.resolve(new Response(big(opts.sizes?.[url] ?? 50_000), { status: 200 }));
    },
    makeUrl: (b) => { const u = `blob:${made.length}-${b.size}`; made.push(u); return u; },
    revokeUrl: (u) => { revoked.push(u); },
    onEvent: (e) => events.push(e),
  };
  const items = (...ids: string[]): AheadItem[] => ids.map((id) => ({ key: id, url: () => `/stream/${id}` }));
  return { store: new AheadStore(deps), calls, made, revoked, events, items };
}

test("fetches the songs in play order, one at a time, and hands back blob URLs", async () => {
  const r = rig();
  await r.store.sync(["cur"], r.items("a", "b", "c"));
  assert.deepEqual(r.calls, ["/stream/a", "/stream/b", "/stream/c"]);
  assert.ok(r.store.urlFor("a")?.startsWith("blob:"));
  assert.equal(r.store.urlFor("nope"), null);
  assert.deepEqual(r.store.keys().sort(), ["a", "b", "c"]);
});

test("a song already held is not fetched again", async () => {
  const r = rig();
  await r.store.sync([], r.items("a", "b"));
  await r.store.sync([], r.items("a", "b", "c"));
  assert.deepEqual(r.calls, ["/stream/a", "/stream/b", "/stream/c"]);
});

test("songs that fall out of the window are dropped and their URLs revoked; the playing one stays", async () => {
  const r = rig();
  await r.store.sync([], r.items("a", "b", "c"));
  const aUrl = r.store.urlFor("a")!;
  const bUrl = r.store.urlFor("b")!;
  await r.store.sync(["a"], r.items("c", "d")); // "a" is playing now, "b" is gone
  assert.equal(r.store.urlFor("a"), aUrl, "the playing song keeps its URL");
  assert.equal(r.store.has("b"), false);
  assert.ok(r.revoked.includes(bUrl));
  assert.ok(!r.revoked.includes(aUrl));
  assert.deepEqual(r.store.keys().sort(), ["a", "c", "d"]);
});

test("a failed fetch is reported, skipped, and retried by the next round", async () => {
  const r = rig({ fail: new Set(["/stream/b"]) });
  await r.store.sync([], r.items("a", "b", "c"));
  assert.deepEqual(r.store.keys().sort(), ["a", "c"]);
  assert.ok(r.events.includes("ahead failed"));
  await r.store.sync([], r.items("a", "b", "c"));
  assert.equal(r.calls.filter((c) => c === "/stream/b").length, 2);
});

test("an error page (tiny body) is not kept as a song", async () => {
  const r = rig({ sizes: { "/stream/a": 200 } });
  await r.store.sync([], r.items("a"));
  assert.equal(r.store.has("a"), false);
});

test("the memory limit stops further songs without throwing", async () => {
  const r = rig({ sizes: { "/stream/a": 70 * 1024 * 1024, "/stream/b": 70 * 1024 * 1024 } });
  await r.store.sync([], r.items("a", "b"));
  assert.deepEqual(r.store.keys(), ["a"]);
  assert.ok(r.events.includes("ahead failed"));
});

test("a newer round supersedes an older one, and an unwanted in-flight fetch is cancelled", async () => {
  const r = rig({ hang: new Set(["/stream/a"]) });
  const first = r.store.sync([], r.items("a", "b"));   // hangs on "a"
  await new Promise((res) => setTimeout(res, 5));
  const second = r.store.sync([], r.items("c"));        // "a" is no longer wanted
  await Promise.all([first, second]);
  assert.deepEqual(r.store.keys(), ["c"]);
  assert.equal(r.calls.includes("/stream/b"), false, "the old round must not go on to fetch b");
});

test("a fetch still wanted by the next round is shared, not started twice", async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const calls: string[] = [];
  const store = new AheadStore({
    fetchFn: async (url) => { calls.push(url); await gate; return new Response(big(), { status: 200 }); },
    makeUrl: () => "blob:x",
    revokeUrl: () => {},
  });
  const items = [{ key: "a", url: () => "/stream/a" }];
  const first = store.sync([], items);
  const second = store.sync([], items);
  release();
  await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(store.has("a"), true);
});

test("clear forgets everything and revokes every URL", async () => {
  const r = rig();
  await r.store.sync([], r.items("a", "b"));
  r.store.clear();
  assert.deepEqual(r.store.keys(), []);
  assert.equal(r.revoked.length, 2);
});

test("upcomingSongs: Play Next first, then the order after the current song, wrapping", () => {
  const order = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const q = [{ id: "x" }];
  assert.deepEqual(upcomingSongs(q, order, "c", 4).map((s) => s.id), ["x", "d", "e", "a"]);
  assert.deepEqual(upcomingSongs([], order, "e", 3).map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual(upcomingSongs([], order, "a", 9).map((s) => s.id), ["b", "c", "d", "e"]);
});

test("upcomingSongs never lists the current song or a song twice", () => {
  const order = ["a", "b", "c"].map((id) => ({ id }));
  assert.deepEqual(upcomingSongs([{ id: "b" }, { id: "b" }, { id: "a" }], order, "a", 5).map((s) => s.id), ["b", "c"]);
  assert.deepEqual(upcomingSongs([], [], "a", 3), []);
  assert.deepEqual(upcomingSongs([], order, null, 2).map((s) => s.id), ["a", "b"]);
});
