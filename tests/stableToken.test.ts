// Cover-art URL stability. Run: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import md5 from "md5";
import { stableToken, resetStableToken } from "../src/lib/stableToken.ts";

const store = new Map<string, string>();
let broken = false;
(globalThis as any).localStorage = {
  getItem: (k: string) => { if (broken) throw new Error("blocked"); return store.get(k) ?? null; },
  setItem: (k: string, v: string) => { if (broken) throw new Error("blocked"); store.set(k, v); },
};

beforeEach(() => { store.clear(); broken = false; resetStableToken(); });

test("same password gives the same salt and token every time", () => {
  const a = stableToken("pw");
  const b = stableToken("pw");
  assert.deepEqual(a, b);
  assert.equal(a.token, md5("pw" + a.salt), "still a valid Subsonic token");
});

test("stays the same after a restart (salt comes back from storage)", () => {
  const first = stableToken("pw");
  resetStableToken();           // page reload: memory gone, localStorage kept
  assert.deepEqual(stableToken("pw"), first);
});

test("a different password keeps the salt but changes the token", () => {
  const a = stableToken("pw");
  const b = stableToken("other");
  assert.equal(a.salt, b.salt);
  assert.notEqual(a.token, b.token);
  assert.equal(b.token, md5("other" + b.salt));
});

test("blocked storage still gives stable URLs within the session", () => {
  broken = true;
  const a = stableToken("pw");
  const b = stableToken("pw");
  assert.deepEqual(a, b);
});
