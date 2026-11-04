// Library list cache. Run: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { saveSongsCache, loadSongsCache, clearCredentials } from "../src/lib/storage.ts";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const creds = { server: "https://x.example", username: "u", password: "secret" };
const songs = [{ id: "1", title: "A" }, { id: "2", title: "B" }] as any[];

beforeEach(() => store.clear());

test("saved list comes back for the same server and user", () => {
  saveSongsCache(creds, songs);
  assert.deepEqual(loadSongsCache(creds), songs);
});

test("never stores the password", () => {
  saveSongsCache(creds, songs);
  assert.ok(![...store.values()].some((v) => v.includes("secret")));
});

test("another user or server gets nothing", () => {
  saveSongsCache(creds, songs);
  assert.equal(loadSongsCache({ ...creds, username: "other" }), null);
  assert.equal(loadSongsCache({ ...creds, server: "https://y.example" }), null);
});

test("an oversized list is not stored; corrupt data reads as empty", () => {
  saveSongsCache(creds, [{ id: "x", title: "y".repeat(2_100_000) }] as any[]);
  assert.equal(loadSongsCache(creds), null);
  store.set("deepakmusic_songs", "{not json");
  assert.equal(loadSongsCache(creds), null);
});

test("logging out clears the list", () => {
  saveSongsCache(creds, songs);
  clearCredentials();
  assert.equal(loadSongsCache(creds), null);
});
