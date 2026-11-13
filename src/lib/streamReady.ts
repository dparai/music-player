// A transcoded stream can only be seeked, and only reports its length, once
// the server has finished transcoding it into its cache. Until then it answers
// a range request with a plain 200; after, with 206. Measured on Navidrome: the
// cache is complete about 3 s after the first request, even if that request is
// dropped, so one probe is enough to start the work.

const READY_TTL_MS = 5 * 60_000; // the server cache evicts, so "ready" is not forever
const PROBE_TIMEOUT_MS = 4000;
const POLL_MS = 400;

const ready = new Map<string, number>(); // stream key → when it was last seen seekable
const pending = new Map<string, Promise<boolean>>();

export function knownSeekable(key: string): boolean {
  const at = ready.get(key);
  return at !== undefined && Date.now() - at < READY_TTL_MS;
}

async function probe(url: string): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: ac.signal });
    return res.status === 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    ac.abort(); // a 200 would otherwise download the whole stream
  }
}

// Resolves true once the stream can be seeked, false if it is still not ready
// after `timeoutMs`. `makeUrl` is called per probe (stream URLs carry a fresh salt).
export function whenSeekable(key: string, makeUrl: () => string, timeoutMs: number): Promise<boolean> {
  if (knownSeekable(key)) return Promise.resolve(true);
  const running = pending.get(key);
  if (running) return running;
  const deadline = Date.now() + timeoutMs;
  const run = (async () => {
    for (;;) {
      if (await probe(makeUrl())) { ready.set(key, Date.now()); return true; }
      if (Date.now() + POLL_MS >= deadline) return false;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })().finally(() => pending.delete(key));
  pending.set(key, run);
  return run;
}
